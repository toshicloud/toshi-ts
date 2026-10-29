import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import type { Client, Interceptor, Transport } from "@connectrpc/connect";

import { executeCommand } from "./execute.js";
import { AccountService } from "./gen/toshi/workspace/v1/account_pb.js";
import { ArtifactService, ArtifactUploadService } from "./gen/toshi/workspace/v1/artifacts_pb.js";
import { AuditEventService } from "./gen/toshi/workspace/v1/audit_events_pb.js";
import { ChannelService } from "./gen/toshi/workspace/v1/channels_pb.js";
import { ConnectionService } from "./gen/toshi/workspace/v1/connections_pb.js";
import { DiscoveryService } from "./gen/toshi/workspace/v1/discovery_pb.js";
import { DisplayService } from "./gen/toshi/workspace/v1/display_pb.js";
import { DomainService } from "./gen/toshi/workspace/v1/domains_pb.js";
import { FillerService } from "./gen/toshi/workspace/v1/fillers_pb.js";
import { GrantService } from "./gen/toshi/workspace/v1/grants_pb.js";
import { ImageService } from "./gen/toshi/workspace/v1/images_pb.js";
import { HostJobService } from "./gen/toshi/workspace/v1/hostjobs_pb.js";
import { HostService } from "./gen/toshi/workspace/v1/hosts_pb.js";
import { ProductService } from "./gen/toshi/workspace/v1/products_pb.js";
import { ProjectService } from "./gen/toshi/workspace/v1/projects_pb.js";
import { RecordingService } from "./gen/toshi/workspace/v1/recordings_pb.js";
import { RoleService } from "./gen/toshi/workspace/v1/roles_pb.js";
import { SecretService } from "./gen/toshi/workspace/v1/secrets_pb.js";
import { StorageProviderService } from "./gen/toshi/workspace/v1/storage_providers_pb.js";
import { TokenService } from "./gen/toshi/workspace/v1/tokens_pb.js";
import { TriggerService } from "./gen/toshi/workspace/v1/triggers_pb.js";
import { VolumeService } from "./gen/toshi/workspace/v1/volumes_pb.js";
import { WebhookService } from "./gen/toshi/workspace/v1/webhook_pb.js";
import { WorkspaceService } from "./gen/toshi/workspace/v1/workspace_service_pb.js";
import {
  CreatePreviewShareLinkRequestSchema,
  ListPreviewShareLinksRequestSchema,
  RevokePreviewShareLinkRequestSchema,
  StartSandboxRequestSchema,
  StopSandboxRequestSchema,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import type {
  CreatePreviewShareLinkResponse,
  ListPreviewShareLinksResponse,
  RevokePreviewShareLinkResponse,
  StartSandboxResponse,
  StopSandboxResponse,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
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
  GetOperationRequestSchema,
  GetServiceRevisionRequestSchema,
  HoldServiceRequestSchema,
  ListEventsRequestSchema,
  ListServiceActivationsRequestSchema,
  ListServiceRevisionsRequestSchema,
  ListServiceRunsRequestSchema,
  ReleaseServiceRequestSchema,
  RollbackServiceRequestSchema,
  SetServiceModeRequestSchema,
  StartServiceRequestSchema,
  StopServiceRequestSchema,
  WaitOperationRequestSchema,
  WakeServiceRequestSchema,
  WatchEventsRequestSchema,
  WatchOutputRequestSchema,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import type {
  Event,
  GetOperationResponse,
  GetServiceRevisionResponse,
  HoldServiceResponse,
  Job,
  ListEventsResponse,
  ListServiceActivationsResponse,
  ListServiceRevisionsResponse,
  ListServiceRunsResponse,
  Operation,
  PreviewShareLink,
  ReleaseServiceResponse,
  RollbackServiceResponse,
  Sandbox,
  Service,
  ServiceRun,
  SetServiceModeResponse,
  StartServiceResponse,
  StopServiceResponse,
  WakeServiceResponse,
  WatchEventsResponse,
  WatchOutputResponse,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import { openOutputWatch } from "./output.js";
import { paginate } from "./paginate.js";
import {
  authInterceptor,
  keyInterceptor,
  refusalInterceptor,
  retryInterceptor,
  scopeInterceptor,
} from "./interceptors.js";
import { normalizeRetry } from "./retry.js";
import type { RetryPolicy } from "./retry.js";
import { withDefaultUnaryTimeout } from "./timeout.js";
import { openEventWatch, openJobWatch, openSandboxWatch, openServiceWatch } from "./watch.js";
import { runJob } from "./run.js";
import { waitJob, waitOperation, waitSandbox, waitService } from "./wait.js";

/** How the client is configured; the caller builds the transport. */
export interface ToshiOptions {
  /** Builds the caller's transport (connect-node or connect-web) with the client's interceptors. */
  transport: (interceptors: Interceptor[]) => Transport;
  token?: string;
  /**
   * Gives each request attempt its token, so a refreshed token is used without
   * a new client; it wins over `token` and a retry asks it again. A source that
   * throws or answers an empty token ends the call with Code.Unauthenticated,
   * with its error as the cause, and the call is not retried.
   */
  tokenSource?: (signal: AbortSignal | undefined) => string | Promise<string>;
  project?: string;
  environment?: string;
  /** false turns off retries and watch reconnects. */
  retry?: Partial<RetryPolicy> | false;
  /** Bounds each unary call except the Wait calls, which their request's timeout bounds; streams ignore it. */
  defaultTimeoutMs?: number;
}

/** Per-call options. */
export interface CallOptions {
  signal?: AbortSignal;
  /** Bounds the whole call, retries included; on a watch, the open. */
  timeoutMs?: number;
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
  readonly workspace: Client<typeof WorkspaceService>;
  readonly hostJob: Client<typeof HostJobService>;
  readonly host: Client<typeof HostService>;
  readonly token: Client<typeof TokenService>;
  readonly auditEvent: Client<typeof AuditEventService>;
  readonly filler: Client<typeof FillerService>;
  readonly grant: Client<typeof GrantService>;
  readonly storageProvider: Client<typeof StorageProviderService>;
  readonly product: Client<typeof ProductService>;
  readonly discovery: Client<typeof DiscoveryService>;
  readonly connection: Client<typeof ConnectionService>;
  readonly role: Client<typeof RoleService>;
  readonly trigger: Client<typeof TriggerService>;
  readonly account: Client<typeof AccountService>;
  readonly image: Client<typeof ImageService>;
  readonly domain: Client<typeof DomainService>;
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
  /** Lists the events after a cursor, a page at a time; `watchEvents` is the live form. */
  listEvents(
    req: MessageInitShape<typeof ListEventsRequestSchema>,
    opts?: CallOptions,
  ): Promise<ListEventsResponse>;
  /** Yields every event listEvents lists, following the page token from one page to the next. */
  allEvents(req: MessageInitShape<typeof ListEventsRequestSchema>, opts?: CallOptions): AsyncIterable<Event>;
  watchEvents(req: MessageInitShape<typeof WatchEventsRequestSchema>, opts?: CallOptions): Promise<EventWatch>;
  /** Returns one operation: the id a long call hands back, asked for again. */
  getOperation(
    req: MessageInitShape<typeof GetOperationRequestSchema>,
    opts?: CallOptions,
  ): Promise<GetOperationResponse>;
}

/** A job's calls: one method for each of WorkloadService's job calls. */
export interface JobsClient {
  create(req: MessageInitShape<typeof CreateJobRequestSchema>, opts?: CallOptions): Promise<CreateJobResponse>;
  get(req: MessageInitShape<typeof GetJobRequestSchema>, opts?: CallOptions): Promise<GetJobResponse>;
  list(req: MessageInitShape<typeof ListJobsRequestSchema>, opts?: CallOptions): Promise<ListJobsResponse>;
  /** Yields every job that matches every filter that is set, following the page token from one page to the next. */
  all(req: MessageInitShape<typeof ListJobsRequestSchema>, opts?: CallOptions): AsyncIterable<Job>;
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
  /** Yields every sandbox that matches every filter that is set, following the page token from one page to the next. */
  all(req: MessageInitShape<typeof ListSandboxesRequestSchema>, opts?: CallOptions): AsyncIterable<Sandbox>;
  update(req: MessageInitShape<typeof UpdateSandboxRequestSchema>, opts?: CallOptions): Promise<UpdateSandboxResponse>;
  delete(req: MessageInitShape<typeof DeleteSandboxRequestSchema>, opts?: CallOptions): Promise<DeleteSandboxResponse>;
  stop(req: MessageInitShape<typeof StopSandboxRequestSchema>, opts?: CallOptions): Promise<StopSandboxResponse>;
  start(req: MessageInitShape<typeof StartSandboxRequestSchema>, opts?: CallOptions): Promise<StartSandboxResponse>;
  wait(req: MessageInitShape<typeof WaitSandboxRequestSchema>, opts?: CallOptions): Promise<WaitSandboxResponse>;
  watch(req: MessageInitShape<typeof WatchSandboxesRequestSchema>, opts?: CallOptions): Promise<SandboxWatch>;
  execute(start: MessageInitShape<typeof ExecuteStartSchema>, opts?: CallOptions): Promise<Process>;
  createPreviewShareLink(
    req: MessageInitShape<typeof CreatePreviewShareLinkRequestSchema>,
    opts?: CallOptions,
  ): Promise<CreatePreviewShareLinkResponse>;
  listPreviewShareLinks(
    req: MessageInitShape<typeof ListPreviewShareLinksRequestSchema>,
    opts?: CallOptions,
  ): Promise<ListPreviewShareLinksResponse>;
  /** Yields every share link that matches every filter that is set, following the page token from one page to the next. */
  allPreviewShareLinks(
    req: MessageInitShape<typeof ListPreviewShareLinksRequestSchema>,
    opts?: CallOptions,
  ): AsyncIterable<PreviewShareLink>;
  revokePreviewShareLink(
    req: MessageInitShape<typeof RevokePreviewShareLinkRequestSchema>,
    opts?: CallOptions,
  ): Promise<RevokePreviewShareLinkResponse>;
}

/** A service's calls: one method for each of WorkloadService's service calls. */
export interface ServicesClient {
  create(req: MessageInitShape<typeof CreateServiceRequestSchema>, opts?: CallOptions): Promise<CreateServiceResponse>;
  get(req: MessageInitShape<typeof GetServiceRequestSchema>, opts?: CallOptions): Promise<GetServiceResponse>;
  list(req: MessageInitShape<typeof ListServicesRequestSchema>, opts?: CallOptions): Promise<ListServicesResponse>;
  /** Yields every service that matches every filter that is set, following the page token from one page to the next. */
  all(req: MessageInitShape<typeof ListServicesRequestSchema>, opts?: CallOptions): AsyncIterable<Service>;
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
  /** Yields every run listRuns returns, the newest first, following the page token from one page to the next. */
  allRuns(
    req: MessageInitShape<typeof ListServiceRunsRequestSchema>,
    opts?: CallOptions,
  ): AsyncIterable<ServiceRun>;
  /** Returns a service's revisions, oldest first. */
  listRevisions(
    req: MessageInitShape<typeof ListServiceRevisionsRequestSchema>,
    opts?: CallOptions,
  ): Promise<ListServiceRevisionsResponse>;
  /** Returns one revision of a service. */
  getRevision(
    req: MessageInitShape<typeof GetServiceRevisionRequestSchema>,
    opts?: CallOptions,
  ): Promise<GetServiceRevisionResponse>;
  /** Selects a revision the service already has as its current one. */
  rollback(
    req: MessageInitShape<typeof RollbackServiceRequestSchema>,
    opts?: CallOptions,
  ): Promise<RollbackServiceResponse>;
  /** Returns a service's activations, oldest first. */
  listActivations(
    req: MessageInitShape<typeof ListServiceActivationsRequestSchema>,
    opts?: CallOptions,
  ): Promise<ListServiceActivationsResponse>;
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
 * Creates the client: one normalized retry setting, the product, scope, key,
 * retry and auth interceptors (product outermost, so a product's refusal
 * reaches the caller as a ProductError; auth innermost, so no interceptor sees
 * the Authorization header), one transport for every client and helper.
 *
 * Since 0.2.0 the workload calls are grouped by the type they name under
 * `workload`; every other service, WorkspaceService's included, is handed out
 * as one client.
 */
export function createToshiClient(options: ToshiOptions): ToshiClient {
  const retry = normalizeRetry(options.retry);
  const interceptors: Interceptor[] = [
    refusalInterceptor(),
    scopeInterceptor(options.project ?? "", options.environment ?? ""),
    keyInterceptor(),
    retryInterceptor(retry),
    authInterceptor(options.token ?? "", options.tokenSource),
  ];
  const transport = withDefaultUnaryTimeout(options.transport(interceptors), options.defaultTimeoutMs);

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
        all: (req, opts) => paginate(req, workloadService.listJobs, (resp) => resp.jobs, opts),
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
        all: (req, opts) => paginate(req, workloadService.listSandboxes, (resp) => resp.sandboxes, opts),
        update: (req, opts) => workloadService.updateSandbox(req, opts),
        delete: (req, opts) => workloadService.deleteSandbox(req, opts),
        stop: (req, opts) => workloadService.stopSandbox(req, opts),
        start: (req, opts) => workloadService.startSandbox(req, opts),
        wait: (req, opts) => waitSandbox(workloadService, create(WaitSandboxRequestSchema, req), opts),
        watch: (req, opts) =>
          openSandboxWatch(workloadService, retry, create(WatchSandboxesRequestSchema, req), opts),
        execute: (start, opts) => executeCommand(workloadService, start, opts),
        createPreviewShareLink: (req, opts) => workloadService.createPreviewShareLink(req, opts),
        listPreviewShareLinks: (req, opts) => workloadService.listPreviewShareLinks(req, opts),
        allPreviewShareLinks: (req, opts) =>
          paginate(req, workloadService.listPreviewShareLinks, (resp) => resp.shareLinks, opts),
        revokePreviewShareLink: (req, opts) => workloadService.revokePreviewShareLink(req, opts),
      },
      services: {
        create: (req, opts) => workloadService.createService(req, opts),
        get: (req, opts) => workloadService.getService(req, opts),
        list: (req, opts) => workloadService.listServices(req, opts),
        all: (req, opts) => paginate(req, workloadService.listServices, (resp) => resp.services, opts),
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
        allRuns: (req, opts) => paginate(req, workloadService.listServiceRuns, (resp) => resp.runs, opts),
        listRevisions: (req, opts) => workloadService.listServiceRevisions(req, opts),
        getRevision: (req, opts) => workloadService.getServiceRevision(req, opts),
        rollback: (req, opts) => workloadService.rollbackService(req, opts),
        listActivations: (req, opts) => workloadService.listServiceActivations(req, opts),
      },
      waitOperation: (req, opts) =>
        waitOperation(workloadService, create(WaitOperationRequestSchema, req), opts),
      listEvents: (req, opts) => workloadService.listEvents(req, opts),
      allEvents: (req, opts) => paginate(req, workloadService.listEvents, (resp) => resp.events, opts),
      watchEvents: (req, opts) =>
        openEventWatch(workloadService, retry, create(WatchEventsRequestSchema, req), opts),
      getOperation: (req, opts) => workloadService.getOperation(req, opts),
    },
    run: (req, opts) => runJob(workloadService, retry, create(CreateJobRequestSchema, req), opts),
    workspace: createClient(WorkspaceService, transport),
    hostJob: createClient(HostJobService, transport),
    host: createClient(HostService, transport),
    token: createClient(TokenService, transport),
    auditEvent: createClient(AuditEventService, transport),
    filler: createClient(FillerService, transport),
    grant: createClient(GrantService, transport),
    storageProvider: createClient(StorageProviderService, transport),
    product: createClient(ProductService, transport),
    discovery: createClient(DiscoveryService, transport),
    connection: createClient(ConnectionService, transport),
    role: createClient(RoleService, transport),
    trigger: createClient(TriggerService, transport),
    account: createClient(AccountService, transport),
    image: createClient(ImageService, transport),
    domain: createClient(DomainService, transport),
  };
}
