import { create } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import {
  ListServiceRevisionsResponseSchema,
  ServiceRevisionImageOutcome,
  ServiceRevisionSchema,
} from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { createFake } from "../src/test/index.js";

const digest = "sha256:6f1c0b6e0a1f4d2f8e3a5b7c9d1e2f3a4b5c6d7e8f90112233445566778899aa";
const checkedAt = new Date("2026-10-28T02:30:00Z");

describe("service revisions", () => {
  it("carries a revision's image, digest, rollback eligibility and image check", async () => {
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
              ineligibleReason:
                "the registry answered 404 Not Found for the revision's digest: it does not serve the revision's image",
              imageCheck: {
                outcome: ServiceRevisionImageOutcome.NOT_SERVED,
                status: "404 Not Found",
                message: "manifest unknown",
                checkedAt: timestampFromDate(checkedAt),
              },
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
    expect(eligible.imageCheck).toBeUndefined();

    expect(retired.eligible).toBe(false);
    expect(retired.ineligibleReason).not.toBe("");
    expect(retired.imageCheck?.outcome).toBe(ServiceRevisionImageOutcome.NOT_SERVED);
    expect(retired.imageCheck?.status).toBe("404 Not Found");
    expect(retired.imageCheck?.message).toBe("manifest unknown");
    expect(retired.imageCheck?.checkedAt === undefined ? undefined : timestampDate(retired.imageCheck.checkedAt).toISOString()).toBe(
      checkedAt.toISOString(),
    );
  });
});
