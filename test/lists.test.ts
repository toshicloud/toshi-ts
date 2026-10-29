import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  EventSchema,
  JobSchema,
  ListEventsResponseSchema,
  ListPreviewShareLinksResponseSchema,
  ListServiceRunsResponseSchema,
  PreviewShareLinkSchema,
  SandboxSchema,
  ServiceRunSchema,
  ServiceSchema,
} from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import {
  ListJobsResponseSchema,
  ListSandboxesResponseSchema,
  ListServicesResponseSchema,
  WorkloadService,
} from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { createFake } from "../src/test/index.js";

/** Every item of an iterable, in order. */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

describe("all", () => {
  it("follows the page token of a job list", async () => {
    const fake = createFake();
    const asked: string[] = [];
    fake.on(WorkloadService.method.listJobs, (request) => {
      asked.push(request.pageToken);
      const second = request.pageToken !== "";
      return Promise.resolve(
        create(ListJobsResponseSchema, {
          jobs: [create(JobSchema, { id: second ? "job-2" : "job-1" })],
          nextPageToken: second ? "" : "page-2",
        }),
      );
    });
    const jobs = await collect(fake.client().workload.jobs.all({ pageSize: 10 }));
    expect(jobs.map((job) => job.id)).toEqual(["job-1", "job-2"]);
    expect(asked).toEqual(["", "page-2"]);
  });

  it("yields every sandbox", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.listSandboxes, () =>
      Promise.resolve(
        create(ListSandboxesResponseSchema, { sandboxes: [create(SandboxSchema, { id: "sandbox-1" })] }),
      ),
    );
    const sandboxes = await collect(fake.client().workload.sandboxes.all({}));
    expect(sandboxes.map((sandbox) => sandbox.id)).toEqual(["sandbox-1"]);
  });

  it("yields every service", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.listServices, () =>
      Promise.resolve(create(ListServicesResponseSchema, { services: [create(ServiceSchema, { id: "service-1" })] })),
    );
    const services = await collect(fake.client().workload.services.all({}));
    expect(services.map((service) => service.id)).toEqual(["service-1"]);
  });

  it("yields every service run", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.listServiceRuns, () =>
      Promise.resolve(
        create(ListServiceRunsResponseSchema, { runs: [create(ServiceRunSchema, { id: "run-1" })] }),
      ),
    );
    const runs = await collect(fake.client().workload.services.allRuns({}));
    expect(runs.map((run) => run.id)).toEqual(["run-1"]);
  });

  it("yields every event", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.listEvents, () =>
      Promise.resolve(create(ListEventsResponseSchema, { events: [create(EventSchema, { id: "event-1" })] })),
    );
    const events = await collect(fake.client().workload.allEvents({}));
    expect(events.map((event) => event.id)).toEqual(["event-1"]);
  });

  it("follows the page token of a sandbox's share links", async () => {
    const fake = createFake();
    const asked: string[] = [];
    fake.on(WorkloadService.method.listPreviewShareLinks, (request) => {
      asked.push(request.pageToken);
      const second = request.pageToken !== "";
      return Promise.resolve(
        create(ListPreviewShareLinksResponseSchema, {
          shareLinks: [create(PreviewShareLinkSchema, { id: second ? "link-2" : "link-1" })],
          nextPageToken: second ? "" : "page-2",
        }),
      );
    });
    const links = await collect(fake.client().workload.sandboxes.allPreviewShareLinks({ sandboxId: "sandbox-1" }));
    expect(links.map((link) => link.id)).toEqual(["link-1", "link-2"]);
    expect(asked).toEqual(["", "page-2"]);
  });
});
