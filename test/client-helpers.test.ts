import { create } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import type { ConnectRouter, Interceptor, ServiceImpl } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createToshiClient } from "../src/client.js";
import type { ToshiClient } from "../src/client.js";
import {
  EventSchema,
  ExecuteResponseSchema,
  ListWorkloadsResponseSchema,
  OperationSchema,
  WaitOperationResponseSchema,
  WaitWorkloadResponseSchema,
  WatchEventsResponseSchema,
  WatchOutputResponseSchema,
  WatchWorkloadsResponseSchema,
  WorkloadSchema,
  WorkspaceService,
  type ExecuteRequest,
} from "../src/gen/toshi/workspace/v1/workspace_pb.js";

// Every helper is reached through the public client here, so the client's own
// wiring (token, scope, key, policy) is what the fake sees.

// A finite stream without async generators, which require an await to lint.
function streamOf<T>(...items: readonly T[]): AsyncIterable<T> {
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

function clientWith(routes: (router: ConnectRouter) => void): ToshiClient {
  return createToshiClient({
    token: "token-1",
    project: "default",
    environment: "production",
    retry: { maxAttempts: 2, initialBackoffMs: 0, maxBackoffMs: 0 },
    transport: (interceptors: Interceptor[]) => createRouterTransport(routes, { transport: { interceptors } }),
  });
}

function workspace(routes: Partial<ServiceImpl<typeof WorkspaceService>>): ToshiClient {
  return clientWith((router) => {
    router.service(WorkspaceService, routes);
  });
}

describe("ToshiClient helpers", () => {
  it("waits for a workload through the client until it is reached", async () => {
    let calls = 0;
    const client = workspace({
      waitWorkload: () => {
        calls += 1;
        return create(WaitWorkloadResponseSchema, { reached: calls >= 2 });
      },
    });
    const response = await client.waitWorkload({});
    expect(response.reached).toBe(true);
    expect(calls).toBe(2);
  });

  it("waits for an operation through the client until it is done", async () => {
    let calls = 0;
    const client = workspace({
      waitOperation: () => {
        calls += 1;
        return create(WaitOperationResponseSchema, {
          operation: create(OperationSchema, { id: "op-1", done: calls >= 2 }),
        });
      },
    });
    const operation = await client.waitOperation({ id: "op-1" });
    expect(operation.done).toBe(true);
    expect(calls).toBe(2);
  });

  it("lists before watching workloads through the client", async () => {
    let watchCursor: string | undefined;
    let keepalive: boolean | undefined;
    const client = workspace({
      listWorkloads: () =>
        create(ListWorkloadsResponseSchema, {
          workloads: [create(WorkloadSchema, { id: "wl-1" })],
          cursor: "list-cursor",
        }),
      watchWorkloads: (req) => {
        watchCursor = req.cursor;
        keepalive = req.keepalive;
        return streamOf(
          create(WatchWorkloadsResponseSchema, {
            workload: create(WorkloadSchema, { id: "wl-1" }),
            cursor: "c1",
          }),
        );
      },
    });
    const watch = await client.watchWorkloads({});
    // The promise resolves only after the pre-list, so the snapshot is complete.
    expect(watch.snapshot?.map((item) => item.id)).toEqual(["wl-1"]);
    expect(watch.cursor).toBe("list-cursor");
    const iterator = watch[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(watch.cursor).toBe("c1");
    expect(watchCursor).toBe("list-cursor");
    expect(keepalive).toBe(true);
    await iterator.return?.();
  });

  it("watches events from a cursor through the client", async () => {
    let watchCursor: string | undefined;
    const client = workspace({
      watchEvents: (req) => {
        watchCursor = req.cursor;
        return streamOf(
          create(WatchEventsResponseSchema, {
            event: create(EventSchema, { cursor: "e1" }),
          }),
        );
      },
    });
    const watch = await client.watchEvents({ cursor: "start" });
    const iterator = watch[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(watch.cursor).toBe("e1");
    expect(watchCursor).toBe("start");
    await iterator.return?.();
  });

  it("watches output from the request's offsets through the client", async () => {
    const client = workspace({
      watchOutput: () =>
        streamOf(
          create(WatchOutputResponseSchema, {
            message: { case: "stdout", value: new TextEncoder().encode("hi") },
          }),
          create(WatchOutputResponseSchema, { message: { case: "end", value: {} } }),
        ),
    });
    const watch = await client.watchOutput({ stdoutOffset: 5n, stderrOffset: 0n });
    const chunks: string[] = [];
    for await (const chunk of watch) {
      if (chunk.message.case === "stdout") {
        chunks.push(new TextDecoder().decode(chunk.message.value));
      }
    }
    expect(chunks).toEqual(["hi"]);
    expect(watch.offsets.stdout).toBe(7n);
    expect(watch.offsets.stderr).toBe(0n);
  });

  it("fills the Execute start's scope and request key through the client", async () => {
    let seen: { project?: string; environment?: string; requestKey?: string } = {};
    const client = workspace({
      execute: (requests: AsyncIterable<ExecuteRequest>) => ({
        async *[Symbol.asyncIterator]() {
          for await (const request of requests) {
            if (request.message.case !== "start") {
              continue;
            }
            seen = request.message.value;
            yield create(ExecuteResponseSchema, {
              message: { case: "started", value: { executionId: "ex-1" } },
            });
            yield create(ExecuteResponseSchema, { message: { case: "exit", value: { exitCode: 0 } } });
            return;
          }
        },
      }),
    });
    const process = await client.execute({ workloadId: "wl-1" });
    await process.wait();
    expect(process.requestKey).toMatch(/^[0-9a-f]{32}$/);
    expect(seen.requestKey).toBe(process.requestKey);
    expect(seen.project).toBe("default");
    expect(seen.environment).toBe("production");
  });
});
