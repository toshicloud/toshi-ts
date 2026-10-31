import type { Interceptor } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createToshiClient } from "../src/client.js";
import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { OperatorHold } from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import type { HoldWorkloadRequest, ReleaseWorkloadRequest } from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { createFake } from "../src/test/index.js";

function callRequest<T>(fake: ReturnType<typeof createFake>, index = 0): T {
  return fake.calls()[index].request as T;
}

describe("the operator's holds, through client.workload", () => {
  it("sends holdWorkload with the project, environment, workload and hold", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.holdWorkload, () => ({}));
    await fake.client().workload.holdWorkload({
      project: "project-2",
      environment: "staging",
      workloadId: "wl-1",
      hold: OperatorHold.ABUSE_CONFIRMED,
    });
    expect(callRequest<HoldWorkloadRequest>(fake)).toMatchObject({
      project: "project-2",
      environment: "staging",
      workloadId: "wl-1",
      hold: OperatorHold.ABUSE_CONFIRMED,
    });
  });

  it("sends releaseWorkload with the workload and the client's scope", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.releaseWorkload, () => ({}));
    await fake.client().workload.releaseWorkload({ workloadId: "wl-1" });
    expect(callRequest<ReleaseWorkloadRequest>(fake)).toMatchObject({
      project: "default",
      environment: "production",
      workloadId: "wl-1",
    });
  });

  it("sends a header an interceptor in the transport function sets", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.holdWorkload, () => ({}));
    const reason: Interceptor = (next) => (req) => {
      req.header.set("Toshi-Operator-Reason", "investigating a report");
      return next(req);
    };
    const toshi = createToshiClient({
      transport: (interceptors) => fake.transport([...interceptors, reason]),
      token: "operator-token",
      project: "default",
      environment: "production",
    });
    await toshi.workload.holdWorkload({ workloadId: "wl-1", hold: OperatorHold.ABUSE_SUSPECTED });
    expect(fake.calls()[0].header.get("toshi-operator-reason")).toBe("investigating a report");
  });
});
