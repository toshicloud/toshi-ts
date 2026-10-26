import { getEventListeners } from "node:events";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import type { ServiceImpl } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { WatchOutputRequestSchema } from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { openOutputWatch } from "../src/output.js";

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

// IteratorResult's return value is `any`, so narrow before reading value.
function value<T>(result: IteratorResult<T>): T | undefined {
  return result.done === true ? undefined : result.value;
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

describe("output watch", () => {
  it("yields the end message and releases the RPC before another next()", async () => {
    let resolveAborted: (() => void) | undefined;
    const serverAborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const workload = workloadWith({
      watchOutput(_req, ctx) {
        ctx.signal.addEventListener(
          "abort",
          () => {
            resolveAborted?.();
          },
          { once: true },
        );
        return (async function* () {
          yield { message: { case: "stdout", value: new Uint8Array([1, 2, 3]) } };
          yield { message: { case: "end", value: { exitCode: 0 } } };
          await never();
        })();
      },
    });

    const watch = await openOutputWatch(workload, fastRetry, create(WatchOutputRequestSchema, { id: "j1" }));
    const reader = watch[Symbol.asyncIterator]();
    await reader.next();
    const end = await reader.next();
    expect(value(end)?.message.case).toBe("end");

    // No further next(): decoding the end message itself released the stream.
    await withDeadline(serverAborted);
    await expect(reader.next()).resolves.toEqual({ done: true, value: undefined });
    expect(watch.offsets).toEqual({ stdout: 3n, stderr: 0n });
  });

  it("counts yielded bytes as bigint from the request's starting offsets", async () => {
    const workload = workloadWith({
      watchOutput() {
        return (async function* () {
          yield { message: { case: "stdout", value: new Uint8Array([1, 2, 3]) } };
          yield { message: { case: "stderr", value: new Uint8Array([4, 5]) } };
          yield { message: { case: "stdout", value: new Uint8Array([6]) } };
          await never();
        })();
      },
    });

    const watch = await openOutputWatch(
      workload,
      fastRetry,
      create(WatchOutputRequestSchema, { id: "j1", stdoutOffset: 5n, stderrOffset: 7n }),
    );
    expect(typeof watch.offsets.stdout).toBe("bigint");
    expect(typeof watch.offsets.stderr).toBe("bigint");

    const reader = watch[Symbol.asyncIterator]();
    await reader.next();
    expect(watch.offsets).toEqual({ stdout: 8n, stderr: 7n });
    await reader.next();
    expect(watch.offsets).toEqual({ stdout: 8n, stderr: 9n });
    await reader.next();
    expect(watch.offsets).toEqual({ stdout: 9n, stderr: 9n });
    watch.close();
  });

  it("ends the iteration with OUT_OF_RANGE without reconnecting", async () => {
    let calls = 0;
    const workload = workloadWith({
      watchOutput() {
        calls += 1;
        return failedStream(new ConnectError("offset past the bytes the server holds", Code.OutOfRange));
      },
    });

    const watch = await openOutputWatch(workload, fastRetry, create(WatchOutputRequestSchema, { id: "j1" }));
    await expect(watch[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: Code.OutOfRange });
    expect(calls).toBe(1);
  });

  it("releases the caller's abort listener when the watch ends with an error", async () => {
    const workload = workloadWith({
      watchOutput() {
        return failedStream(new ConnectError("the job's output is no longer held", Code.FailedPrecondition));
      },
    });
    const controller = new AbortController();
    const watch = await openOutputWatch(workload, fastRetry, create(WatchOutputRequestSchema, { id: "j1" }), {
      signal: controller.signal,
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    await expect(watch[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("ends the iteration with FAILED_PRECONDITION without reconnecting", async () => {
    let calls = 0;
    const workload = workloadWith({
      watchOutput() {
        calls += 1;
        return failedStream(new ConnectError("the job's output is no longer held", Code.FailedPrecondition));
      },
    });

    const watch = await openOutputWatch(workload, fastRetry, create(WatchOutputRequestSchema, { id: "j1" }));
    await expect(watch[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
    expect(calls).toBe(1);
  });
});
