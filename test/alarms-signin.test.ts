import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { StartServiceSignInResponseSchema } from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { createFake } from "../src/test/index.js";

const down = () => new ConnectError("down", Code.Unavailable);

// A finite stream without async generators, which require an await to lint.
function streamOf<T>(...items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let index = 0;
      return {
        next(): Promise<IteratorResult<T>> {
          const item = index < items.length ? items[index] : undefined;
          index += 1;
          return Promise.resolve(item === undefined ? { done: true, value: undefined } : { done: false, value: item });
        },
      };
    },
  };
}

describe("a service's alarms and sign-ins, and an emitted event, through client.workload", () => {
  it("reaches each of the eleven unary calls with its request and hands back its answer", async () => {
    const fake = createFake();
    const schedule = { case: "cron", value: "0 3 * * *" } as const;
    const alarm = { name: "nightly", channel: "events", event: "tick", schedule };
    fake
      .on(WorkloadService.method.setServiceAlarm, (req) => ({
        alarm: { name: req.name, channel: req.channel, event: req.event, schedule },
      }))
      .on(WorkloadService.method.getServiceAlarm, (req) => ({ alarm: { ...alarm, name: req.name } }))
      .on(WorkloadService.method.listServiceAlarms, () => ({ alarms: [alarm, { ...alarm, name: "weekly" }] }))
      .on(WorkloadService.method.deleteServiceAlarm, () => ({}))
      .on(WorkloadService.method.pauseServiceAlarm, (req) => ({ alarm: { ...alarm, name: req.name, paused: true } }))
      .on(WorkloadService.method.resumeServiceAlarm, (req) => ({ alarm: { ...alarm, name: req.name } }))
      .on(WorkloadService.method.runServiceAlarmNow, () => ({ occurrence: { generation: 1n } }))
      .on(WorkloadService.method.answerServiceSignIn, () => ({}))
      .on(WorkloadService.method.cancelServiceSignIn, () => ({}))
      .on(WorkloadService.method.getServiceSignInStatus, (req) => ({
        statuses: [{ program: req.program, signedIn: true }],
      }))
      .on(WorkloadService.method.emitWorkloadEvent, (req) => ({ event: { name: req.name } }));
    const { workload } = fake.client();
    const { services } = workload;

    const set = await services.setAlarm({ serviceId: "svc-1", ...alarm });
    expect(set.alarm).toMatchObject({ name: "nightly", channel: "events", event: "tick" });
    expect((await services.getAlarm({ serviceId: "svc-1", name: "nightly" })).alarm?.name).toBe("nightly");
    expect((await services.listAlarms({ serviceId: "svc-1" })).alarms.map((a) => a.name)).toEqual([
      "nightly",
      "weekly",
    ]);
    await services.deleteAlarm({ serviceId: "svc-1", name: "weekly" });
    expect((await services.pauseAlarm({ serviceId: "svc-1", name: "nightly" })).alarm?.paused).toBe(true);
    expect((await services.resumeAlarm({ serviceId: "svc-1", name: "nightly" })).alarm?.paused).toBe(false);
    expect((await services.runAlarmNow({ serviceId: "svc-1", name: "nightly" })).occurrence?.generation).toBe(1n);
    await services.answerSignIn({ serviceId: "svc-1", signInId: "si-1", text: "123456" });
    await services.cancelSignIn({ serviceId: "svc-1", signInId: "si-1" });
    const status = await services.getSignInStatus({ serviceId: "svc-1", program: "github" });
    expect(status.statuses[0]).toMatchObject({ program: "github", signedIn: true });
    expect((await workload.emitEvent({ workloadId: "svc-1", name: "build.done" })).event?.name).toBe("build.done");

    expect(fake.calls().map((c) => c.procedure.split("/").pop())).toEqual([
      "SetServiceAlarm",
      "GetServiceAlarm",
      "ListServiceAlarms",
      "DeleteServiceAlarm",
      "PauseServiceAlarm",
      "ResumeServiceAlarm",
      "RunServiceAlarmNow",
      "AnswerServiceSignIn",
      "CancelServiceSignIn",
      "GetServiceSignInStatus",
      "EmitWorkloadEvent",
    ]);
  });

  it("hands back the sign-in's stream as the server sends it, and it ends cleanly after ended", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.startServiceSignIn, (req) =>
      streamOf(
        create(StartServiceSignInResponseSchema, {
          message: { case: "started", value: { signInId: `si-${req.program}` } },
        }),
        create(StartServiceSignInResponseSchema, {
          message: { case: "output", value: new TextEncoder().encode("Enter the code: ") },
        }),
        create(StartServiceSignInResponseSchema, { message: { case: "ended", value: {} } }),
      ),
    );
    const seen: string[] = [];
    for await (const message of fake.client().workload.services.startSignIn({ serviceId: "svc-1", program: "github" })) {
      seen.push(message.message.case === "started" ? `started ${message.message.value.signInId}` : message.message.case ?? "");
    }
    expect(seen).toEqual(["started si-github", "output", "ended"]);
    expect(fake.calls()).toHaveLength(1);
  });
});

describe("retries of the new calls follow the client's table", () => {
  it("does not retry setAlarm or emitEvent: Unavailable reaches the caller after one try", async () => {
    const fake = createFake();
    let sets = 0;
    let emits = 0;
    fake
      .on(WorkloadService.method.setServiceAlarm, () => {
        sets += 1;
        throw down();
      })
      .on(WorkloadService.method.emitWorkloadEvent, () => {
        emits += 1;
        throw down();
      });
    const { workload } = fake.client();
    await expect(workload.services.setAlarm({ serviceId: "svc-1" })).rejects.toMatchObject({ code: Code.Unavailable });
    await expect(workload.emitEvent({ workloadId: "svc-1", name: "x" })).rejects.toMatchObject({
      code: Code.Unavailable,
    });
    expect(sets).toBe(1);
    expect(emits).toBe(1);
  });

  it("retries runAlarmNow with the same request key", async () => {
    const fake = createFake();
    const keys: string[] = [];
    fake.on(WorkloadService.method.runServiceAlarmNow, (req) => {
      keys.push(req.requestKey);
      if (keys.length < 3) {
        throw down();
      }
      return { occurrence: { generation: 2n } };
    });
    const answer = await fake.client().workload.services.runAlarmNow({ serviceId: "svc-1", name: "nightly" });
    expect(answer.occurrence?.generation).toBe(2n);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(keys).size).toBe(1);
  });

  it("retries getAlarm as a read", async () => {
    const fake = createFake();
    let tries = 0;
    fake.on(WorkloadService.method.getServiceAlarm, () => {
      tries += 1;
      if (tries < 2) {
        throw down();
      }
      return { alarm: { name: "nightly" } };
    });
    const answer = await fake.client().workload.services.getAlarm({ serviceId: "svc-1", name: "nightly" });
    expect(answer.alarm?.name).toBe("nightly");
    expect(tries).toBe(2);
  });
});
