import { create } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import type { ServiceImpl } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WaitJobRequestSchema, WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { WaitOperationRequestSchema } from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { waitJob, waitMaxJitter, waitMinInterval, waitOperation } from "../src/wait.js";

afterEach(() => {
  vi.useRealTimers();
});

function workloadWith(impl: Partial<ServiceImpl<typeof WorkloadService>>) {
  const transport = createRouterTransport((router) => {
    router.service(WorkloadService, impl);
  });
  return createClient(WorkloadService, transport);
}

describe("waitJob", () => {
  it("calls again while reached is false and returns the reached response", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const workload = workloadWith({
      waitJob() {
        calls += 1;
        return { reached: calls >= 3 };
      },
    });

    const pending = waitJob(
      workload,
      create(WaitJobRequestSchema, { project: "p", environment: "e", id: "w1" }),
    );
    await vi.runAllTimersAsync();
    const resp = await pending;

    expect(calls).toBe(3);
    expect(resp.reached).toBe(true);
  });

  it("ends the loop with the signal's error", async () => {
    const controller = new AbortController();
    let calls = 0;
    const workload = workloadWith({
      waitJob() {
        calls += 1;
        controller.abort(new Error("stop waiting"));
        return { reached: false };
      },
    });

    await expect(
      waitJob(workload, create(WaitJobRequestSchema, { id: "w1" }), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop waiting");
    expect(calls).toBe(1);
  });
});

describe("waitOperation", () => {
  it("calls again while done is false and returns the done operation", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const workload = workloadWith({
      waitOperation() {
        calls += 1;
        return { operation: { id: "op1", done: calls >= 3 } };
      },
    });

    const pending = waitOperation(workload, create(WaitOperationRequestSchema, { id: "op1" }));
    await vi.runAllTimersAsync();
    const operation = await pending;

    expect(calls).toBe(3);
    expect(operation.id).toBe("op1");
    expect(operation.done).toBe(true);
  });

  it("ends the loop with the signal's error", async () => {
    const controller = new AbortController();
    let calls = 0;
    const workload = workloadWith({
      waitOperation() {
        calls += 1;
        controller.abort(new Error("stop waiting"));
        return { operation: { id: "op1", done: false } };
      },
    });

    await expect(
      waitOperation(workload, create(WaitOperationRequestSchema, { id: "op1" }), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop waiting");
    expect(calls).toBe(1);
  });
});

describe("the pause between wait calls", () => {
  it("starts the next call between a second and 1.2 seconds after the previous one", async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const workload = workloadWith({
      waitJob() {
        starts.push(Date.now());
        return { reached: starts.length >= 2 };
      },
    });

    const pending = waitJob(workload, create(WaitJobRequestSchema, { id: "w1" }));
    await vi.advanceTimersByTimeAsync(waitMinInterval - 1);
    expect(starts).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(waitMaxJitter + 1);
    await pending;

    expect(starts).toHaveLength(2);
    const gap = starts[1] - starts[0];
    expect(gap).toBeGreaterThanOrEqual(waitMinInterval);
    expect(gap).toBeLessThanOrEqual(waitMinInterval + waitMaxJitter);
  });

  it("ends the pause with the signal's error", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let calls = 0;
    const workload = workloadWith({
      waitJob() {
        calls += 1;
        return { reached: false };
      },
    });

    const pending = waitJob(workload, create(WaitJobRequestSchema, { id: "w1" }), {
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(waitMinInterval / 2);
    expect(calls).toBe(1);

    controller.abort(new Error("stop waiting"));
    await expect(pending).rejects.toThrow("stop waiting");
  });
});
