import type { DescService } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import type { Interceptor, ServiceImpl, Transport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { DisplayService } from "../src/gen/toshi/workspace/v1/display_pb.js";
import { ProjectService } from "../src/gen/toshi/workspace/v1/projects_pb.js";
import { SecretService } from "../src/gen/toshi/workspace/v1/secrets_pb.js";
import { WebhookService } from "../src/gen/toshi/workspace/v1/webhook_pb.js";
import { WorkspaceService } from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { retryInterceptor } from "../src/interceptors.js";
import { backoffDelay, isTransportLoss, procedurePath, retryClassFor } from "../src/retry.js";
import type { RetryPolicy } from "../src/retry.js";

const fastPolicy: RetryPolicy = { maxAttempts: 3, initialBackoffMs: 5, maxBackoffMs: 20 };

const services: readonly DescService[] = [
  WorkspaceService,
  ProjectService,
  SecretService,
  WebhookService,
  DisplayService,
];

function transportFor<T extends DescService>(
  service: T,
  impl: Partial<ServiceImpl<T>>,
  interceptor: Interceptor,
): Transport {
  return createRouterTransport(
    (router) => {
      router.service(service, impl);
    },
    { transport: { interceptors: [interceptor] } },
  );
}

describe("the retry table", () => {
  it("names every method of the five services, 22 reads, 9 keyed and 34 none", () => {
    const counts = { read: 0, keyed: 0, none: 0 };
    const paths = new Set<string>();
    for (const service of services) {
      for (const method of service.methods) {
        const path = procedurePath(service, method);
        expect(paths.has(path), `${path} is listed twice`).toBe(false);
        paths.add(path);
        counts[retryClassFor(path)] += 1;
      }
    }
    expect(paths.size).toBe(65);
    expect(counts).toEqual({ read: 22, keyed: 9, none: 34 });
  });
});

describe("isTransportLoss", () => {
  it("does not treat a write after the server answered as a loss", () => {
    const writeAfterEnd = Object.assign(new Error("w"), { code: "ERR_STREAM_WRITE_AFTER_END" });
    expect(isTransportLoss(new ConnectError("x", Code.Aborted, undefined, undefined, writeAfterEnd))).toBe(
      false,
    );
  });
});

describe("retryInterceptor", () => {
  it("retries Unavailable for a read up to maxAttempts", async () => {
    let attempts = 0;
    const transport = transportFor(
      WorkspaceService,
      {
        getWorkload() {
          attempts += 1;
          throw new ConnectError("down", Code.Unavailable);
        },
      },
      retryInterceptor(fastPolicy),
    );
    const workspace = createClient(WorkspaceService, transport);
    await expect(workspace.getWorkload({ id: "w" })).rejects.toMatchObject({
      code: Code.Unavailable,
    });
    expect(attempts).toBe(3);
  });

  it("retries Unavailable for a keyed write up to maxAttempts", async () => {
    let attempts = 0;
    const transport = transportFor(
      WorkspaceService,
      {
        createWorkload() {
          attempts += 1;
          throw new ConnectError("down", Code.Unavailable);
        },
      },
      retryInterceptor(fastPolicy),
    );
    const workspace = createClient(WorkspaceService, transport);
    await expect(workspace.createWorkload({})).rejects.toMatchObject({ code: Code.Unavailable });
    expect(attempts).toBe(3);
  });

  it("does not retry a none-class write", async () => {
    let attempts = 0;
    const transport = transportFor(
      SecretService,
      {
        setSecret() {
          attempts += 1;
          throw new ConnectError("down", Code.Unavailable);
        },
      },
      retryInterceptor(fastPolicy),
    );
    const secrets = createClient(SecretService, transport);
    await expect(secrets.setSecret({})).rejects.toMatchObject({ code: Code.Unavailable });
    expect(attempts).toBe(1);
  });

  it("does not retry a server-sent Aborted", async () => {
    let attempts = 0;
    const transport = transportFor(
      WorkspaceService,
      {
        getWorkload() {
          attempts += 1;
          throw new ConnectError("cancelled by the server", Code.Aborted);
        },
      },
      retryInterceptor(fastPolicy),
    );
    const workspace = createClient(WorkspaceService, transport);
    await expect(workspace.getWorkload({ id: "w" })).rejects.toMatchObject({
      code: Code.Aborted,
    });
    expect(attempts).toBe(1);
  });

  it("does not retry InvalidArgument or ResourceExhausted", async () => {
    for (const code of [Code.InvalidArgument, Code.ResourceExhausted]) {
      let attempts = 0;
      const transport = transportFor(
        WorkspaceService,
        {
          getWorkload() {
            attempts += 1;
            throw new ConnectError("refused", code);
          },
        },
        retryInterceptor(fastPolicy),
      );
      const workspace = createClient(WorkspaceService, transport);
      await expect(workspace.getWorkload({ id: "w" })).rejects.toMatchObject({ code });
      expect(attempts).toBe(1);
    }
  });

  it("rejects at once when the signal aborts during the backoff sleep", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const policy: RetryPolicy = { maxAttempts: 3, initialBackoffMs: 60_000, maxBackoffMs: 60_000 };
    const transport = transportFor(
      WorkspaceService,
      {
        getWorkload() {
          attempts += 1;
          // Abort as the interceptor turns to a sleep of up to a minute.
          controller.abort();
          throw new ConnectError("down", Code.Unavailable);
        },
      },
      retryInterceptor(policy),
    );
    const workspace = createClient(WorkspaceService, transport);
    const started = Date.now();
    await expect(
      workspace.getWorkload({ id: "w" }, { signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(attempts).toBe(1);
  });

  it("never backs off past maxBackoffMs", () => {
    const policy: RetryPolicy = { maxAttempts: 3, initialBackoffMs: 5, maxBackoffMs: 20 };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const limit = Math.min(policy.maxBackoffMs, policy.initialBackoffMs * 2 ** attempt);
      for (let round = 0; round < 100; round += 1) {
        const delay = backoffDelay(policy, attempt);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(limit);
      }
    }
  });
});
