import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { createRouterTransport } from "@connectrpc/connect";
import type { Interceptor } from "@connectrpc/connect";

import { createToshiClient } from "../src/client.js";
import type { ToshiClient } from "../src/client.js";
import { ConnectionService } from "../src/gen/toshi/workspace/v1/connections_pb.js";
import { EventType } from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { WebhookService } from "../src/gen/toshi/workspace/v1/webhook_pb.js";
import { WorkspaceService } from "../src/gen/toshi/workspace/v1/workspace_service_pb.js";
import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { createFake } from "../src/test/index.js";

function clientWith(routes: Parameters<typeof createRouterTransport>[0]): ToshiClient {
  return createToshiClient({
    project: "proj",
    environment: "env",
    retry: false,
    transport: (interceptors: Interceptor[]) => createRouterTransport(routes, { transport: { interceptors } }),
  });
}

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

  it("carries a workspace's settings, etag and update mask", async () => {
    const fake = createFake();
    fake.on(WorkspaceService.method.updateWorkspace, (request) => {
      expect(request.updateMask?.paths).toEqual(["settings.sign_in"]);
      expect(request.workspace?.etag).toBe("etag-1");
      return Promise.resolve({
        workspace: {
          id: "ws-1",
          etag: "etag-2",
          settings: {
            historyDays: 30,
            signIn: request.workspace?.settings?.signIn,
          },
        },
      });
    });

    const updated = await fake.client().workspace.updateWorkspace({
      workspace: { etag: "etag-1", settings: { signIn: { provider: "github" } } },
      updateMask: { paths: ["settings.sign_in"] },
    });
    expect(updated.workspace?.etag).toBe("etag-2");
    expect(updated.workspace?.settings?.historyDays).toBe(30);
    expect(updated.workspace?.settings?.signIn?.provider).toBe("github");
  });

  it("carries a connection's delivery target and its update mask", async () => {
    const client = clientWith((router) => {
      router.service(ConnectionService, {
        updateConnection(request) {
          expect(request.updateMask?.paths).toEqual(["target"]);
          return {
            connection: { id: request.connection?.id, target: request.connection?.target },
          };
        },
        getConnectionDelivery() {
          return {
            delivery: { id: "del-1" },
            runs: [{ run: 1, outcome: "delivered", targetDeliveryId: "target-del-1" }],
          };
        },
      });
    });

    const updated = await client.connection.updateConnection({
      connection: { id: "con-1", target: { url: "https://example.com/hooks", secret: "whsec_c2VjcmV0" } },
      updateMask: { paths: ["target"] },
    });
    expect(updated.connection?.target?.url).toBe("https://example.com/hooks");

    const delivery = await client.connection.getConnectionDelivery({ id: "del-1" });
    expect(delivery.runs[0].outcome).toBe("delivered");
    expect(delivery.runs[0].targetDeliveryId).toBe("target-del-1");
  });

  it("carries a job's and a sandbox's image and image version", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.createJob, (request) => {
      expect(request.spec?.image).toBe("build");
      return Promise.resolve({ job: { spec: { image: "build", imageVersionId: "imgv-1" } } });
    });
    fake.on(WorkloadService.method.createSandbox, (request) => {
      expect(request.spec?.image).toBe("dev");
      return Promise.resolve({ sandbox: { spec: { image: "dev", imageVersionId: "imgv-2" } } });
    });

    const toshi = fake.client();
    const job = await toshi.workload.jobs.create({ spec: { image: "build" } });
    expect(job.job?.spec?.imageVersionId).toBe("imgv-1");
    const sandbox = await toshi.workload.sandboxes.create({ spec: { image: "dev" } });
    expect(sandbox.sandbox?.spec?.imageVersionId).toBe("imgv-2");
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
