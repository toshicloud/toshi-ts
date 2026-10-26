import { create } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import type { ConnectRouter, Interceptor, ServiceImpl } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createToshiClient } from "../src/client.js";
import type { ToshiClient } from "../src/client.js";
import { JobExitError } from "../src/errors.js";
import {
  ListJobsResponseSchema,
  WaitJobResponseSchema,
  WatchJobsResponseSchema,
  WorkloadService,
} from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import {
  EventSchema,
  ExecuteResponseSchema,
  GetOperationResponseSchema,
  JobSchema,
  ListEventsResponseSchema,
  type ExecuteRequest,
  type GetOperationRequest,
  type ListEventsRequest,
  OperationSchema,
  WaitOperationResponseSchema,
  WatchEventsResponseSchema,
  WatchOutputResponseSchema,
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

function workload(routes: Partial<ServiceImpl<typeof WorkloadService>>): ToshiClient {
  return clientWith((router) => {
    router.service(WorkloadService, routes);
  });
}

describe("ToshiClient helpers", () => {
  it("waits for a job through the client until it is reached", async () => {
    let calls = 0;
    const client = workload({
      waitJob: () => {
        calls += 1;
        return create(WaitJobResponseSchema, { reached: calls >= 2 });
      },
    });
    const response = await client.workload.jobs.wait({});
    expect(response.reached).toBe(true);
    expect(calls).toBe(2);
  });

  it("waits for an operation through the client until it is done", async () => {
    let calls = 0;
    const client = workload({
      waitOperation: () => {
        calls += 1;
        return create(WaitOperationResponseSchema, {
          operation: create(OperationSchema, { id: "op-1", done: calls >= 2 }),
        });
      },
    });
    const operation = await client.workload.waitOperation({ id: "op-1" });
    expect(operation.done).toBe(true);
    expect(calls).toBe(2);
  });

  it("gets an operation through the client and answers with its response", async () => {
    let seen: GetOperationRequest | undefined;
    const client = workload({
      getOperation: (req) => {
        seen = req;
        return create(GetOperationResponseSchema, {
          operation: create(OperationSchema, { id: "op-1", workloadId: "wl-1", done: true }),
        });
      },
    });
    const response = await client.workload.getOperation({ id: "op-1" });
    expect(seen?.id).toBe("op-1");
    expect(seen?.project).toBe("default");
    expect(response.operation?.id).toBe("op-1");
    expect(response.operation?.workloadId).toBe("wl-1");
    expect(response.operation?.done).toBe(true);
  });

  it("lists before watching jobs through the client", async () => {
    let watchCursor: string | undefined;
    let keepalive: boolean | undefined;
    const client = workload({
      listJobs: () =>
        create(ListJobsResponseSchema, {
          jobs: [create(JobSchema, { id: "wl-1" })],
          cursor: "list-cursor",
        }),
      watchJobs: (req) => {
        watchCursor = req.cursor;
        keepalive = req.keepalive;
        return streamOf(
          create(WatchJobsResponseSchema, {
            job: create(JobSchema, { id: "wl-1" }),
            cursor: "c1",
          }),
        );
      },
    });
    const watch = await client.workload.jobs.watch({});
    // The promise resolves only after the pre-list, so the snapshot is complete.
    expect(watch.snapshot?.map((job) => job.id)).toEqual(["wl-1"]);
    expect(watch.cursor).toBe("list-cursor");
    const iterator = watch[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(watch.cursor).toBe("c1");
    expect(watchCursor).toBe("list-cursor");
    expect(keepalive).toBe(true);
    await iterator.return?.();
  });

  it("lists events through the client and answers with its response", async () => {
    let seen: ListEventsRequest | undefined;
    const client = workload({
      listEvents: (req) => {
        seen = req;
        return create(ListEventsResponseSchema, {
          events: [create(EventSchema, { id: "ev-1", cursor: "e1" })],
          cursor: "e1",
          nextPageToken: "p2",
        });
      },
    });
    const response = await client.workload.listEvents({ pageToken: "p1", pageSize: 7, workloadId: "wl-1" });
    expect(seen?.workloadId).toBe("wl-1");
    expect(seen?.pageToken).toBe("p1");
    expect(seen?.pageSize).toBe(7);
    expect(seen?.project).toBe("default");
    expect(seen?.environment).toBe("production");
    expect(response.events.map((event) => event.id)).toEqual(["ev-1"]);
    expect(response.cursor).toBe("e1");
    expect(response.nextPageToken).toBe("p2");
  });

  it("watches events from a cursor through the client and yields the response", async () => {
    let watchCursor: string | undefined;
    const client = workload({
      watchEvents: (req) => {
        watchCursor = req.cursor;
        return streamOf(
          create(WatchEventsResponseSchema, {
            event: create(EventSchema, { id: "ev-1", cursor: "e1" }),
          }),
        );
      },
    });
    const watch = await client.workload.watchEvents({ cursor: "start" });
    const iterator = watch[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.done === false && first.value.event?.id).toBe("ev-1");
    expect(watch.cursor).toBe("e1");
    expect(watchCursor).toBe("start");
    await iterator.return?.();
  });

  it("watches output from the request's offsets through the client", async () => {
    const client = workload({
      watchOutput: () =>
        streamOf(
          create(WatchOutputResponseSchema, {
            message: { case: "stdout", value: new TextEncoder().encode("hi") },
          }),
          create(WatchOutputResponseSchema, { message: { case: "end", value: {} } }),
        ),
    });
    const watch = await client.workload.jobs.watchOutput({ stdoutOffset: 5n, stderrOffset: 0n });
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
    const client = workload({
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
    const process = await client.workload.sandboxes.execute({ sandboxId: "s-1" });
    await process.wait();
    expect(process.requestKey).toMatch(/^[0-9a-f]{32}$/);
    expect(seen.requestKey).toBe(process.requestKey);
    expect(seen.project).toBe("default");
    expect(seen.environment).toBe("production");
  });

  it("runs a job: creates it, then streams its output to its end", async () => {
    const client = workload({
      createJob: () => ({ job: create(JobSchema, { id: "job-1" }) }),
      watchOutput: () =>
        streamOf(
          create(WatchOutputResponseSchema, {
            message: { case: "stdout", value: new TextEncoder().encode("hi") },
          }),
          create(WatchOutputResponseSchema, { message: { case: "end", value: { exitCode: 0 } } }),
        ),
    });
    const run = await client.run({ spec: { command: { argv: ["echo", "hi"] } } });
    expect(run.job.id).toBe("job-1");
    const chunks: string[] = [];
    for await (const chunk of run) {
      chunks.push(new TextDecoder().decode(chunk.data));
    }
    await run.wait();
    expect(chunks).toEqual(["hi"]);
  });

  it("ends a run's wait with a JobExitError when the job did not exit 0", async () => {
    const client = workload({
      createJob: () => ({ job: create(JobSchema, { id: "job-2" }) }),
      watchOutput: () =>
        streamOf(
          create(WatchOutputResponseSchema, {
            message: { case: "stderr", value: new TextEncoder().encode("bad") },
          }),
          create(WatchOutputResponseSchema, { message: { case: "end", value: { exitCode: 3 } } }),
        ),
    });
    const run = await client.run({ spec: { command: { argv: ["false"] } } });
    await expect(run.wait()).rejects.toBeInstanceOf(JobExitError);
    await expect(run.wait()).rejects.toMatchObject({ jobId: "job-2", end: { exitCode: 3 } });
  });
});
