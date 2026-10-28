import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { ListServiceRevisionsResponseSchema, ServiceRevisionSchema } from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { createFake } from "../src/test/index.js";

const digest = "sha256:6f1c0b6e0a1f4d2f8e3a5b7c9d1e2f3a4b5c6d7e8f90112233445566778899aa";

describe("service revisions", () => {
  it("carries a revision's image, digest and rollback eligibility", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.listServiceRevisions, () =>
      Promise.resolve(
        create(ListServiceRevisionsResponseSchema, {
          revisions: [
            create(ServiceRevisionSchema, {
              number: 1n,
              containerImage: "ghcr.io/example/app:v1",
              containerImageDigest: digest,
              eligible: true,
            }),
            create(ServiceRevisionSchema, {
              number: 2n,
              ineligibleReason: "only the 10 newest revisions can be selected",
            }),
          ],
        }),
      ),
    );

    const response = await fake.client().workload.services.listRevisions({ id: "svc-1" });
    const [eligible, retired] = response.revisions;
    expect(eligible.containerImage).toBe("ghcr.io/example/app:v1");
    expect(eligible.containerImageDigest).toBe(digest);
    expect(eligible.eligible).toBe(true);
    expect(eligible.ineligibleReason).toBe("");
    expect(retired.eligible).toBe(false);
    expect(retired.ineligibleReason).toBe("only the 10 newest revisions can be selected");
  });
});
