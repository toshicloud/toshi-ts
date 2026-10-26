import { create } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import type { ServiceImpl } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { WaitJobRequestSchema, WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { WaitOperationRequestSchema } from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { waitJob, waitOperation } from "../src/wait.js";

function workloadWith(impl: Partial<ServiceImpl<typeof WorkloadService>>) {
  const transport = createRouterTransport((router) => {
    router.service(WorkloadService, impl);
  });
  return createClient(WorkloadService, transport);
}

describe("waitJob", () => {
  it("calls again while reached is false and returns the reached response", async () => {
    let calls = 0;
    const workload = workloadWith({
      waitJob() {
        calls += 1;
        return { reached: calls >= 3 };
      },
    });

    const resp = await waitJob(
      workload,
      create(WaitJobRequestSchema, { project: "p", environment: "e", id: "w1" }),
    );

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
    let calls = 0;
    const workload = workloadWith({
      waitOperation() {
        calls += 1;
        return { operation: { id: "op1", done: calls >= 3 } };
      },
    });

    const operation = await waitOperation(workload, create(WaitOperationRequestSchema, { id: "op1" }));

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
