import { getEventListeners } from "node:events";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import type { ServiceImpl } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import {
  WatchJobsRequestSchema,
  WorkloadService,
} from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { WatchEventsRequestSchema } from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { openEventWatch, openJobWatch } from "../src/watch.js";

// Short backoffs keep the reconnect cases fast; the policy shape is what matters here.
const fastRetry = { maxAttempts: 3, initialBackoffMs: 0, maxBackoffMs: 0 };

function workloadWith(impl: Partial<ServiceImpl<typeof WorkloadService>>) {
  const transport = createRouterTransport((router) => {
    router.service(WorkloadService, impl);
  });
  return createClient(WorkloadService, transport);
}

// A promise that never settles: the fake server keeps its stream open.
function never<T = void>(): Promise<T> {
  return new Promise<T>(() => {
    // deliberately never settles
  });
}

// A stream the fake server holds open without sending anything else.
function openStream<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => never<IteratorResult<T>>(),
      };
    },
  };
}

// A stream that fails on its first read, as the server refusing the request does.
function failedStream<T>(error: Error): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(error),
      };
    },
  };
}

// A finite stream: it sends these messages and then ends cleanly.
function streamOf<T>(...messages: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next(): Promise<IteratorResult<T>> {
          if (index >= messages.length) {
            return Promise.resolve({ done: true, value: undefined });
          }
          const message = messages[index];
          index += 1;
          return Promise.resolve({ done: false, value: message });
        },
      };
    },
  };
}

// IteratorResult's return value is `any`, so narrow before reading value.
function value<T>(result: IteratorResult<T>): T | undefined {
  return result.done === true ? undefined : result.value;
}

async function until(check: () => boolean, ms = 1_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) {
      throw new Error("condition not met in time");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

async function withDeadline(promise: Promise<void>, ms = 1_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("timed out"));
    }, ms);
  });
  try {
    await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

describe("workload watch", () => {
  it("opens no RPC before the first next()", async () => {
    let calls = 0;
    const workload = workloadWith({
      listJobs() {
        return { jobs: [], cursor: "c0" };
      },
      watchJobs() {
        calls += 1;
        return (async function* () {
          yield { cursor: "c1", job: { id: "w1" } };
          await never();
        })();
      },
    });

    const watch = await openJobWatch(workload, fastRetry, create(WatchJobsRequestSchema, {}));
    expect(calls).toBe(0);

    const reader = watch[Symbol.asyncIterator]();
    expect(calls).toBe(0);

    const first = await reader.next();
    expect(calls).toBe(1);
    expect(value(first)?.job?.id).toBe("w1");
    watch.close();
  });

  it("starts nothing when it is closed before the first next()", async () => {
    let calls = 0;
    const workload = workloadWith({
      listJobs() {
        return { jobs: [], cursor: "c0" };
      },
      watchJobs() {
        calls += 1;
        return openStream();
      },
    });

    const watch = await openJobWatch(workload, fastRetry, create(WatchJobsRequestSchema, {}));
    watch.close();

    const seen = [];
    for await (const msg of watch) {
      seen.push(msg);
    }
    expect(seen).toEqual([]);
    expect(calls).toBe(0);
  });

  it("throws the documented error on a second iterator", async () => {
    const workload = workloadWith({
      listJobs() {
        return { jobs: [], cursor: "c0" };
      },
    });
    const watch = await openJobWatch(workload, fastRetry, create(WatchJobsRequestSchema, {}));

    watch[Symbol.asyncIterator]();
    expect(() => watch[Symbol.asyncIterator]()).toThrow(new Error("toshi: this watch already has a reader"));
    watch.close();
  });

  it("releases the server stream when returned while next() is blocked", async () => {
    let resolveAborted: (() => void) | undefined;
    const serverAborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const workload = workloadWith({
      listJobs() {
        return { jobs: [], cursor: "c0" };
      },
      watchJobs(_req, ctx) {
        ctx.signal.addEventListener(
          "abort",
          () => {
            resolveAborted?.();
          },
          { once: true },
        );
        return (async function* () {
          yield { cursor: "c1", job: { id: "w1" } };
          await never();
        })();
      },
    });

    const watch = await openJobWatch(workload, fastRetry, create(WatchJobsRequestSchema, {}));
    const reader = watch[Symbol.asyncIterator]();
    const first = await reader.next();
    expect(value(first)?.cursor).toBe("c1");

    const blocked = reader.next();
    await reader.return?.(undefined);
    await expect(blocked).resolves.toEqual({ done: true, value: undefined });
    await withDeadline(serverAborted);
  });

  it("lists every page before it resolves, then streams from the list's cursor", async () => {
    const pageTokens: string[] = [];
    let streamCursor: string | undefined;
    let streamKeepalive: boolean | undefined;
    const workload = workloadWith({
      listJobs(req) {
        pageTokens.push(req.pageToken);
        if (req.pageToken === "") {
          return { jobs: [{ id: "w1" }], nextPageToken: "p2", cursor: "c1" };
        }
        return { jobs: [{ id: "w2" }], nextPageToken: "", cursor: "c2" };
      },
      watchJobs(req) {
        streamCursor = req.cursor;
        streamKeepalive = req.keepalive;
        return openStream();
      },
    });

    const watch = await openJobWatch(workload, fastRetry, create(WatchJobsRequestSchema, {}));
    expect(pageTokens).toEqual(["", "p2"]);
    expect(watch.snapshot?.map((job) => job.id)).toEqual(["w1", "w2"]);
    expect(watch.cursor).toBe("c2");

    const pending = watch[Symbol.asyncIterator]().next();
    await until(() => streamCursor !== undefined);
    expect(streamCursor).toBe("c2");
    expect(streamKeepalive).toBe(true);
    watch.close();
    await pending;
  });

  it("has no snapshot when the request names a cursor", async () => {
    let lists = 0;
    const workload = workloadWith({
      listJobs() {
        lists += 1;
        return { jobs: [], cursor: "c9" };
      },
      watchJobs() {
        return openStream();
      },
    });

    const watch = await openJobWatch(
      workload,
      fastRetry,
      create(WatchJobsRequestSchema, { cursor: "c9" }),
    );
    expect(watch.snapshot).toBeUndefined();
    expect(watch.cursor).toBe("c9");
    expect(lists).toBe(0);
    watch.close();
  });

  it("consumes keepalives, moves the cursor and does not yield them", async () => {
    const workload = workloadWith({
      listJobs() {
        return { jobs: [], cursor: "c0" };
      },
      watchJobs() {
        return (async function* () {
          yield { keepalive: { cursor: "k1" } };
          await never();
        })();
      },
    });

    const watch = await openJobWatch(workload, fastRetry, create(WatchJobsRequestSchema, {}));
    const reader = watch[Symbol.asyncIterator]();
    const pending = reader.next();

    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await until(() => watch.cursor === "k1");
    expect(settled).toBe(false);

    watch.close();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    expect(watch.cursor).toBe("k1");
  });

  it("resets the reconnect count on every message and outlives maxAttempts - 1 losses", async () => {
    let calls = 0;
    const workload = workloadWith({
      listJobs() {
        return { jobs: [], cursor: "c0" };
      },
      watchJobs() {
        calls += 1;
        const call = calls;
        return streamOf(
          ...(call === 2 || call === 4 ? [{ cursor: `c${call}`, job: { id: `w${call}` } }] : []),
        );
      },
    });

    const watch = await openJobWatch(workload, fastRetry, create(WatchJobsRequestSchema, {}));
    const reader = watch[Symbol.asyncIterator]();
    const first = await reader.next();
    const second = await reader.next();
    expect([value(first)?.job?.id, value(second)?.job?.id]).toEqual(["w2", "w4"]);
    // Three losses in a row end the watch; here they are never more than two.
    expect(calls).toBe(4);
    watch.close();
  });

  it("reconnects after a stream that ends without its end-stream response", async () => {
    let calls = 0;
    const workload = workloadWith({
      listJobs() {
        return { jobs: [], cursor: "c0" };
      },
      watchJobs() {
        calls += 1;
        const call = calls;
        if (call === 1) {
          return failedStream(
            new ConnectError("protocol error: missing EndStreamResponse", Code.InvalidArgument),
          );
        }
        return (async function* () {
          yield { cursor: "c1", job: { id: "w1" } };
          await never();
        })();
      },
    });

    const watch = await openJobWatch(workload, fastRetry, create(WatchJobsRequestSchema, {}));
    const first = await watch[Symbol.asyncIterator]().next();
    expect(value(first)?.job?.id).toBe("w1");
    expect(calls).toBe(2);
    watch.close();
  });
});

describe("event watch", () => {
  it("stops mid-page and a new watch from the exposed cursor yields the rest", async () => {
    const listCursors: string[] = [];
    let streamCursor: string | undefined;
    const workload = workloadWith({
      listEvents(req) {
        listCursors.push(req.pageToken);
        return {
          events: [
            { id: "e1", cursor: "c1" },
            { id: "e2", cursor: "c2" },
            { id: "e3", cursor: "c3" },
          ],
          cursor: "c3",
        };
      },
      watchEvents(req) {
        streamCursor = req.cursor;
        return (async function* () {
          if (req.cursor === "c1") {
            yield { event: { id: "e2", cursor: "c2" } };
            yield { event: { id: "e3", cursor: "c3" } };
          }
          await never();
        })();
      },
    });

    const first = await openEventWatch(workload, fastRetry, create(WatchEventsRequestSchema, {}));
    for await (const message of first) {
      expect(message.event?.id).toBe("e1");
      expect(first.cursor).toBe("c1");
      break;
    }

    const resumed = await openEventWatch(
      workload,
      fastRetry,
      create(WatchEventsRequestSchema, { cursor: first.cursor }),
    );
    const rest = resumed[Symbol.asyncIterator]();
    const ids = [value(await rest.next())?.event?.id, value(await rest.next())?.event?.id];
    expect(ids).toEqual(["e2", "e3"]);
    expect(streamCursor).toBe("c1");
    expect(listCursors).toEqual([""]);
    resumed.close();
  });

  it("moves the cursor on a keepalive without yielding it", async () => {
    const workload = workloadWith({
      watchEvents() {
        return (async function* () {
          yield { keepalive: { cursor: "k1" } };
          await never();
        })();
      },
    });

    const watch = await openEventWatch(
      workload,
      fastRetry,
      create(WatchEventsRequestSchema, { cursor: "c0" }),
    );
    const pending = watch[Symbol.asyncIterator]().next();
    await until(() => watch.cursor === "k1");
    watch.close();
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it("releases the caller's abort listener when a watch ends with an error", async () => {
    const refused = new ConnectError("the cursor is too old", Code.OutOfRange);
    const workload = workloadWith({
      watchJobs() {
        return (async function* () {
          await Promise.resolve();
          yield* [];
          throw refused;
        })();
      },
      watchEvents() {
        return (async function* () {
          await Promise.resolve();
          yield* [];
          throw refused;
        })();
      },
    });
    const controller = new AbortController();
    const opts = { signal: controller.signal };
    const jobs = await openJobWatch(
      workload,
      fastRetry,
      create(WatchJobsRequestSchema, { cursor: "c0" }),
      opts,
    );
    const events = await openEventWatch(workload, fastRetry, create(WatchEventsRequestSchema, { cursor: "c0" }), opts);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(2);
    await expect(jobs[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: Code.OutOfRange });
    await expect(events[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: Code.OutOfRange });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
