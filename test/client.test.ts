import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createToshiClient } from "../src/client.js";
import type { ToshiClient, ToshiOptions } from "../src/client.js";
import { SecretService } from "../src/gen/toshi/workspace/v1/secrets_pb.js";
import { ArtifactUploadService } from "../src/gen/toshi/workspace/v1/artifacts_pb.js";
import { ChannelService } from "../src/gen/toshi/workspace/v1/channels_pb.js";
import { ConnectionService } from "../src/gen/toshi/workspace/v1/connections_pb.js";
import { RoleService } from "../src/gen/toshi/workspace/v1/roles_pb.js";
import { TokenService } from "../src/gen/toshi/workspace/v1/tokens_pb.js";
import { WorkspaceService } from "../src/gen/toshi/workspace/v1/workspace_service_pb.js";
import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";

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
  it("carries the token and fills the scope on a unary call", async () => {
    let authorization: string | null = null;
    let tenant: string | null = "unset";
    let scope = { project: "", environment: "" };
    const harness = clientWith((router) => {
      router.service(WorkloadService, {
        getJob(req, ctx) {
          authorization = ctx.requestHeader.get("authorization");
          tenant = ctx.requestHeader.get(unauthorizedHeader);
          scope = { project: req.project, environment: req.environment };
          return {};
        },
      });
    }, { token: "tok", project: "proj", environment: "env" });

    await harness.client.workload.jobs.get({ id: "w" });

    expect(authorization).toBe("Bearer tok");
    expect(tenant).toBeNull();
    expect(scope).toEqual({ project: "proj", environment: "env" });
    expect(harness.transportBuilds()).toBe(1);
  });

  it("carries the token and fills the scope on a server stream", async () => {
    let authorization: string | null = null;
    let scope = { project: "", environment: "" };
    const harness = clientWith((router) => {
      router.service(WorkloadService, {
        watchJobs(req, ctx) {
          authorization = ctx.requestHeader.get("authorization");
          scope = { project: req.project, environment: req.environment };
          return streamOf([{ cursor: "c1" }]);
        },
      });
    }, { token: "tok", project: "proj", environment: "env" });

    const watch = await harness.client.workload.jobs.watch({ cursor: "c0" });
    const first = await watch[Symbol.asyncIterator]().next();
    watch.close();

    expect(authorization).toBe("Bearer tok");
    expect(scope).toEqual({ project: "proj", environment: "env" });
    expect(first.done === false && first.value.cursor).toBe("c1");
  });

  it("fills the scope and a request key inside an Execute start", async () => {
    let authorization: string | null = null;
    let start = { project: "", environment: "", requestKey: "" };
    const harness = clientWith((router) => {
      router.service(WorkloadService, {
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

    const process = await harness.client.workload.sandboxes.execute({ sandboxId: "s" });
    await process.wait();

    expect(authorization).toBe("Bearer tok");
    expect(process.executionId).toBe("ex1");
    expect(start.project).toBe("proj");
    expect(start.environment).toBe("env");
    expect(start.requestKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("lets explicit request values win over the configured ones", async () => {
    let scope = { project: "", environment: "" };
    const harness = clientWith((router) => {
      router.service(WorkloadService, {
        getJob(req) {
          scope = { project: req.project, environment: req.environment };
          return {};
        },
      });
    }, { project: "proj", environment: "env" });

    await harness.client.workload.jobs.get({ id: "w", project: "mine", environment: "own" });

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

    await harness.client.secret.createSecretSet({ shared: true });

    expect(scope).toEqual({ project: "proj", environment: "" });
  });

  it("attempts an Unavailable unary read once when retry is false", async () => {
    let attempts = 0;
    const harness = clientWith((router) => {
      router.service(WorkloadService, {
        getJob() {
          attempts += 1;
          throw new ConnectError("down", Code.Unavailable);
        },
      });
    }, { retry: false });

    await expect(harness.client.workload.jobs.get({ id: "w" })).rejects.toMatchObject({
      code: Code.Unavailable,
    });
    expect(attempts).toBe(1);
  });

  it("does not reconnect a watch when retry is false", async () => {
    let attempts = 0;
    const harness = clientWith((router) => {
      router.service(WorkloadService, {
        watchJobs() {
          attempts += 1;
          return failingStream(new ConnectError("down", Code.Unavailable));
        },
      });
    }, { retry: false });

    const watch = await harness.client.workload.jobs.watch({ cursor: "c0" });

    await expect(drain(watch)).rejects.toMatchObject({ code: Code.Unavailable });
    expect(attempts).toBe(1);
  });

  it("gives a keyed call one 32-hex request key when retry is false", async () => {
    const keys: string[] = [];
    const harness = clientWith((router) => {
      router.service(WorkloadService, {
        createJob(req) {
          keys.push(req.requestKey);
          return {};
        },
      });
    }, { retry: false });

    await harness.client.workload.jobs.create({});

    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sends the same request key on every retry of a keyed write", async () => {
    const keys: string[] = [];
    const harness = clientWith((router) => {
      router.service(WorkloadService, {
        createJob(req) {
          keys.push(req.requestKey);
          if (keys.length < 3) {
            throw new ConnectError("down", Code.Unavailable);
          }
          return {};
        },
      });
    }, { retry: { maxAttempts: 3, initialBackoffMs: 5, maxBackoffMs: 20 } });

    await harness.client.workload.jobs.create({});

    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(keys)).toEqual(new Set([keys[0]]));
  });

  it("wins over the token option and is asked for each attempt of a retried call", async () => {
    let asked = 0;
    const sent: string[] = [];
    const harness = clientWith((router) => {
      router.service(WorkloadService, {
        getJob(_req, ctx) {
          sent.push(ctx.requestHeader.get("authorization") ?? "");
          if (sent.length === 1) {
            throw new ConnectError("down", Code.Unavailable);
          }
          return {};
        },
      });
    }, {
      token: "option-token",
      tokenSource: () => {
        asked += 1;
        return Promise.resolve(`token-${asked}`);
      },
      retry: { maxAttempts: 2, initialBackoffMs: 0, maxBackoffMs: 0 },
    });

    await harness.client.workload.jobs.get({ id: "w" });

    expect(asked).toBe(2);
    expect(sent).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("ends the call as Unauthenticated with the source's error, and does not retry it", async () => {
    const sourceError = new Error("vault sealed");
    let asked = 0;
    let reached = 0;
    const harness = clientWith((router) => {
      router.service(WorkloadService, {
        getJob() {
          reached += 1;
          return {};
        },
      });
    }, {
      tokenSource: () => {
        asked += 1;
        throw sourceError;
      },
      retry: { maxAttempts: 3, initialBackoffMs: 0, maxBackoffMs: 0 },
    });

    const err: unknown = await harness.client.workload.jobs.get({ id: "w" }).catch((reason: unknown) => reason);

    expect(err).toBeInstanceOf(ConnectError);
    const connectError = err as ConnectError;
    expect(connectError.code).toBe(Code.Unauthenticated);
    expect(connectError.cause).toBe(sourceError);
    expect(connectError.message).toContain("toshi: token source: vault sealed");
    expect(asked).toBe(1);
    expect(reached).toBe(0);
  });

  it("refuses an empty token from the source", async () => {
    let asked = 0;
    let reached = 0;
    const harness = clientWith((router) => {
      router.service(WorkloadService, {
        getJob() {
          reached += 1;
          return {};
        },
      });
    }, {
      tokenSource: () => {
        asked += 1;
        return "  ";
      },
    });

    const err: unknown = await harness.client.workload.jobs.get({ id: "w" }).catch((reason: unknown) => reason);

    expect(err).toBeInstanceOf(ConnectError);
    const connectError = err as ConnectError;
    expect(connectError.code).toBe(Code.Unauthenticated);
    expect(connectError.message).toContain("toshi: token source: empty token");
    expect(asked).toBe(1);
    expect(reached).toBe(0);
  });

  it("gives every Workspace API service its own client", async () => {
    const harness = clientWith((router) => {
      router.service(ChannelService, { listChannels: () => ({}) });
      router.service(ArtifactUploadService, { completeUpload: () => ({}) });
      router.service(WorkspaceService, { getVersion: () => ({ version: "v0.2.1" }) });
      router.service(TokenService, { listTokens: () => ({}) });
      router.service(ConnectionService, { updateConnection: () => ({}) });
      router.service(RoleService, { listRoles: () => ({}) });
    });
    const fields = [
      "project",
      "secret",
      "webhook",
      "display",
      "channel",
      "recording",
      "volume",
      "artifact",
      "artifactUpload",
      "workspace",
      "hostJob",
      "host",
      "token",
      "auditEvent",
      "filler",
      "storageProvider",
      "product",
      "discovery",
      "connection",
      "role",
    ] as const;
    for (const field of fields) {
      expect(harness.client[field]).toBeDefined();
    }
    expect(harness.client.workload.jobs).toBeDefined();
    expect(harness.client.workload.sandboxes).toBeDefined();
    expect(harness.client.workload.services).toBeDefined();
    // One call through a service the other cases never touch, one through the
    // upload service and one each through the services the client gained with
    // the member services, prove each field holds that service's client.
    await expect(harness.client.channel.listChannels({})).resolves.toBeDefined();
    await expect(harness.client.artifactUpload.completeUpload({})).resolves.toBeDefined();
    await expect(harness.client.workspace.getVersion({})).resolves.toMatchObject({ version: "v0.2.1" });
    await expect(harness.client.token.listTokens({})).resolves.toBeDefined();
    await expect(harness.client.connection.updateConnection({ connection: { id: "con-1" } })).resolves.toBeDefined();
    await expect(harness.client.role.listRoles({})).resolves.toBeDefined();
  });
});
