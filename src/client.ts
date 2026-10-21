import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import type { Client, Interceptor, Transport } from "@connectrpc/connect";

import { executeCommand } from "./execute.js";
import { DisplayService } from "./gen/toshi/workspace/v1/display_pb.js";
import {
  ExecuteStartSchema,
  WaitOperationRequestSchema,
  WaitWorkloadRequestSchema,
  WatchEventsRequestSchema,
  WatchOutputRequestSchema,
  WatchWorkloadsRequestSchema,
  WorkspaceService,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import type {
  Event,
  Operation,
  WaitWorkloadResponse,
  WatchOutputResponse,
  WatchWorkloadsResponse,
  Workload,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import { ProjectService } from "./gen/toshi/workspace/v1/projects_pb.js";
import { SecretService } from "./gen/toshi/workspace/v1/secrets_pb.js";
import { WebhookService } from "./gen/toshi/workspace/v1/webhook_pb.js";
import { openOutputWatch } from "./output.js";
import { authInterceptor, keyInterceptor, retryInterceptor, scopeInterceptor } from "./interceptors.js";
import { normalizeRetry } from "./retry.js";
import type { RetryPolicy } from "./retry.js";
import { openEventWatch, openWorkloadWatch } from "./watch.js";
import { waitOperation, waitWorkload } from "./wait.js";

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

/** The five generated clients plus the helpers that live on top of them. */
export interface ToshiClient {
  readonly workspace: Client<typeof WorkspaceService>;
  readonly projects: Client<typeof ProjectService>;
  readonly secrets: Client<typeof SecretService>;
  readonly webhooks: Client<typeof WebhookService>;
  readonly displays: Client<typeof DisplayService>;
  waitWorkload(
    req: MessageInitShape<typeof WaitWorkloadRequestSchema>,
    opts?: CallOptions,
  ): Promise<WaitWorkloadResponse>;
  waitOperation(
    req: MessageInitShape<typeof WaitOperationRequestSchema>,
    opts?: CallOptions,
  ): Promise<Operation>;
  watchWorkloads(
    req: MessageInitShape<typeof WatchWorkloadsRequestSchema>,
    opts?: CallOptions,
  ): Promise<WorkloadWatch>;
  watchEvents(req: MessageInitShape<typeof WatchEventsRequestSchema>, opts?: CallOptions): Promise<EventWatch>;
  watchOutput(req: MessageInitShape<typeof WatchOutputRequestSchema>, opts?: CallOptions): Promise<OutputWatch>;
  execute(start: MessageInitShape<typeof ExecuteStartSchema>, opts?: CallOptions): Promise<Process>;
}

/** A live stream of workload changes (watch.go:40-60). */
export interface WorkloadWatch extends AsyncIterable<WatchWorkloadsResponse> {
  readonly cursor: string;
  readonly snapshot: Workload[] | undefined;
  close(): void;
}

/** A live stream of events (watch.go:261-460). */
export interface EventWatch extends AsyncIterable<Event> {
  readonly cursor: string;
  close(): void;
}

/** A live stream of a job's output (output.go). */
export interface OutputWatch extends AsyncIterable<WatchOutputResponse> {
  readonly offsets: { readonly stdout: bigint; readonly stderr: bigint };
  close(): void;
}

/** One chunk of an execution's output. */
export type OutputChunk = { stream: "stdout"; data: Uint8Array } | { stream: "stderr"; data: Uint8Array };

/** A running execution (execute.go). */
export interface Process extends AsyncIterable<OutputChunk> {
  readonly executionId: string;
  readonly requestKey: string;
  write(data: Uint8Array | string): Promise<void>;
  closeStdin(): Promise<void>;
  wait(): Promise<void>;
}

/**
 * Creates the client: one normalized retry setting, the auth, scope, key and
 * retry interceptors (auth outermost, retry innermost), one transport for every
 * client and helper (client.go:40-93).
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

  const workspace = createClient(WorkspaceService, transport);
  return {
    workspace,
    projects: createClient(ProjectService, transport),
    secrets: createClient(SecretService, transport),
    webhooks: createClient(WebhookService, transport),
    displays: createClient(DisplayService, transport),
    waitWorkload: (req, opts) => waitWorkload(workspace, create(WaitWorkloadRequestSchema, req), opts),
    waitOperation: (req, opts) => waitOperation(workspace, create(WaitOperationRequestSchema, req), opts),
    watchWorkloads: (req, opts) =>
      openWorkloadWatch(workspace, retry, create(WatchWorkloadsRequestSchema, req), opts),
    watchEvents: (req, opts) => openEventWatch(workspace, retry, create(WatchEventsRequestSchema, req), opts),
    watchOutput: (req, opts) => openOutputWatch(workspace, retry, create(WatchOutputRequestSchema, req), opts),
    execute: (start, opts) => executeCommand(workspace, start, opts),
  };
}
