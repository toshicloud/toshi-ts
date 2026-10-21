import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createToshiClient } from "../src/client.js";
import type { ToshiClient, ToshiOptions } from "../src/client.js";
import { SecretService } from "../src/gen/toshi/workspace/v1/secrets_pb.js";
import { ExecuteRequestSchema, WorkspaceService } from "../src/gen/toshi/workspace/v1/workspace_pb.js";

const unauthorizedHeader = "toshi-tenant";

interface Harness {
  readonly client: ToshiClient;
  readonly transportBuilds: () => number;
}

// Hand-built iterables: the in-memory router takes AsyncIterable, and an async
// generator would only add lint noise here.
function streamOf<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<T>> {
          const item = index < items.length ? items[index] : undefined;
          index += 1;
          return Promise.resolve(item === undefined ? { done: true, value: undefined } : { done: false, value: item });
        },
      };
    },
  };
}

function failingStream(err: Error): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<never> {
      return {
        next: () => Promise.reject(err),
      };
    },
  };
}

// Builds a client whose transport is connect's in-memory router, with the
// client's interceptors installed the way createConnectTransport does.
function clientWith(routes: (router: ConnectRouter) => void, options: Omit<ToshiOptions, "transport"> = {}): Harness {
  let builds = 0;
  const client = createToshiClient({
    ...options,
    transport: (interceptors: Interceptor[]) => {
      builds += 1;
      return createRouterTransport(routes, { transport: { interceptors } });
    },
  });
  return { client, transportBuilds: () => builds };
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const message of iterable) {
    void message;
  }
}

describe("createToshiClient", () => {
  it("carries the token and fills the scope on a raw generated unary call", async () => {
    let authorization: string | null = null;
    let tenant: string | null = "unset";
    let scope = { project: "", environment: "" };
    const harness = clientWith((router) => {
      router.service(WorkspaceService, {
        getWorkload(req, ctx) {
          authorization = ctx.requestHeader.get("authorization");
          tenant = ctx.requestHeader.get(unauthorizedHeader);
          scope = { project: req.project, environment: req.environment };
          return {};
        },
      });
    }, { token: "tok", project: "proj", environment: "env" });

    await harness.client.workspace.getWorkload({ id: "w" });

    expect(authorization).toBe("Bearer tok");
    expect(tenant).toBeNull();
    expect(scope).toEqual({ project: "proj", environment: "env" });
    expect(harness.transportBuilds()).toBe(1);
  });

  it("carries the token and fills the scope on a raw generated server stream", async () => {
    let authorization: string | null = null;
    let scope = { project: "", environment: "" };
    const harness = clientWith((router) => {
      router.service(WorkspaceService, {
        watchWorkloads(req, ctx) {
          authorization = ctx.requestHeader.get("authorization");
          scope = { project: req.project, environment: req.environment };
          return streamOf([{ cursor: "c1" }]);
        },
      });
    }, { token: "tok", project: "proj", environment: "env" });

    const cursors: string[] = [];
    for await (const message of harness.client.workspace.watchWorkloads({ cursor: "c0" })) {
      cursors.push(message.cursor);
    }

    expect(authorization).toBe("Bearer tok");
    expect(scope).toEqual({ project: "proj", environment: "env" });
    expect(cursors).toEqual(["c1"]);
  });

  it("fills the scope and a request key inside an Execute start", async () => {
    let authorization: string | null = null;
    let start = { project: "", environment: "", requestKey: "" };
    const harness = clientWith((router) => {
      router.service(WorkspaceService, {
        async *execute(requests, ctx) {
          authorization = ctx.requestHeader.get("authorization");
          for await (const req of requests) {
            if (req.message.case === "start") {
              start = req.message.value;
              yield { message: { case: "started", value: { executionId: "ex1" } } };
              yield { message: { case: "exit", value: { exitCode: 0 } } };
            }
          }
        },
      });
    }, { token: "tok", project: "proj", environment: "env" });

    const starts: MessageInitShape<typeof ExecuteRequestSchema>[] = [
      { message: { case: "start", value: { workloadId: "w" } } },
    ];
    const responses: string[] = [];
    for await (const response of harness.client.workspace.execute(streamOf(starts))) {
      responses.push(response.message.case ?? "unset");
    }

    expect(authorization).toBe("Bearer tok");
    expect(responses).toEqual(["started", "exit"]);
    expect(start.project).toBe("proj");
    expect(start.environment).toBe("env");
    expect(start.requestKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("lets explicit request values win over the configured ones", async () => {
    let scope = { project: "", environment: "" };
    const harness = clientWith((router) => {
      router.service(WorkspaceService, {
        getWorkload(req) {
          scope = { project: req.project, environment: req.environment };
          return {};
        },
      });
    }, { project: "proj", environment: "env" });

    await harness.client.workspace.getWorkload({ id: "w", project: "mine", environment: "own" });

    expect(scope).toEqual({ project: "mine", environment: "own" });
  });

  it("does not fill environment when the message has shared set", async () => {
    let scope = { project: "", environment: "" };
    const harness = clientWith((router) => {
      router.service(SecretService, {
        createSecretSet(req) {
          scope = { project: req.project, environment: req.environment };
          return {};
        },
      });
    }, { project: "proj", environment: "env" });

    await harness.client.secrets.createSecretSet({ shared: true });

    expect(scope).toEqual({ project: "proj", environment: "" });
  });

  it("attempts an Unavailable unary read once when retry is false", async () => {
    let attempts = 0;
    const harness = clientWith((router) => {
      router.service(WorkspaceService, {
        getWorkload() {
          attempts += 1;
          throw new ConnectError("down", Code.Unavailable);
        },
      });
    }, { retry: false });

    await expect(harness.client.workspace.getWorkload({ id: "w" })).rejects.toMatchObject({
      code: Code.Unavailable,
    });
    expect(attempts).toBe(1);
  });

  it("does not reconnect a watch when retry is false", async () => {
    let attempts = 0;
    const harness = clientWith((router) => {
      router.service(WorkspaceService, {
        watchWorkloads() {
          attempts += 1;
          return failingStream(new ConnectError("down", Code.Unavailable));
        },
      });
    }, { retry: false });

    const watch = await harness.client.watchWorkloads({ cursor: "c0" });

    await expect(drain(watch)).rejects.toMatchObject({ code: Code.Unavailable });
    expect(attempts).toBe(1);
  });

  it("gives a keyed call one 32-hex request key when retry is false", async () => {
    const keys: string[] = [];
    const harness = clientWith((router) => {
      router.service(WorkspaceService, {
        createWorkload(req) {
          keys.push(req.requestKey);
          return {};
        },
      });
    }, { retry: false });

    await harness.client.workspace.createWorkload({});

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sends the same request key on every retry of a keyed write", async () => {
    const keys: string[] = [];
    const harness = clientWith((router) => {
      router.service(WorkspaceService, {
        createWorkload(req) {
          keys.push(req.requestKey);
          if (keys.length < 3) {
            throw new ConnectError("down", Code.Unavailable);
          }
          return {};
        },
      });
    }, { retry: { maxAttempts: 3, initialBackoffMs: 5, maxBackoffMs: 20 } });

    await harness.client.workspace.createWorkload({});

    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(keys)).toEqual(new Set([keys[0]]));
  });
});
