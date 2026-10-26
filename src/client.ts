import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import type { Client, Interceptor, Transport } from "@connectrpc/connect";

import { executeCommand } from "./execute.js";
import { ArtifactService, ArtifactUploadService } from "./gen/toshi/workspace/v1/artifacts_pb.js";
import { ChannelService } from "./gen/toshi/workspace/v1/channels_pb.js";
import { DisplayService } from "./gen/toshi/workspace/v1/display_pb.js";
import { ProjectService } from "./gen/toshi/workspace/v1/projects_pb.js";
import { RecordingService } from "./gen/toshi/workspace/v1/recordings_pb.js";
import { SecretService } from "./gen/toshi/workspace/v1/secrets_pb.js";
import { VolumeService } from "./gen/toshi/workspace/v1/volumes_pb.js";
import { WebhookService } from "./gen/toshi/workspace/v1/webhook_pb.js";
import {
  CancelJobRequestSchema,
  CreateJobRequestSchema,
  CreateSandboxRequestSchema,
  CreateServiceRequestSchema,
  DeleteJobRequestSchema,
  DeleteSandboxRequestSchema,
  DeleteServiceRequestSchema,
  GetJobRequestSchema,
  GetSandboxRequestSchema,
  GetServiceRequestSchema,
  ListJobsRequestSchema,
  ListSandboxesRequestSchema,
  ListServicesRequestSchema,
  UpdateJobRequestSchema,
  UpdateSandboxRequestSchema,
  UpdateServiceRequestSchema,
  WaitJobRequestSchema,
  WaitSandboxRequestSchema,
  WaitServiceRequestSchema,
  WatchJobsRequestSchema,
  WatchSandboxesRequestSchema,
  WatchServicesRequestSchema,
  WorkloadService,
} from "./gen/toshi/workspace/v1/workloads_pb.js";
import type {
  CancelJobResponse,
  CreateJobResponse,
  CreateSandboxResponse,
  CreateServiceResponse,
  DeleteJobResponse,
  DeleteSandboxResponse,
  DeleteServiceResponse,
  GetJobResponse,
  GetSandboxResponse,
  GetServiceResponse,
  ListJobsResponse,
  ListSandboxesResponse,
  ListServicesResponse,
  UpdateJobResponse,
  UpdateSandboxResponse,
  UpdateServiceResponse,
  WaitJobResponse,
  WaitSandboxResponse,
  WaitServiceResponse,
  WatchJobsResponse,
  WatchSandboxesResponse,
  WatchServicesResponse,
} from "./gen/toshi/workspace/v1/workloads_pb.js";
import {
  ExecuteStartSchema,
  HoldServiceRequestSchema,
  ListServiceRunsRequestSchema,
  ReleaseServiceRequestSchema,
  SetServiceModeRequestSchema,
  StartServiceRequestSchema,
  StopServiceRequestSchema,
  WaitOperationRequestSchema,
  WakeServiceRequestSchema,
  WatchEventsRequestSchema,
  WatchOutputRequestSchema,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import type {
  HoldServiceResponse,
  Job,
  ListServiceRunsResponse,
  Operation,
  ReleaseServiceResponse,
  Sandbox,
  Service,
  SetServiceModeResponse,
  StartServiceResponse,
  StopServiceResponse,
  WakeServiceResponse,
  WatchEventsResponse,
  WatchOutputResponse,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import { openOutputWatch } from "./output.js";
import { authInterceptor, keyInterceptor, retryInterceptor, scopeInterceptor } from "./interceptors.js";
import { normalizeRetry } from "./retry.js";
import type { RetryPolicy } from "./retry.js";
import { openEventWatch, openJobWatch, openSandboxWatch, openServiceWatch } from "./watch.js";
import { runJob } from "./run.js";
import { waitJob, waitOperation, waitSandbox, waitService } from "./wait.js";

/** How the client is configured; the caller builds the transport. */
export interface ToshiOptions {
  /** Builds the caller's transport (connect-node or connect-web) with the client's interceptors. */
  transport: (interceptors: Interceptor[]) => Transport;
  token?: string;
  project?: string;
  environment?: string;
  /** false turns off retries and watch reconnects. */
  retry?: Partial<RetryPolicy> | false;
}

/** Per-call options. */
export interface CallOptions {
  signal?: AbortSignal;
}

/** One client per Workspace API service, plus the helpers that live on top of them. */
export interface ToshiClient {
  readonly project: Client<typeof ProjectService>;
  readonly secret: Client<typeof SecretService>;
  readonly webhook: Client<typeof WebhookService>;
  readonly display: Client<typeof DisplayService>;
  readonly channel: Client<typeof ChannelService>;
  readonly recording: Client<typeof RecordingService>;
  readonly volume: Client<typeof VolumeService>;
  readonly artifact: Client<typeof ArtifactService>;
  readonly artifactUpload: Client<typeof ArtifactUploadService>;
  readonly workload: WorkloadClient;
  run(req: MessageInitShape<typeof CreateJobRequestSchema>, opts?: CallOptions): Promise<JobRun>;
}

/** WorkloadService's calls, grouped by the type they name. */
export interface WorkloadClient {
  readonly jobs: JobsClient;
  readonly sandboxes: SandboxesClient;
  readonly services: ServicesClient;
  waitOperation(
    req: MessageInitShape<typeof WaitOperationRequestSchema>,
    opts?: CallOptions,
  ): Promise<Operation>;
  watchEvents(req: MessageInitShape<typeof WatchEventsRequestSchema>, opts?: CallOptions): Promise<EventWatch>;
}

/** A job's calls: one method for each of WorkloadService's job calls. */
export interface JobsClient {
  create(req: MessageInitShape<typeof CreateJobRequestSchema>, opts?: CallOptions): Promise<CreateJobResponse>;
  get(req: MessageInitShape<typeof GetJobRequestSchema>, opts?: CallOptions): Promise<GetJobResponse>;
  list(req: MessageInitShape<typeof ListJobsRequestSchema>, opts?: CallOptions): Promise<ListJobsResponse>;
  update(req: MessageInitShape<typeof UpdateJobRequestSchema>, opts?: CallOptions): Promise<UpdateJobResponse>;
  delete(req: MessageInitShape<typeof DeleteJobRequestSchema>, opts?: CallOptions): Promise<DeleteJobResponse>;
  cancel(req: MessageInitShape<typeof CancelJobRequestSchema>, opts?: CallOptions): Promise<CancelJobResponse>;
  wait(req: MessageInitShape<typeof WaitJobRequestSchema>, opts?: CallOptions): Promise<WaitJobResponse>;
  watch(req: MessageInitShape<typeof WatchJobsRequestSchema>, opts?: CallOptions): Promise<JobWatch>;
  watchOutput(req: MessageInitShape<typeof WatchOutputRequestSchema>, opts?: CallOptions): Promise<OutputWatch>;
}

/** A sandbox's calls: one method for each of WorkloadService's sandbox calls. */
export interface SandboxesClient {
  create(
    req: MessageInitShape<typeof CreateSandboxRequestSchema>,
    opts?: CallOptions,
  ): Promise<CreateSandboxResponse>;
  get(req: MessageInitShape<typeof GetSandboxRequestSchema>, opts?: CallOptions): Promise<GetSandboxResponse>;
  list(req: MessageInitShape<typeof ListSandboxesRequestSchema>, opts?: CallOptions): Promise<ListSandboxesResponse>;
  update(req: MessageInitShape<typeof UpdateSandboxRequestSchema>, opts?: CallOptions): Promise<UpdateSandboxResponse>;
  delete(req: MessageInitShape<typeof DeleteSandboxRequestSchema>, opts?: CallOptions): Promise<DeleteSandboxResponse>;
  wait(req: MessageInitShape<typeof WaitSandboxRequestSchema>, opts?: CallOptions): Promise<WaitSandboxResponse>;
  watch(req: MessageInitShape<typeof WatchSandboxesRequestSchema>, opts?: CallOptions): Promise<SandboxWatch>;
  execute(start: MessageInitShape<typeof ExecuteStartSchema>, opts?: CallOptions): Promise<Process>;
}

/** A service's calls: one method for each of WorkloadService's service calls. */
export interface ServicesClient {
  create(req: MessageInitShape<typeof CreateServiceRequestSchema>, opts?: CallOptions): Promise<CreateServiceResponse>;
  get(req: MessageInitShape<typeof GetServiceRequestSchema>, opts?: CallOptions): Promise<GetServiceResponse>;
  list(req: MessageInitShape<typeof ListServicesRequestSchema>, opts?: CallOptions): Promise<ListServicesResponse>;
  update(req: MessageInitShape<typeof UpdateServiceRequestSchema>, opts?: CallOptions): Promise<UpdateServiceResponse>;
  delete(req: MessageInitShape<typeof DeleteServiceRequestSchema>, opts?: CallOptions): Promise<DeleteServiceResponse>;
  wait(req: MessageInitShape<typeof WaitServiceRequestSchema>, opts?: CallOptions): Promise<WaitServiceResponse>;
  watch(req: MessageInitShape<typeof WatchServicesRequestSchema>, opts?: CallOptions): Promise<ServiceWatch>;
  start(req: MessageInitShape<typeof StartServiceRequestSchema>, opts?: CallOptions): Promise<StartServiceResponse>;
  stop(req: MessageInitShape<typeof StopServiceRequestSchema>, opts?: CallOptions): Promise<StopServiceResponse>;
  setMode(req: MessageInitShape<typeof SetServiceModeRequestSchema>, opts?: CallOptions): Promise<SetServiceModeResponse>;
  release(req: MessageInitShape<typeof ReleaseServiceRequestSchema>, opts?: CallOptions): Promise<ReleaseServiceResponse>;
  wake(req: MessageInitShape<typeof WakeServiceRequestSchema>, opts?: CallOptions): Promise<WakeServiceResponse>;
  hold(req: MessageInitShape<typeof HoldServiceRequestSchema>, opts?: CallOptions): Promise<HoldServiceResponse>;
  listRuns(req: MessageInitShape<typeof ListServiceRunsRequestSchema>, opts?: CallOptions): Promise<ListServiceRunsResponse>;
}

/** A live stream of a job's changes. */
export interface JobWatch extends AsyncIterable<WatchJobsResponse> {
  readonly cursor: string;
  readonly snapshot: Job[] | undefined;
  close(): void;
}

/** A live stream of a sandbox's changes. */
export interface SandboxWatch extends AsyncIterable<WatchSandboxesResponse> {
  readonly cursor: string;
  readonly snapshot: Sandbox[] | undefined;
  close(): void;
}

/** A live stream of a service's changes. */
export interface ServiceWatch extends AsyncIterable<WatchServicesResponse> {
  readonly cursor: string;
  readonly snapshot: Service[] | undefined;
  close(): void;
}

/** A live stream of events; every message is the stream's response. */
export interface EventWatch extends AsyncIterable<WatchEventsResponse> {
  readonly cursor: string;
  close(): void;
}

/** A live stream of a job's output. */
export interface OutputWatch extends AsyncIterable<WatchOutputResponse> {
  readonly offsets: { readonly stdout: bigint; readonly stderr: bigint };
  close(): void;
}

/** One chunk of output. */
export type OutputChunk = { stream: "stdout"; data: Uint8Array } | { stream: "stderr"; data: Uint8Array };

/** A running execution. */
export interface Process extends AsyncIterable<OutputChunk> {
  readonly executionId: string;
  readonly requestKey: string;
  write(data: Uint8Array | string): Promise<void>;
  closeStdin(): Promise<void>;
  wait(): Promise<void>;
}

/** A job started by `run`: its output as it comes, then its outcome. */
export interface JobRun extends AsyncIterable<OutputChunk> {
  readonly job: Job;
  wait(): Promise<void>;
}

/**
 * Creates the client: one normalized retry setting, the auth, scope, key and
 * retry interceptors (auth outermost, retry innermost), one transport for every
 * client and helper.
 *
 * Since 0.2.0 the public contract is WorkloadService, not WorkspaceService: its
 * calls are grouped by the type they name under `workload`, and the generated
 * client is not handed out whole.
 */
export function createToshiClient(options: ToshiOptions): ToshiClient {
  const retry = normalizeRetry(options.retry);
  const interceptors: Interceptor[] = [
    authInterceptor(options.token ?? ""),
    scopeInterceptor(options.project ?? "", options.environment ?? ""),
    keyInterceptor(),
    retryInterceptor(retry),
  ];
  const transport = options.transport(interceptors);

  const workloadService = createClient(WorkloadService, transport);
  return {
    project: createClient(ProjectService, transport),
    secret: createClient(SecretService, transport),
    webhook: createClient(WebhookService, transport),
    display: createClient(DisplayService, transport),
    channel: createClient(ChannelService, transport),
    recording: createClient(RecordingService, transport),
    volume: createClient(VolumeService, transport),
    artifact: createClient(ArtifactService, transport),
    artifactUpload: createClient(ArtifactUploadService, transport),
    workload: {
      jobs: {
        create: (req, opts) => workloadService.createJob(req, opts),
        get: (req, opts) => workloadService.getJob(req, opts),
        list: (req, opts) => workloadService.listJobs(req, opts),
        update: (req, opts) => workloadService.updateJob(req, opts),
        delete: (req, opts) => workloadService.deleteJob(req, opts),
        cancel: (req, opts) => workloadService.cancelJob(req, opts),
        wait: (req, opts) => waitJob(workloadService, create(WaitJobRequestSchema, req), opts),
        watch: (req, opts) => openJobWatch(workloadService, retry, create(WatchJobsRequestSchema, req), opts),
        watchOutput: (req, opts) =>
          openOutputWatch(workloadService, retry, create(WatchOutputRequestSchema, req), opts),
      },
      sandboxes: {
        create: (req, opts) => workloadService.createSandbox(req, opts),
        get: (req, opts) => workloadService.getSandbox(req, opts),
        list: (req, opts) => workloadService.listSandboxes(req, opts),
        update: (req, opts) => workloadService.updateSandbox(req, opts),
        delete: (req, opts) => workloadService.deleteSandbox(req, opts),
        wait: (req, opts) => waitSandbox(workloadService, create(WaitSandboxRequestSchema, req), opts),
        watch: (req, opts) =>
          openSandboxWatch(workloadService, retry, create(WatchSandboxesRequestSchema, req), opts),
        execute: (start, opts) => executeCommand(workloadService, start, opts),
      },
      services: {
        create: (req, opts) => workloadService.createService(req, opts),
        get: (req, opts) => workloadService.getService(req, opts),
        list: (req, opts) => workloadService.listServices(req, opts),
        update: (req, opts) => workloadService.updateService(req, opts),
        delete: (req, opts) => workloadService.deleteService(req, opts),
        wait: (req, opts) => waitService(workloadService, create(WaitServiceRequestSchema, req), opts),
        watch: (req, opts) =>
          openServiceWatch(workloadService, retry, create(WatchServicesRequestSchema, req), opts),
        start: (req, opts) => workloadService.startService(req, opts),
        stop: (req, opts) => workloadService.stopService(req, opts),
        setMode: (req, opts) => workloadService.setServiceMode(req, opts),
        release: (req, opts) => workloadService.releaseService(req, opts),
        wake: (req, opts) => workloadService.wakeService(req, opts),
        hold: (req, opts) => workloadService.holdService(req, opts),
        listRuns: (req, opts) => workloadService.listServiceRuns(req, opts),
      },
      waitOperation: (req, opts) =>
        waitOperation(workloadService, create(WaitOperationRequestSchema, req), opts),
      watchEvents: (req, opts) =>
        openEventWatch(workloadService, retry, create(WatchEventsRequestSchema, req), opts),
    },
    run: (req, opts) => runJob(workloadService, retry, create(CreateJobRequestSchema, req), opts),
  };
}
