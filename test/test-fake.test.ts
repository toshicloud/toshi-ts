import { create } from "@bufbuild/protobuf";
import type { DescMethodUnary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createToshiClient } from "../src/client.js";
import {
  EndReason,
  EventType,
  ExecuteResponseSchema,
  JobSchema,
  JobState,
  SandboxState,
} from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import {
  GetJobResponseSchema,
  ServiceAlarmMisfire,
  WatchJobsResponseSchema,
  WorkloadService,
} from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import type { CreateJobRequest, ListJobsRequest } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { createFake } from "../src/test/index.js";
import { answeredProcedures, hookOnlyProcedures } from "../src/test/fake.js";
import { apiServices, procedurePath } from "../src/test/procedures.js";

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

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("createFake", () => {
  it("runs a job through the client and prints its output", async () => {
    const fake = createFake();
    fake.job("job-1").stdout("deployed\n").exitCode(0);

    const toshi = fake.client();
    const run = await toshi.run({ spec: { command: { argv: ["./deploy.sh"] } } });
    expect(run.job.id).toBe("job-1");
    let printed = "";
    for await (const chunk of run) {
      printed += decode(chunk.data);
    }
    await run.wait();
    expect(printed).toBe("deployed\n");
  });

  it("creates its own ids and replays a request key", async () => {
    const fake = createFake();
    const toshi = fake.client();
    const first = await toshi.workload.jobs.create({ requestKey: "key-1" });
    const replay = await toshi.workload.jobs.create({ requestKey: "key-1" });
    const next = await toshi.workload.jobs.create({ requestKey: "key-2" });
    expect([first.job?.id, replay.job?.id, next.job?.id]).toEqual(["job-1", "job-1", "job-2"]);
  });

  it("answers GetJob, WaitJob and CancelJob from the state the test set", async () => {
    const fake = createFake();
    fake.job("job-1").stdout("out").stderr("err").exitCode(3);
    fake.job("job-2");
    const toshi = fake.client();
    await toshi.workload.jobs.create({});
    await toshi.workload.jobs.create({});

    const got = await toshi.workload.jobs.get({ id: "job-1" });
    expect(got.job?.status?.state).toBe(JobState.ENDED);
    expect(got.job?.status?.endReason).toBe(EndReason.EXITED);
    expect(got.job?.status?.exitCode).toBe(3);

    const waited = await toshi.workload.jobs.wait({ id: "job-1" });
    expect(waited.reached).toBe(true);

    const cancelled = await toshi.workload.jobs.cancel({ id: "job-2" });
    expect(cancelled.job?.status?.state).toBe(JobState.ENDED);
    expect(cancelled.job?.status?.endReason).toBe(EndReason.CANCELLED);
  });

  it("answers NOT_FOUND for an id it does not hold", async () => {
    const toshi = createFake().client();
    const error = await toshi.workload.jobs.get({ id: "missing" }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).code).toBe(Code.NotFound);
  });

  it("lists every job in creation order and watches from the cursor the list answers", async () => {
    const fake = createFake();
    fake.job("job-a").exitCode(0);
    const toshi = fake.client();
    await toshi.workload.jobs.create({});
    await toshi.workload.jobs.create({});

    const listed = await toshi.workload.jobs.list({});
    expect(listed.jobs.map((job) => job.id)).toEqual(["job-a", "job-1"]);
    expect(listed.cursor).toBe("2");

    const created = await toshi.workload.jobs.create({});
    expect(created.job?.id).toBe("job-2");

    const watch = await toshi.workload.jobs.watch({ cursor: listed.cursor });
    const iterator = watch[Symbol.asyncIterator]();
    const next = await iterator.next();
    expect(next.done).toBe(false);
    if (next.done === true) {
      throw new Error("the watch yielded nothing");
    }
    expect(next.value.job?.id).toBe("job-2");
    expect(next.value.type).toBe(EventType.WORKLOAD_CREATED);
    expect(next.value.cursor).toBe("3");
    await iterator.return?.();
  });

  it("answers CreateSandbox and GetSandbox from the sandbox state", async () => {
    const fake = createFake();
    fake.sandbox("sb-1").state(SandboxState.RUNNING);
    const toshi = fake.client();
    const created = await toshi.workload.sandboxes.create({});
    expect(created.sandbox?.id).toBe("sb-1");
    expect(created.sandbox?.status?.state).toBe(SandboxState.RUNNING);

    fake.sandbox("sb-1").state(SandboxState.ENDED);
    const got = await toshi.workload.sandboxes.get({ id: "sb-1" });
    expect(got.sandbox?.status?.state).toBe(SandboxState.ENDED);
  });

  it("answers Execute with the sandbox's output, exit code and execution id", async () => {
    const fake = createFake();
    fake.execute("sb-1").stdout("ok\n").exitCode(0);
    const toshi = fake.client();

    // Execute registers the sandbox, so a later GetSandbox finds it.
    const found = await toshi.workload.sandboxes.get({ id: "sb-1" });
    expect(found.sandbox?.id).toBe("sb-1");

    const process = await toshi.workload.sandboxes.execute({ sandboxId: "sb-1" });
    let out = "";
    for await (const chunk of process) {
      if (chunk.stream === "stdout") {
        out += decode(chunk.data);
      }
    }
    await process.wait();
    expect(process.executionId).toBe("exec-1");
    expect(out).toBe("ok\n");
  });

  it("answers a service's alarms from its state", async () => {
    const services = createFake().client().workload.services;
    const set = await services.setAlarm({
      serviceId: "svc-1",
      name: "nightly",
      schedule: { case: "cron", value: "0 3 * * *" },
      channel: "reports",
      event: "report.due",
    });
    expect(set.alarm).toMatchObject({
      name: "nightly",
      generation: 1n,
      paused: false,
      misfire: ServiceAlarmMisfire.COALESCE,
    });
    expect(set.alarm?.startingDeadline?.seconds).toBe(600n);

    const listed = await services.listAlarms({ serviceId: "svc-1" });
    expect(listed.alarms.map((alarm) => alarm.name)).toEqual(["nightly"]);

    const paused = await services.pauseAlarm({ serviceId: "svc-1", name: "nightly" });
    expect(paused.alarm?.paused).toBe(true);
    expect((await services.getAlarm({ serviceId: "svc-1", name: "nightly" })).alarm?.paused).toBe(true);

    const run = await services.runAlarmNow({ serviceId: "svc-1", name: "nightly", requestKey: "run-1" });
    expect(run.occurrence).toMatchObject({ generation: 1n, manual: true });
    const replay = await services.runAlarmNow({ serviceId: "svc-1", name: "nightly", requestKey: "run-1" });
    expect(replay.occurrence).toMatchObject({ generation: 1n, manual: true });

    const got = await services.getAlarm({ serviceId: "svc-1", name: "nightly" });
    expect(got.occurrences).toHaveLength(1);
    expect(got.occurrences[0]).toMatchObject({ generation: 1n, manual: true });

    const error = await services
      .getAlarm({ serviceId: "svc-1", name: "missing" })
      .catch((err: unknown) => err);
    expect((error as ConnectError).code).toBe(Code.NotFound);
  });

  it("streams WatchOutput from the request's offsets", async () => {
    const fake = createFake();
    fake.job("job-1").stdout("hello").stderr("bad").exitCode(0);
    const toshi = fake.client();
    await toshi.workload.jobs.create({});

    const watch = await toshi.workload.jobs.watchOutput({ id: "job-1", stdoutOffset: 2n, stderrOffset: 0n });
    let out = "";
    let err = "";
    let exitCode: number | undefined;
    for await (const response of watch) {
      switch (response.message.case) {
        case "stdout":
          out += decode(response.message.value);
          break;
        case "stderr":
          err += decode(response.message.value);
          break;
        case "end":
          exitCode = response.message.value.exitCode;
          break;
        default:
          break;
      }
    }
    expect(out).toBe("llo");
    expect(err).toBe("bad");
    expect(exitCode).toBe(0);
    expect(watch.offsets.stdout).toBe(5n);
    expect(watch.offsets.stderr).toBe(3n);
  });

  it("answers UNIMPLEMENTED, naming the method and the hook to write", async () => {
    const toshi = createFake().client();
    const error = await toshi.workload.jobs.update({ id: "job-1" }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).code).toBe(Code.Unimplemented);
    expect((error as ConnectError).message).toContain("/toshi.workspace.v1.WorkloadService/UpdateJob");
    expect((error as ConnectError).message).toContain("fake.on(WorkloadService.method.updateJob)");
  });

  it("answers an unhooked server stream with UNIMPLEMENTED", async () => {
    const toshi = createFake().client();
    const watch = await toshi.workload.services.watch({ cursor: "0" });
    const error = await watch[Symbol.asyncIterator]().next().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).code).toBe(Code.Unimplemented);
    expect((error as ConnectError).message).toContain("fake.on(WorkloadService.method.watchServices)");
  });

  it("answers a unary method through on()", async () => {
    const fake = createFake();
    let asked = "";
    fake.on(WorkloadService.method.getJob, (request) => {
      asked = request.id;
      return Promise.resolve(create(GetJobResponseSchema, { job: create(JobSchema, { id: "hooked" }) }));
    });
    const response = await fake.client().workload.jobs.get({ id: "job-9" });
    expect(asked).toBe("job-9");
    expect(response.job?.id).toBe("hooked");
  });

  it("answers a server-stream method through on()", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.watchJobs, (request) =>
      streamOf(
        create(WatchJobsResponseSchema, {
          type: EventType.WORKLOAD_CREATED,
          job: create(JobSchema, { id: `from-${request.cursor}` }),
          cursor: "7",
        }),
      ),
    );
    const watch = await fake.client().workload.jobs.watch({ cursor: "6" });
    const iterator = watch[Symbol.asyncIterator]();
    const next = await iterator.next();
    expect(next.done).toBe(false);
    if (next.done === true) {
      throw new Error("the hook yielded nothing");
    }
    expect(next.value.job?.id).toBe("from-6");
    expect(watch.cursor).toBe("7");
    await iterator.return?.();
  });

  it("answers a bidirectional method through on(), recording the call's first message", async () => {
    const fake = createFake();
    fake.on(WorkloadService.method.execute, (requests) => ({
      async *[Symbol.asyncIterator]() {
        for await (const request of requests) {
          if (request.message.case !== "start") {
            continue;
          }
          yield create(ExecuteResponseSchema, {
            message: { case: "started", value: { executionId: "exec-hooked" } },
          });
          yield create(ExecuteResponseSchema, { message: { case: "exit", value: { exitCode: 0 } } });
          return;
        }
      },
    }));
    const process = await fake.client().workload.sandboxes.execute({ sandboxId: "sb-1" });
    await process.wait();
    expect(process.executionId).toBe("exec-hooked");
    expect(fake.calls()[0]?.procedure).toBe("/toshi.workspace.v1.WorkloadService/Execute");
  });

  it("refuses a method from outside the Workspace API", () => {
    const fake = createFake();
    const foreign = {
      parent: { typeName: "other.v1.OtherService", name: "OtherService" },
      name: "Ping",
      localName: "ping",
      methodKind: "unary",
      input: JobSchema,
      output: JobSchema,
    } as unknown as DescMethodUnary<typeof JobSchema, typeof JobSchema>;
    expect(() => fake.on(foreign, () => Promise.resolve(create(JobSchema, {})))).toThrow(/other\.v1\.OtherService\/Ping/);
  });

  it("records every call in order, with its request and headers", async () => {
    const fake = createFake();
    const toshi = fake.client();
    await toshi.workload.jobs.create({ spec: { command: { argv: ["echo", "hi"] } } });
    await toshi.workload.jobs.get({ id: "job-1" });

    const calls = fake.calls();
    expect(calls.map((call) => call.procedure)).toEqual([
      "/toshi.workspace.v1.WorkloadService/CreateJob",
      "/toshi.workspace.v1.WorkloadService/GetJob",
    ]);
    const request = calls[0].request as CreateJobRequest;
    expect(request.project).toBe("default");
    expect(request.environment).toBe("production");
    expect(request.spec?.command?.argv).toEqual(["echo", "hi"]);
    expect(request.requestKey).not.toBe("");
    expect(calls[0].header.get("authorization")).toBe("Bearer test-token");
  });

  it("applies client options after its own defaults", async () => {
    const fake = createFake();
    const toshi = fake.client({ token: "other-token", project: "project-2" });
    await toshi.workload.jobs.list({});
    expect(fake.calls()[0].header.get("authorization")).toBe("Bearer other-token");
    const request = fake.calls()[0].request as ListJobsRequest;
    expect(request.project).toBe("project-2");
    expect(request.environment).toBe("production");
  });

  it("serves a client built from fake.transport", async () => {
    const fake = createFake();
    fake.job("job-1").exitCode(0);
    const toshi = createToshiClient({
      transport: fake.transport,
      project: "default",
      environment: "production",
    });
    const created = await toshi.workload.jobs.create({});
    expect(created.job?.id).toBe("job-1");
  });

  it("answers or lists every method of the Workspace API", () => {
    const answered = new Set(answeredProcedures);
    const hooked = new Set(hookOnlyProcedures);
    const all = apiServices.flatMap((service) => service.methods);
    expect(new Set(all).size).toBe(all.length);
    expect(answered.size).toBe(answeredProcedures.length);
    expect(hooked.size).toBe(hookOnlyProcedures.length);
    expect({
      uncovered: all.filter((method) => !answered.has(method) && !hooked.has(method)).map(procedurePath),
      both: all.filter((method) => answered.has(method) && hooked.has(method)).map(procedurePath),
      unknown: [...answered, ...hooked].filter((method) => !all.includes(method)).map(procedurePath),
    }).toEqual({ uncovered: [], both: [], unknown: [] });
  });
});
