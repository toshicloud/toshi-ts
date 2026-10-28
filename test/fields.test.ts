import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { CatalogEntryState } from "../src/gen/toshi/workspace/v1/products_pb.js";
import { ProductService } from "../src/gen/toshi/workspace/v1/products_pb.js";
import { EventType } from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { WebhookService } from "../src/gen/toshi/workspace/v1/webhook_pb.js";
import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { createFake } from "../src/test/index.js";

describe("fields the API added", () => {
  it("carries a webhook endpoint's expired cursor and retention boundary", async () => {
    const boundary = new Date("2026-10-21T00:00:00Z");
    const fake = createFake();
    fake.on(WebhookService.method.getWebhookEndpoint, () =>
      Promise.resolve({
        endpoint: {
          id: "wh-1",
          url: "https://example.com/hook",
          cursorExpired: true,
          retentionBoundary: timestampFromDate(boundary),
        },
      }),
    );
    fake.on(WebhookService.method.updateWebhookEndpoint, (request) => {
      expect(request.updateMask?.paths).toEqual(["cursor"]);
      return Promise.resolve({ endpoint: { id: "wh-1", cursor: request.endpoint?.cursor } });
    });

    const toshi = fake.client();
    const got = await toshi.webhook.getWebhookEndpoint({ id: "wh-1" });
    expect(got.endpoint?.cursorExpired).toBe(true);
    expect(
      got.endpoint?.retentionBoundary === undefined ? undefined : timestampDate(got.endpoint.retentionBoundary).toISOString(),
    ).toBe(boundary.toISOString());

    const moved = await toshi.webhook.updateWebhookEndpoint({
      id: "wh-1",
      endpoint: { cursor: "100" },
      updateMask: { paths: ["cursor"] },
    });
    expect(moved.endpoint?.cursor).toBe("100");
  });

  it("carries a catalog entry's listing state, reason and successor", async () => {
    const fake = createFake();
    fake.on(ProductService.method.listCatalogEntries, () =>
      Promise.resolve({
        entries: [
          {
            id: "acme_ci",
            name: "Acme CI",
            version: "1.2.0",
            stale: true,
            sourceExpiresAt: timestampFromDate(new Date("2026-11-01T00:00:00Z")),
            state: CatalogEntryState.DEPRECATED,
            stateReason: "superseded",
            successor: "acme_ci@2.0.0",
          },
        ],
      }),
    );

    const entries = await fake.client().product.listCatalogEntries({});
    const entry = entries.entries[0];
    expect(entry.stale).toBe(true);
    expect(entry.sourceExpiresAt !== undefined).toBe(true);
    expect(entry.state).toBe(CatalogEntryState.DEPRECATED);
    expect(entry.stateReason).toBe("superseded");
    expect(entry.successor).toBe("acme_ci@2.0.0");
  });

  it("carries a trigger's reason, exit code and message", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.listEvents, () =>
      Promise.resolve({
        events: [
          {
            id: "ev-1",
            type: EventType.TRIGGER_REMOVED,
            name: "trigger.removed",
            payload: {
              case: "trigger",
              value: {
                triggerId: "tr-1",
                triggerName: "preview",
                key: "acme/widgets#7",
                workloadId: "sb-1",
                reason: "process_exited",
                exitCode: 3,
                message: "exit status 3: boom",
              },
            },
          },
        ],
      }),
    );

    const response = await fake.client().workload.listEvents({});
    const event = response.events[0];
    if (event.payload.case !== "trigger") {
      throw new Error(`the event carries ${event.payload.case}`);
    }
    expect(event.payload.value.triggerName).toBe("preview");
    expect(event.payload.value.reason).toBe("process_exited");
    expect(event.payload.value.exitCode).toBe(3);
    expect(event.payload.value.message).toBe("exit status 3: boom");
  });
});
