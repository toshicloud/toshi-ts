import { clone, create } from "@bufbuild/protobuf";
import type { DescMethod, Message } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import type { ConnectRouter, HandlerContext, Interceptor, MethodImpl, Transport } from "@connectrpc/connect";

import { createToshiClient } from "../client.js";
import type { ToshiClient, ToshiOptions } from "../client.js";
import {
  CancelJobResponseSchema,
  CreateJobResponseSchema,
  CreateSandboxResponseSchema,
  GetJobResponseSchema,
  GetSandboxResponseSchema,
  ListJobsResponseSchema,
  ListSandboxesResponseSchema,
  WaitJobResponseSchema,
  WaitSandboxResponseSchema,
  WatchJobsResponseSchema,
  WatchSandboxesResponseSchema,
  WorkloadService,
} from "../gen/toshi/workspace/v1/workloads_pb.js";
import type {
  CancelJobRequest,
  CancelJobResponse,
  CreateJobRequest,
  CreateJobResponse,
  CreateSandboxRequest,
  CreateSandboxResponse,
  DeleteServiceAlarmRequest,
  GetJobRequest,
  GetJobResponse,
  GetSandboxRequest,
  GetSandboxResponse,
  GetServiceAlarmRequest,
  ListJobsResponse,
  ListSandboxesResponse,
  ListServiceAlarmsRequest,
  PauseServiceAlarmRequest,
  ResumeServiceAlarmRequest,
  RunServiceAlarmNowRequest,
  SetServiceAlarmRequest,
  WaitJobRequest,
  WaitJobResponse,
  WaitSandboxRequest,
  WaitSandboxResponse,
  WatchJobsRequest,
  WatchJobsResponse,
  WatchSandboxesRequest,
  WatchSandboxesResponse,
} from "../gen/toshi/workspace/v1/workloads_pb.js";
import {
  EndReason,
  EventType,
  ExecuteResponseSchema,
  ExecutionExitSchema,
  ExecutionStartedSchema,
  JobSchema,
  JobState,
  JobStatusSchema,
  OutputEndSchema,
  RecordingPolicy,
  SandboxSchema,
  SandboxState,
  SandboxStatusSchema,
  WatchOutputResponseSchema,
} from "../gen/toshi/workspace/v1/workspace_pb.js";
import type {
  ExecuteRequest,
  ExecuteResponse,
  ExecuteStart,
  Job,
  JobSpec,
  Sandbox,
  SandboxSpec,
  WatchOutputRequest,
  WatchOutputResponse,
} from "../gen/toshi/workspace/v1/workspace_pb.js";
import { AlarmStore } from "./alarms.js";
import { apiMethods, apiPackage, hookOnly as hookOnlyMethods, isApiMethod, procedurePath } from "./procedures.js";

/** The token `client` sends. */
export const testToken = "test-token";

// The scope client fills into a request.
const projectScope = "default";
const environmentScope = "production";

// Answers a fake's errors at once, so a hook that answers UNAVAILABLE does not
// wait through the client's backoff.
const fastRetry = { maxAttempts: 5, initialBackoffMs: 1, maxBackoffMs: 2 } as const;

/** One call the fake received. */
export interface Call {
  /** The procedure the client called, for example `/toshi.workspace.v1.WorkloadService/CreateJob`. */
  readonly procedure: string;
  /** The message the client sent. A bidirectional stream's call is recorded when its first message arrives. */
  readonly request: Message;
  /** The request headers the client sent. */
  readonly header: Headers;
}

/** A job of the fake, and what it answers about it. */
export interface FakeJob {
  /** Sets the state the fake reports for the job. */
  state(state: JobState): FakeJob;
  /** Sets the standard output WatchOutput streams. */
  stdout(stdout: string): FakeJob;
  /** Sets the standard error WatchOutput streams. */
  stderr(stderr: string): FakeJob;
  /** Ends the job with code: the state is ENDED and the end reason EXITED. */
  exitCode(code: number): FakeJob;
}

/** A sandbox of the fake, and what it answers about it. */
export interface FakeSandbox {
  /** Sets the state the fake reports for the sandbox. */
  state(state: SandboxState): FakeSandbox;
}

/** What Execute answers in one sandbox. */
export interface FakeExecution {
  /** Sets the standard output Execute streams. */
  stdout(stdout: string): FakeExecution;
  /** Sets the standard error Execute streams. */
  stderr(stderr: string): FakeExecution;
  /** Sets the exit code the execution ends with. */
  exitCode(code: number): FakeExecution;
}

/** A fake Toshi, built with `createFake`. */
export interface Fake {
  /**
   * Builds the in-memory transport the client uses, with the interceptors it
   * is handed. Pass it as `createToshiClient({ transport: fake.transport })`.
   */
  readonly transport: (interceptors: Interceptor[]) => Transport;
  /**
   * Returns the job with this id. A job the fake has not created yet is what
   * the next CreateJob answers with. It is running until the test sets its
   * state or its exit code.
   */
  job(id: string): FakeJob;
  /**
   * Returns the sandbox with this id. A sandbox the fake has not created yet
   * is what the next CreateSandbox answers with. It is running until the test
   * sets its state.
   */
  sandbox(id: string): FakeSandbox;
  /**
   * Returns what Execute answers in a sandbox: an empty command that exits 0
   * until the test sets its output or its exit code. The sandbox is registered
   * too, so a later GetSandbox finds it.
   */
  execute(sandboxId: string): FakeExecution;
  /**
   * Answers a method instead of the state machine. The implementation is typed
   * by the method, as `router.rpc` is: one call for unary, server-stream and
   * bidirectional methods. A method from outside the Workspace API throws.
   */
  on<M extends DescMethod>(method: M, impl: MethodImpl<M>): Fake;
  /** Returns every call the fake received, oldest first. */
  calls(): readonly Call[];
  /**
   * Returns a client wired to the fake: the token `testToken`, the scope
   * default/production, and a retry policy that answers at once. options
   * change any of that, and are applied last.
   */
  client(options?: FakeOptions): ToshiClient;
}

/** The options `client` takes: ToshiOptions without the transport, which the fake supplies. */
export type FakeOptions = Omit<ToshiOptions, "transport">;

/** Creates a fake Toshi: an in-memory Workspace API and the state its calls answer from. */
export function createFake(): Fake {
  return new FakeToshi();
}

/** The whole API's methods, as [path, method], for the router. */
const routerMethods: ReadonlyArray<readonly [string, DescMethod]> = [...apiMethods];

/** A unary answer, a server-stream answer, or a bidirectional-stream answer. */
type Answer =
  | { readonly kind: "unary"; readonly run: (request: unknown, context: HandlerContext) => unknown }
  | { readonly kind: "server"; readonly run: (request: unknown, context: HandlerContext) => AsyncIterable<unknown> }
  | { readonly kind: "bidi"; readonly run: (requests: AsyncIterable<Message>, context: HandlerContext) => AsyncIterable<unknown> };

/** A built-in answer, made for one fake. */
type Builtin = readonly [DescMethod, (fake: FakeToshi) => Answer];

/** The answers the state machine gives, one entry per method it covers. */
const builtinTable: readonly Builtin[] = [
  [
    workloadMethod("createJob"),
    (fake) => ({
      kind: "unary",
      run: (request) => fake.createJobAnswer(request as CreateJobRequest),
    }),
  ],
  [
    workloadMethod("getJob"),
    (fake) => ({ kind: "unary", run: (request) => fake.getJobAnswer(request as GetJobRequest) }),
  ],
  [
    workloadMethod("listJobs"),
    (fake) => ({ kind: "unary", run: () => fake.listJobsAnswer() }),
  ],
  [
    workloadMethod("cancelJob"),
    (fake) => ({ kind: "unary", run: (request) => fake.cancelJobAnswer(request as CancelJobRequest) }),
  ],
  [
    workloadMethod("waitJob"),
    (fake) => ({ kind: "unary", run: (request) => fake.waitJobAnswer(request as WaitJobRequest) }),
  ],
  [
    workloadMethod("createSandbox"),
    (fake) => ({
      kind: "unary",
      run: (request) => fake.createSandboxAnswer(request as CreateSandboxRequest),
    }),
  ],
  [
    workloadMethod("getSandbox"),
    (fake) => ({ kind: "unary", run: (request) => fake.getSandboxAnswer(request as GetSandboxRequest) }),
  ],
  [
    workloadMethod("listSandboxes"),
    (fake) => ({ kind: "unary", run: () => fake.listSandboxesAnswer() }),
  ],
  [
    workloadMethod("waitSandbox"),
    (fake) => ({
      kind: "unary",
      run: (request) => fake.waitSandboxAnswer(request as WaitSandboxRequest),
    }),
  ],
  [
    workloadMethod("watchJobs"),
    (fake) => ({
      kind: "server",
      run: (request, context) => fake.watchJobsAnswer(request as WatchJobsRequest, context),
    }),
  ],
  [
    workloadMethod("watchOutput"),
    (fake) => ({
      kind: "server",
      run: (request) => fake.watchOutputAnswer(request as WatchOutputRequest),
    }),
  ],
  [
    workloadMethod("watchSandboxes"),
    (fake) => ({
      kind: "server",
      run: (request, context) => fake.watchSandboxesAnswer(request as WatchSandboxesRequest, context),
    }),
  ],
  [
    workloadMethod("execute"),
    (fake) => ({
      kind: "bidi",
      run: (requests) => fake.executeAnswer(requests),
    }),
  ],
  [
    workloadMethod("setServiceAlarm"),
    (fake) => ({ kind: "unary", run: (request) => fake.alarms.set(request as SetServiceAlarmRequest) }),
  ],
  [
    workloadMethod("getServiceAlarm"),
    (fake) => ({ kind: "unary", run: (request) => fake.alarms.get(request as GetServiceAlarmRequest) }),
  ],
  [
    workloadMethod("listServiceAlarms"),
    (fake) => ({ kind: "unary", run: (request) => fake.alarms.list(request as ListServiceAlarmsRequest) }),
  ],
  [
    workloadMethod("deleteServiceAlarm"),
    (fake) => ({ kind: "unary", run: (request) => fake.alarms.delete(request as DeleteServiceAlarmRequest) }),
  ],
  [
    workloadMethod("pauseServiceAlarm"),
    (fake) => ({ kind: "unary", run: (request) => fake.alarms.pause(request as PauseServiceAlarmRequest) }),
  ],
  [
    workloadMethod("resumeServiceAlarm"),
    (fake) => ({ kind: "unary", run: (request) => fake.alarms.resume(request as ResumeServiceAlarmRequest) }),
  ],
  [
    workloadMethod("runServiceAlarmNow"),
    (fake) => ({ kind: "unary", run: (request) => fake.alarms.runNow(request as RunServiceAlarmNowRequest) }),
  ],
];

/** The procedures the state machine answers. The coverage test holds it against the API. */
export const answeredProcedures: readonly DescMethod[] = builtinTable.map(([method]) => method);

/** One of WorkloadService's methods, as the descriptor the API exports. */
function workloadMethod<K extends keyof typeof WorkloadService.method>(name: K): (typeof WorkloadService.method)[K] {
  return WorkloadService.method[name];
}

/** One job the fake holds. */
interface JobRecord {
  readonly id: string;
  project: string;
  environment: string;
  spec: JobSpec | undefined;
  labels: Record<string, string>;
  recording: RecordingPolicy;
  state: JobState;
  endReason: EndReason;
  exitCode: number;
  stdout: string;
  stderr: string;
  created: boolean;
}

/** One sandbox the fake holds. */
interface SandboxRecord {
  readonly id: string;
  project: string;
  environment: string;
  spec: SandboxSpec | undefined;
  labels: Record<string, string>;
  recording: RecordingPolicy;
  state: SandboxState;
  endReason: EndReason;
  created: boolean;
}

/** What Execute answers in one sandbox. */
interface ExecutionRecord {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The fake itself; `createFake` hands it out as `Fake`. */
class FakeToshi implements Fake {
  readonly transport: (interceptors: Interceptor[]) => Transport;

  private readonly hooks = new Map<string, Answer>();
  private readonly builtin = new Map<string, Answer>();
  private readonly callLog: Call[] = [];

  private readonly jobs = new Map<string, JobRecord>();
  private readonly jobQueue: string[] = [];
  private readonly jobCreated: string[] = [];
  private readonly jobKeys = new Map<string, JobRecord>();
  private readonly jobLog: WatchJobsResponse[] = [];
  private readonly jobWaiters = new Set<() => void>();
  private nextJob = 0;

  private readonly sandboxes = new Map<string, SandboxRecord>();
  private readonly sandboxQueue: string[] = [];
  private readonly sandboxCreated: string[] = [];
  private readonly sandboxKeys = new Map<string, SandboxRecord>();
  private readonly sandboxLog: WatchSandboxesResponse[] = [];
  private readonly sandboxWaiters = new Set<() => void>();
  private nextSandbox = 0;

  private readonly executions = new Map<string, ExecutionRecord>();
  private nextExecution = 0;

  /** The service alarms the fake holds; `builtinTable` answers from it. */
  readonly alarms = new AlarmStore();

  constructor() {
    for (const [method, make] of builtinTable) {
      this.builtin.set(procedurePath(method), make(this));
    }
    this.transport = (interceptors) =>
      createRouterTransport(
        (router) => {
          this.mount(router);
        },
        { transport: { interceptors } },
      );
  }

  job(id: string): FakeJob {
    if (!this.jobs.has(id)) {
      this.jobs.set(id, newJobRecord(id));
      this.jobQueue.push(id);
    }
    return new JobBuilder(this, id);
  }

  sandbox(id: string): FakeSandbox {
    if (!this.sandboxes.has(id)) {
      this.sandboxes.set(id, newSandboxRecord(id));
      this.sandboxQueue.push(id);
    }
    return new SandboxBuilder(this, id);
  }

  execute(sandboxId: string): FakeExecution {
    if (!this.sandboxes.has(sandboxId)) {
      this.sandboxes.set(sandboxId, newSandboxRecord(sandboxId));
    }
    if (!this.executions.has(sandboxId)) {
      this.executions.set(sandboxId, { stdout: "", stderr: "", exitCode: 0 });
    }
    return new ExecutionBuilder(this, sandboxId);
  }

  on<M extends DescMethod>(method: M, impl: MethodImpl<M>): Fake {
    if (!isApiMethod(method)) {
      throw new Error(`toshi: ${procedurePath(method)} is not a method of the ${apiPackage} API`);
    }
    this.hooks.set(procedurePath(method), hookAnswer(method, impl));
    return this;
  }

  calls(): readonly Call[] {
    return this.callLog.slice();
  }

  client(options: FakeOptions = {}): ToshiClient {
    return createToshiClient({
      transport: this.transport,
      token: testToken,
      project: projectScope,
      environment: environmentScope,
      retry: fastRetry,
      ...options,
    });
  }

  // The builders' state changes. They are public so the builders can reach
  // them; `Fake` is the interface callers see.

  setJobState(id: string, state: JobState): void {
    const record = this.jobs.get(id);
    if (record === undefined) {
      return;
    }
    record.state = state;
    this.changedJob(id, EventType.WORKLOAD_STATE_CHANGED);
  }

  setJobStdout(id: string, stdout: string): void {
    const record = this.jobs.get(id);
    if (record !== undefined) {
      record.stdout = stdout;
    }
  }

  setJobStderr(id: string, stderr: string): void {
    const record = this.jobs.get(id);
    if (record !== undefined) {
      record.stderr = stderr;
    }
  }

  setJobExitCode(id: string, code: number): void {
    const record = this.jobs.get(id);
    if (record === undefined) {
      return;
    }
    record.exitCode = code;
    record.state = JobState.ENDED;
    record.endReason = EndReason.EXITED;
    this.changedJob(id, EventType.WORKLOAD_STATE_CHANGED);
  }

  setSandboxState(id: string, state: SandboxState): void {
    const record = this.sandboxes.get(id);
    if (record === undefined) {
      return;
    }
    record.state = state;
    this.changedSandbox(id, EventType.WORKLOAD_STATE_CHANGED);
  }

  setExecutionStdout(sandboxId: string, stdout: string): void {
    const record = this.executions.get(sandboxId);
    if (record !== undefined) {
      record.stdout = stdout;
    }
  }

  setExecutionStderr(sandboxId: string, stderr: string): void {
    const record = this.executions.get(sandboxId);
    if (record !== undefined) {
      record.stderr = stderr;
    }
  }

  setExecutionExitCode(sandboxId: string, code: number): void {
    const record = this.executions.get(sandboxId);
    if (record !== undefined) {
      record.exitCode = code;
    }
  }

  // The state machine.

  createJobAnswer(request: CreateJobRequest): CreateJobResponse {
    const key = request.requestKey;
    if (key !== "") {
      const replayed = this.jobKeys.get(key);
      if (replayed !== undefined) {
        return create(CreateJobResponseSchema, { job: jobProto(replayed) });
      }
    }
    const record = this.newJob();
    record.project = request.project;
    record.environment = request.environment;
    record.spec = request.spec;
    record.labels = { ...request.labels };
    record.recording = request.recording;
    record.created = true;
    if (key !== "") {
      this.jobKeys.set(key, record);
    }
    this.jobCreated.push(record.id);
    const response = create(CreateJobResponseSchema, { job: jobProto(record) });
    this.changedJob(record.id, EventType.WORKLOAD_CREATED);
    return response;
  }

  getJobAnswer(request: GetJobRequest): GetJobResponse {
    const record = this.jobs.get(request.id);
    if (record === undefined) {
      throw notFound("job", request.id);
    }
    return create(GetJobResponseSchema, { job: jobProto(record) });
  }

  listJobsAnswer(): ListJobsResponse {
    const jobs: Job[] = [];
    for (const id of this.jobCreated) {
      const record = this.jobs.get(id);
      if (record !== undefined) {
        jobs.push(jobProto(record));
      }
    }
    return create(ListJobsResponseSchema, { jobs, cursor: String(this.jobLog.length) });
  }

  cancelJobAnswer(request: CancelJobRequest): CancelJobResponse {
    const record = this.jobs.get(request.id);
    if (record === undefined) {
      throw notFound("job", request.id);
    }
    if (record.state !== JobState.ENDED) {
      record.state = JobState.ENDED;
      record.endReason = EndReason.CANCELLED;
    }
    const response = create(CancelJobResponseSchema, { job: jobProto(record) });
    this.changedJob(request.id, EventType.WORKLOAD_STATE_CHANGED);
    return response;
  }

  waitJobAnswer(request: WaitJobRequest): WaitJobResponse {
    const record = this.jobs.get(request.id);
    if (record === undefined) {
      throw notFound("job", request.id);
    }
    return create(WaitJobResponseSchema, { job: jobProto(record), reached: true });
  }

  createSandboxAnswer(request: CreateSandboxRequest): CreateSandboxResponse {
    const key = request.requestKey;
    if (key !== "") {
      const replayed = this.sandboxKeys.get(key);
      if (replayed !== undefined) {
        return create(CreateSandboxResponseSchema, { sandbox: sandboxProto(replayed) });
      }
    }
    const record = this.newSandbox();
    record.project = request.project;
    record.environment = request.environment;
    record.spec = request.spec;
    record.labels = { ...request.labels };
    record.recording = request.recording;
    record.created = true;
    if (key !== "") {
      this.sandboxKeys.set(key, record);
    }
    this.sandboxCreated.push(record.id);
    const response = create(CreateSandboxResponseSchema, { sandbox: sandboxProto(record) });
    this.changedSandbox(record.id, EventType.WORKLOAD_CREATED);
    return response;
  }

  getSandboxAnswer(request: GetSandboxRequest): GetSandboxResponse {
    const record = this.sandboxes.get(request.id);
    if (record === undefined) {
      throw notFound("sandbox", request.id);
    }
    return create(GetSandboxResponseSchema, { sandbox: sandboxProto(record) });
  }

  listSandboxesAnswer(): ListSandboxesResponse {
    const sandboxes: Sandbox[] = [];
    for (const id of this.sandboxCreated) {
      const record = this.sandboxes.get(id);
      if (record !== undefined) {
        sandboxes.push(sandboxProto(record));
      }
    }
    return create(ListSandboxesResponseSchema, { sandboxes, cursor: String(this.sandboxLog.length) });
  }

  waitSandboxAnswer(request: WaitSandboxRequest): WaitSandboxResponse {
    const record = this.sandboxes.get(request.id);
    if (record === undefined) {
      throw notFound("sandbox", request.id);
    }
    return create(WaitSandboxResponseSchema, { sandbox: sandboxProto(record), reached: true });
  }

  /** Streams a job's output from the request's offsets, then the job's end. */
  watchOutputAnswer(request: WatchOutputRequest): AsyncIterable<WatchOutputResponse> {
    const record = this.jobs.get(request.id);
    if (record === undefined) {
      return failed(notFound("job", request.id));
    }
    const stdout = fromOffset(encode(record.stdout), request.stdoutOffset);
    const stderr = fromOffset(encode(record.stderr), request.stderrOffset);
    const cancelled = record.endReason === EndReason.CANCELLED;
    const messages: WatchOutputResponse[] = [];
    if (stdout.length > 0) {
      messages.push(create(WatchOutputResponseSchema, { message: { case: "stdout", value: stdout } }));
    }
    if (stderr.length > 0) {
      messages.push(create(WatchOutputResponseSchema, { message: { case: "stderr", value: stderr } }));
    }
    messages.push(
      create(WatchOutputResponseSchema, {
        message: {
          case: "end",
          value: create(OutputEndSchema, { exitCode: record.exitCode, cancelled }),
        },
      }),
    );
    return iterableOf(messages);
  }

  /** Reports the job changes made after the cursor, then each change made while the stream is open. */
  async *watchJobsAnswer(request: WatchJobsRequest, context: HandlerContext): AsyncGenerator<WatchJobsResponse> {
    let from = parseCursor(request.cursor);
    for (;;) {
      if (from > this.jobLog.length) {
        throw staleCursor(from);
      }
      while (from < this.jobLog.length) {
        const change = this.jobLog[from];
        from += 1;
        yield clone(WatchJobsResponseSchema, change);
      }
      await waitForChange(this.jobWaiters, context.signal);
      if (context.signal.aborted) {
        return;
      }
    }
  }

  /** Reports the sandbox changes made after the cursor, then each change made while the stream is open. */
  async *watchSandboxesAnswer(
    request: WatchSandboxesRequest,
    context: HandlerContext,
  ): AsyncGenerator<WatchSandboxesResponse> {
    let from = parseCursor(request.cursor);
    for (;;) {
      if (from > this.sandboxLog.length) {
        throw staleCursor(from);
      }
      while (from < this.sandboxLog.length) {
        const change = this.sandboxLog[from];
        from += 1;
        yield clone(WatchSandboxesResponseSchema, change);
      }
      await waitForChange(this.sandboxWaiters, context.signal);
      if (context.signal.aborted) {
        return;
      }
    }
  }

  /**
   * Answers Execute with the outcome the test set for the sandbox: an
   * execution id, the output, and the exit code. Standard input is not read.
   */
  async *executeAnswer(requests: AsyncIterable<Message>): AsyncGenerator<ExecuteResponse> {
    let start: ExecuteStart | undefined;
    for await (const message of requests) {
      const request = message as ExecuteRequest;
      if (request.message.case !== "start") {
        throw new ConnectError("toshi: Execute needs a start message", Code.InvalidArgument);
      }
      start = request.message.value;
      break;
    }
    if (start === undefined) {
      throw new ConnectError("toshi: Execute needs a start message", Code.InvalidArgument);
    }
    const record = this.executions.get(start.sandboxId);
    this.nextExecution += 1;
    const executionId = `exec-${this.nextExecution}`;
    yield create(ExecuteResponseSchema, {
      message: { case: "started", value: create(ExecutionStartedSchema, { executionId }) },
    });
    const stdout = encode(record?.stdout ?? "");
    if (stdout.length > 0) {
      yield create(ExecuteResponseSchema, { message: { case: "stdout", value: stdout } });
    }
    const stderr = encode(record?.stderr ?? "");
    if (stderr.length > 0) {
      yield create(ExecuteResponseSchema, { message: { case: "stderr", value: stderr } });
    }
    yield create(ExecuteResponseSchema, {
      message: {
        case: "exit",
        value: create(ExecutionExitSchema, { exitCode: record?.exitCode ?? 0, cancelled: false }),
      },
    });
  }

  // The router and the dispatch.

  private mount(router: ConnectRouter): void {
    for (const [path, method] of routerMethods) {
      switch (method.methodKind) {
        case "unary":
          router.rpc(
            method,
            ((request: unknown, context: HandlerContext) => {
              this.record(method, request as Message, context.requestHeader);
              return this.answerUnary(path, request, context);
            }) as unknown as MethodImpl<typeof method>,
          );
          break;
        case "server_streaming":
          router.rpc(
            method,
            ((request: unknown, context: HandlerContext) => {
              this.record(method, request as Message, context.requestHeader);
              return this.answerServer(path, request, context);
            }) as unknown as MethodImpl<typeof method>,
          );
          break;
        case "bidi_streaming":
          router.rpc(
            method,
            ((requests: AsyncIterable<Message>, context: HandlerContext) =>
              this.answerBidi(path, method, requests, context)) as unknown as MethodImpl<typeof method>,
          );
          break;
        case "client_streaming":
          router.rpc(
            method,
            (() => Promise.reject(notImplemented(path))) as unknown as MethodImpl<typeof method>,
          );
          break;
      }
    }
  }

  private answerUnary(path: string, request: unknown, context: HandlerContext): Promise<unknown> {
    let answer: Answer;
    try {
      answer = this.answerFor(path);
    } catch (err) {
      return Promise.reject(errorOf(err));
    }
    if (answer.kind !== "unary") {
      return Promise.reject(wrongKind(path, answer.kind));
    }
    return Promise.resolve(answer.run(request, context));
  }

  private answerServer(path: string, request: unknown, context: HandlerContext): AsyncIterable<unknown> {
    let answer: Answer;
    try {
      answer = this.answerFor(path);
    } catch (err) {
      return failed(errorOf(err));
    }
    if (answer.kind !== "server") {
      return failed(wrongKind(path, answer.kind));
    }
    return answer.run(request, context);
  }

  private answerBidi(
    path: string,
    method: DescMethod,
    requests: AsyncIterable<Message>,
    context: HandlerContext,
  ): AsyncIterable<unknown> {
    let answer: Answer;
    try {
      answer = this.answerFor(path);
    } catch (err) {
      return failed(errorOf(err));
    }
    if (answer.kind !== "bidi") {
      return failed(wrongKind(path, answer.kind));
    }
    // A bidirectional call is recorded when its first message arrives, as
    // toshi-go's toshitest does; an unhooked one is answered before reading
    // anything.
    let recorded = false;
    const recordedRequests: AsyncIterable<Message> = {
      [Symbol.asyncIterator]: () => {
        const iterator = requests[Symbol.asyncIterator]();
        return {
          next: async () => {
            const next = await iterator.next();
            if (!recorded && next.done !== true) {
              recorded = true;
              this.record(method, next.value, context.requestHeader);
            }
            return next;
          },
          return: async (value?: undefined) => iterator.return?.(value) ?? { done: true, value: undefined },
        };
      },
    };
    return answer.run(recordedRequests, context);
  }

  private answerFor(path: string): Answer {
    return this.hooks.get(path) ?? this.builtin.get(path) ?? missingAnswer(path);
  }

  private record(method: DescMethod, request: Message, header: Headers): void {
    this.callLog.push({
      procedure: procedurePath(method),
      request: clone(method.input, request),
      header: new Headers(header),
    });
  }

  // The records the built-ins answer from.

  private newJob(): JobRecord {
    const queued = this.jobQueue.shift();
    if (queued !== undefined) {
      const record = this.jobs.get(queued);
      if (record !== undefined) {
        return record;
      }
    }
    for (;;) {
      this.nextJob += 1;
      const id = `job-${this.nextJob}`;
      if (this.jobs.has(id)) {
        continue;
      }
      const record = newJobRecord(id);
      this.jobs.set(id, record);
      return record;
    }
  }

  private newSandbox(): SandboxRecord {
    const queued = this.sandboxQueue.shift();
    if (queued !== undefined) {
      const record = this.sandboxes.get(queued);
      if (record !== undefined) {
        return record;
      }
    }
    for (;;) {
      this.nextSandbox += 1;
      const id = `sandbox-${this.nextSandbox}`;
      if (this.sandboxes.has(id)) {
        continue;
      }
      const record = newSandboxRecord(id);
      this.sandboxes.set(id, record);
      return record;
    }
  }

  private changedJob(id: string, type: EventType): void {
    const record = this.jobs.get(id);
    if (record === undefined || !record.created) {
      return;
    }
    this.jobLog.push(
      create(WatchJobsResponseSchema, {
        type,
        job: jobProto(record),
        cursor: String(this.jobLog.length + 1),
      }),
    );
    for (const wake of [...this.jobWaiters]) {
      wake();
    }
  }

  private changedSandbox(id: string, type: EventType): void {
    const record = this.sandboxes.get(id);
    if (record === undefined || !record.created) {
      return;
    }
    this.sandboxLog.push(
      create(WatchSandboxesResponseSchema, {
        type,
        sandbox: sandboxProto(record),
        cursor: String(this.sandboxLog.length + 1),
      }),
    );
    for (const wake of [...this.sandboxWaiters]) {
      wake();
    }
  }
}

/** Answers a job's setters. */
class JobBuilder implements FakeJob {
  private readonly fake: FakeToshi;
  private readonly id: string;

  constructor(fake: FakeToshi, id: string) {
    this.fake = fake;
    this.id = id;
  }

  state(state: JobState): FakeJob {
    this.fake.setJobState(this.id, state);
    return this;
  }

  stdout(stdout: string): FakeJob {
    this.fake.setJobStdout(this.id, stdout);
    return this;
  }

  stderr(stderr: string): FakeJob {
    this.fake.setJobStderr(this.id, stderr);
    return this;
  }

  exitCode(code: number): FakeJob {
    this.fake.setJobExitCode(this.id, code);
    return this;
  }
}

/** Answers a sandbox's setters. */
class SandboxBuilder implements FakeSandbox {
  private readonly fake: FakeToshi;
  private readonly id: string;

  constructor(fake: FakeToshi, id: string) {
    this.fake = fake;
    this.id = id;
  }

  state(state: SandboxState): FakeSandbox {
    this.fake.setSandboxState(this.id, state);
    return this;
  }
}

/** Answers an execution's setters. */
class ExecutionBuilder implements FakeExecution {
  private readonly fake: FakeToshi;
  private readonly sandboxId: string;

  constructor(fake: FakeToshi, sandboxId: string) {
    this.fake = fake;
    this.sandboxId = sandboxId;
  }

  stdout(stdout: string): FakeExecution {
    this.fake.setExecutionStdout(this.sandboxId, stdout);
    return this;
  }

  stderr(stderr: string): FakeExecution {
    this.fake.setExecutionStderr(this.sandboxId, stderr);
    return this;
  }

  exitCode(code: number): FakeExecution {
    this.fake.setExecutionExitCode(this.sandboxId, code);
    return this;
  }
}

/** Turns a typed hook into the uniform answer the dispatcher runs. */
function hookAnswer<M extends DescMethod>(method: M, impl: MethodImpl<M>): Answer {
  switch (method.methodKind) {
    case "unary": {
      const run = impl as unknown as (request: unknown, context: HandlerContext) => Promise<unknown>;
      return {
        kind: "unary",
        run: async (request, context) => {
          const response = await run(request, context);
          if (response === undefined) {
            throw new ConnectError(`toshi: the hook for ${procedurePath(method)} returned no response`, Code.Internal);
          }
          return response;
        },
      };
    }
    case "server_streaming": {
      return { kind: "server", run: impl as unknown as (request: unknown, context: HandlerContext) => AsyncIterable<unknown> };
    }
    case "bidi_streaming": {
      return {
        kind: "bidi",
        run: impl as unknown as (requests: AsyncIterable<Message>, context: HandlerContext) => AsyncIterable<unknown>,
      };
    }
    case "client_streaming":
      throw new Error(
        `toshi: ${procedurePath(method)} is a client stream; fake.on answers unary, server-stream and bidirectional methods`,
      );
  }
}

/** The answer for a procedure nothing covers: UNIMPLEMENTED, naming the hook to write. */
function missingAnswer(path: string): never {
  throw notImplemented(path);
}

/** UNIMPLEMENTED for a procedure the fake does not answer, naming the method and how to hook it. */
function notImplemented(path: string): ConnectError {
  const method = apiMethods.get(path);
  const hook = method === undefined ? "fake.on" : `fake.on(${method.parent.name}.method.${method.localName})`;
  return new ConnectError(
    `toshi: ${path} has no built-in behaviour; add a hook with ${hook}`,
    Code.Unimplemented,
  );
}

/** error as a ConnectError: a handler's failure always reaches the client as one. */
function errorOf(error: unknown): ConnectError {
  return error instanceof ConnectError
    ? error
    : new ConnectError(error instanceof Error ? error.message : String(error), Code.Internal);
}

/** An internal error for a registered answer of the wrong kind; `on` refuses one at setup. */
function wrongKind(path: string, kind: Answer["kind"]): ConnectError {
  return new ConnectError(`toshi: the ${kind} answer for ${path} does not fit its method`, Code.Internal);
}

/** NOT_FOUND for an id the fake does not hold. */
function notFound(kind: string, id: string): ConnectError {
  return new ConnectError(`toshi: no ${kind} "${id}"`, Code.NotFound);
}

/** OUT_OF_RANGE for a cursor past the last change. */
function staleCursor(position: number): ConnectError {
  return new ConnectError(`toshi: cursor ${position} is past the last change`, Code.OutOfRange);
}

/** Reads a watch's starting position; an empty cursor starts at the beginning. */
function parseCursor(cursor: string): number {
  if (cursor === "") {
    return 0;
  }
  if (!/^\d+$/.test(cursor)) {
    throw new ConnectError(`toshi: "${cursor}" is not a cursor of this workspace`, Code.OutOfRange);
  }
  return Number(cursor);
}

/** Waits for a change, or for the caller to abort; both resolve. */
function waitForChange(waiters: Set<() => void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const wake = (): void => {
      waiters.delete(wake);
      signal.removeEventListener("abort", wake);
      resolve();
    };
    waiters.add(wake);
    signal.addEventListener("abort", wake, { once: true });
    if (signal.aborted) {
      wake();
    }
  });
}

/** A finite stream of items, without an async generator. */
function iterableOf<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let index = 0;
      return {
        next: (): Promise<IteratorResult<T>> => {
          const value = index < items.length ? items[index] : undefined;
          index += 1;
          return Promise.resolve(value === undefined ? { done: true, value: undefined } : { done: false, value });
        },
      };
    },
  };
}

/** A stream that ends at once with error. */
function failed(error: ConnectError): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(error),
    }),
  };
}

/** The status of a job as the API reports it. */
function jobProto(record: JobRecord): Job {
  const status = create(JobStatusSchema, { state: record.state });
  if (record.state === JobState.ENDED) {
    status.endReason = record.endReason;
    if (record.endReason === EndReason.EXITED) {
      status.exitCode = record.exitCode;
    }
  }
  return create(JobSchema, {
    id: record.id,
    project: record.project,
    environment: record.environment,
    spec: record.spec,
    labels: { ...record.labels },
    recording: record.recording,
    status,
  });
}

/** The status of a sandbox as the API reports it. */
function sandboxProto(record: SandboxRecord): Sandbox {
  const status = create(SandboxStatusSchema, { state: record.state });
  if (record.state === SandboxState.ENDED) {
    status.endReason = record.endReason;
  }
  return create(SandboxSchema, {
    id: record.id,
    project: record.project,
    environment: record.environment,
    spec: record.spec,
    labels: { ...record.labels },
    recording: record.recording,
    status,
  });
}

function newJobRecord(id: string): JobRecord {
  return {
    id,
    project: "",
    environment: "",
    spec: undefined,
    labels: {},
    recording: RecordingPolicy.UNSPECIFIED,
    state: JobState.RUNNING,
    endReason: EndReason.UNSPECIFIED,
    exitCode: 0,
    stdout: "",
    stderr: "",
    created: false,
  };
}

function newSandboxRecord(id: string): SandboxRecord {
  return {
    id,
    project: "",
    environment: "",
    spec: undefined,
    labels: {},
    recording: RecordingPolicy.UNSPECIFIED,
    state: SandboxState.RUNNING,
    endReason: EndReason.UNSPECIFIED,
    created: false,
  };
}

/** The part of bytes after offset. */
function fromOffset(bytes: Uint8Array, offset: bigint): Uint8Array {
  if (offset <= 0n) {
    return bytes;
  }
  if (offset >= BigInt(bytes.length)) {
    return new Uint8Array(0);
  }
  return bytes.slice(Number(offset));
}

/** UTF-8 bytes of text. */
function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** The methods the state machine does not answer, for the coverage test's comparison. */
export const hookOnlyProcedures: readonly DescMethod[] = hookOnlyMethods;
