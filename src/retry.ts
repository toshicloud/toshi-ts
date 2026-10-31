import { Code, ConnectError } from "@connectrpc/connect";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";

/** How often and how long a call is retried; maxAttempts counts the first try. */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
}

/** Five attempts, a 200 ms initial backoff and a 10 s cap (options.go:79-85). */
export const defaultRetryPolicy: Readonly<RetryPolicy> = {
  maxAttempts: 5,
  initialBackoffMs: 200,
  maxBackoffMs: 10_000,
};

/** A resolved retry setting; false turns retries and watch reconnects off. */
export type RetrySetting = Readonly<RetryPolicy> | false;

/** What one procedure's retries are: a read, a keyed write, or nothing. */
export type RetryClass = "read" | "keyed" | "none";

// One entry per procedure of the Workspace API's services. A stream is never
// retried here; a call whose request takes a request_key is retried with that
// key, so the server answers a retry with the first result; a read, a call
// whose permission's level is read, is retried too; every other call is not.
// test/retry.test.ts derives each class from the generated descriptors and
// fails when a regeneration moves a procedure, so an entry follows the API and
// not a list someone remembered to update. An entry whose class needs saying
// more about has it above the entry.
const procedureRetryClass: Readonly<Record<string, RetryClass>> = {
  "/toshi.workspace.v1.AccountService/GetAccount": "read",
  "/toshi.workspace.v1.AccountService/ListIdentities": "read",
  // A repeat answers NOT_FOUND ("an identity the caller does not have fails
  // with NOT_FOUND"), so a retry would report failure for a call that worked;
  // its permission's level is read although it changes state.
  "/toshi.workspace.v1.AccountService/UnlinkIdentity": "none",
  "/toshi.workspace.v1.WorkloadService/CreateJob": "keyed",
  "/toshi.workspace.v1.WorkloadService/GetJob": "read",
  "/toshi.workspace.v1.WorkloadService/ListJobs": "read",
  "/toshi.workspace.v1.WorkloadService/UpdateJob": "keyed",
  "/toshi.workspace.v1.WorkloadService/DeleteJob": "keyed",
  "/toshi.workspace.v1.WorkloadService/CancelJob": "none",
  "/toshi.workspace.v1.WorkloadService/WaitJob": "read",
  "/toshi.workspace.v1.WorkloadService/WatchJobs": "none",
  "/toshi.workspace.v1.WorkloadService/WatchOutput": "none",
  "/toshi.workspace.v1.WorkloadService/WatchTelemetry": "none",
  "/toshi.workspace.v1.WorkloadService/WatchGuestLog": "none",
  "/toshi.workspace.v1.WorkloadService/Execute": "none",
  "/toshi.workspace.v1.WorkloadService/ExecuteCommand": "none",
  "/toshi.workspace.v1.WorkloadService/AnswerPrompt": "none",
  "/toshi.workspace.v1.WorkloadService/CancelExecution": "keyed",
  "/toshi.workspace.v1.WorkloadService/ExportEvents": "none",
  "/toshi.workspace.v1.WorkloadService/GetOperation": "read",
  "/toshi.workspace.v1.WorkloadService/WaitOperation": "read",
  "/toshi.workspace.v1.WorkloadService/ListEvents": "read",
  "/toshi.workspace.v1.WorkloadService/WatchEvents": "none",
  "/toshi.workspace.v1.WorkloadService/CreatePreviewShareLink": "none",
  "/toshi.workspace.v1.WorkloadService/ListPreviewShareLinks": "read",
  "/toshi.workspace.v1.WorkloadService/RevokePreviewShareLink": "none",
  "/toshi.workspace.v1.WorkloadService/CreateServiceShareLink": "none",
  "/toshi.workspace.v1.WorkloadService/ListServiceShareLinks": "read",
  "/toshi.workspace.v1.WorkloadService/RevokeServiceShareLink": "none",
  "/toshi.workspace.v1.WorkloadService/CreateSandbox": "keyed",
  "/toshi.workspace.v1.WorkloadService/GetSandbox": "read",
  "/toshi.workspace.v1.WorkloadService/ListSandboxes": "read",
  "/toshi.workspace.v1.WorkloadService/UpdateSandbox": "keyed",
  "/toshi.workspace.v1.WorkloadService/DeleteSandbox": "keyed",
  "/toshi.workspace.v1.WorkloadService/StopSandbox": "keyed",
  "/toshi.workspace.v1.WorkloadService/StartSandbox": "keyed",
  "/toshi.workspace.v1.WorkloadService/WaitSandbox": "read",
  "/toshi.workspace.v1.WorkloadService/WatchSandboxes": "none",
  "/toshi.workspace.v1.WorkloadService/CreateService": "keyed",
  "/toshi.workspace.v1.WorkloadService/GetService": "read",
  "/toshi.workspace.v1.WorkloadService/ListServices": "read",
  "/toshi.workspace.v1.WorkloadService/UpdateService": "keyed",
  "/toshi.workspace.v1.WorkloadService/DeleteService": "keyed",
  "/toshi.workspace.v1.WorkloadService/WaitService": "read",
  "/toshi.workspace.v1.WorkloadService/WatchServices": "none",
  "/toshi.workspace.v1.WorkloadService/StartService": "keyed",
  "/toshi.workspace.v1.WorkloadService/StopService": "keyed",
  "/toshi.workspace.v1.WorkloadService/SetServiceMode": "keyed",
  "/toshi.workspace.v1.WorkloadService/WakeService": "keyed",
  "/toshi.workspace.v1.WorkloadService/HoldService": "keyed",
  "/toshi.workspace.v1.WorkloadService/ReleaseService": "keyed",
  "/toshi.workspace.v1.WorkloadService/ListServiceRevisions": "read",
  "/toshi.workspace.v1.WorkloadService/GetServiceRevision": "read",
  "/toshi.workspace.v1.WorkloadService/RollbackService": "keyed",
  "/toshi.workspace.v1.WorkloadService/ListServiceActivations": "read",
  "/toshi.workspace.v1.WorkloadService/ListServiceRuns": "read",
  "/toshi.workspace.v1.WorkloadService/EmitWorkloadEvent": "none",
  "/toshi.workspace.v1.WorkloadService/SetServiceAlarm": "none",
  "/toshi.workspace.v1.WorkloadService/GetServiceAlarm": "read",
  "/toshi.workspace.v1.WorkloadService/ListServiceAlarms": "read",
  "/toshi.workspace.v1.WorkloadService/DeleteServiceAlarm": "none",
  "/toshi.workspace.v1.WorkloadService/PauseServiceAlarm": "none",
  "/toshi.workspace.v1.WorkloadService/ResumeServiceAlarm": "none",
  "/toshi.workspace.v1.WorkloadService/RunServiceAlarmNow": "keyed",
  "/toshi.workspace.v1.WorkloadService/StartServiceSignIn": "none",
  "/toshi.workspace.v1.WorkloadService/AnswerServiceSignIn": "none",
  "/toshi.workspace.v1.WorkloadService/CancelServiceSignIn": "none",
  "/toshi.workspace.v1.WorkloadService/GetServiceSignInStatus": "read",
  "/toshi.workspace.v1.SecretService/CreateSecretSet": "keyed",
  "/toshi.workspace.v1.SecretService/ListSecretSets": "read",
  "/toshi.workspace.v1.SecretService/DeleteSecretSet": "none",
  "/toshi.workspace.v1.SecretService/PutSecret": "none",
  "/toshi.workspace.v1.SecretService/DeleteSecret": "none",
  "/toshi.workspace.v1.SecretService/ListSecrets": "read",
  "/toshi.workspace.v1.SecretService/ListSecretVersions": "read",
  "/toshi.workspace.v1.SecretService/GrantSecretSet": "none",
  "/toshi.workspace.v1.SecretService/RevokeSecretSet": "none",
  "/toshi.workspace.v1.SecretService/ListSecretSetGrants": "read",
  "/toshi.workspace.v1.SecretService/UpdateSecretSet": "none",
  "/toshi.workspace.v1.ProjectService/ListProjects": "read",
  "/toshi.workspace.v1.ProjectService/UpdateProject": "none",
  "/toshi.workspace.v1.ProjectService/ListRepositories": "read",
  "/toshi.workspace.v1.ProjectService/GetProject": "read",
  "/toshi.workspace.v1.ProjectService/ListBranchRules": "read",
  "/toshi.workspace.v1.ProjectService/CreateProject": "keyed",
  "/toshi.workspace.v1.ProjectService/ClaimRepository": "none",
  "/toshi.workspace.v1.ProjectService/CreateEnvironment": "keyed",
  "/toshi.workspace.v1.ProjectService/DeleteEnvironment": "none",
  "/toshi.workspace.v1.ProjectService/SetBranchRules": "none",
  "/toshi.workspace.v1.ProjectService/CreateEmbedToken": "none",
  "/toshi.workspace.v1.ProjectService/ListEmbedTokens": "read",
  "/toshi.workspace.v1.ProjectService/RevokeEmbedToken": "none",
  "/toshi.workspace.v1.ProjectService/GetProjectNetwork": "read",
  "/toshi.workspace.v1.ProjectService/SetProjectNetwork": "none",
  "/toshi.workspace.v1.ProjectService/GetEnvironmentNetwork": "read",
  "/toshi.workspace.v1.ProjectService/SetEnvironmentNetwork": "none",
  "/toshi.workspace.v1.ProjectService/GetEnvironmentRetention": "read",
  "/toshi.workspace.v1.ProjectService/SetEnvironmentRetention": "none",
  "/toshi.workspace.v1.ProjectService/SetEnvironmentVolumes": "none",
  "/toshi.workspace.v1.ProjectService/UpdateEnvironment": "none",
  "/toshi.workspace.v1.WebhookService/CreateWebhookEndpoint": "keyed",
  "/toshi.workspace.v1.WebhookService/GetWebhookEndpoint": "read",
  "/toshi.workspace.v1.WebhookService/ListWebhookEndpoints": "read",
  "/toshi.workspace.v1.WebhookService/UpdateWebhookEndpoint": "keyed",
  "/toshi.workspace.v1.WebhookService/DeleteWebhookEndpoint": "keyed",
  "/toshi.workspace.v1.WebhookService/RotateWebhookEndpointSecret": "keyed",
  "/toshi.workspace.v1.WebhookService/ListWebhookDeliveries": "read",
  "/toshi.workspace.v1.WebhookService/ReplayWebhookEvents": "keyed",
  // A retry returns the session the first call opened, with replayed set and
  // no token, and opens nothing, so it cannot give the caller a session it can
  // use.
  "/toshi.workspace.v1.DisplayService/OpenDisplaySession": "none",
  "/toshi.workspace.v1.DisplayService/GetDisplaySession": "read",
  "/toshi.workspace.v1.DisplayService/ListDisplaySessions": "read",
  "/toshi.workspace.v1.DisplayService/CloseDisplaySession": "none",
  "/toshi.workspace.v1.DisplayService/SendDisplayKeys": "none",
  "/toshi.workspace.v1.DisplayService/SendDisplayPointer": "none",
  "/toshi.workspace.v1.DisplayService/SetDisplayClipboard": "none",
  "/toshi.workspace.v1.DisplayService/TakeDisplayScreenshot": "none",
  "/toshi.workspace.v1.ChannelService/CreateChannel": "keyed",
  "/toshi.workspace.v1.ChannelService/ListChannels": "read",
  "/toshi.workspace.v1.ChannelService/GetChannel": "read",
  "/toshi.workspace.v1.ChannelService/GetChannelPolicy": "read",
  "/toshi.workspace.v1.ChannelService/SetChannelPolicy": "none",
  "/toshi.workspace.v1.ChannelService/ListChannelRequests": "read",
  "/toshi.workspace.v1.ChannelService/GetChannelRequest": "read",
  "/toshi.workspace.v1.ChannelService/ExportChannelLog": "none",
  "/toshi.workspace.v1.ChannelService/CreateChannelConnectToken": "none",
  "/toshi.workspace.v1.ChannelService/RevokeChannelConnectToken": "none",
  "/toshi.workspace.v1.ChannelService/DeleteChannel": "none",
  "/toshi.workspace.v1.ChannelService/ListForwards": "read",
  "/toshi.workspace.v1.ChannelService/GetLink": "read",
  "/toshi.workspace.v1.ChannelService/ReplayChannelMessage": "none",
  "/toshi.workspace.v1.ChannelService/SendChannelMessage": "keyed",
  "/toshi.workspace.v1.ChannelService/TailChannelMessages": "none",
  "/toshi.workspace.v1.RecordingService/ListRecordings": "read",
  "/toshi.workspace.v1.RecordingService/GetRecording": "read",
  "/toshi.workspace.v1.RecordingService/CreateRecordingShareLink": "none",
  "/toshi.workspace.v1.RecordingService/ListRecordingShareLinks": "read",
  "/toshi.workspace.v1.RecordingService/RevokeRecordingShareLink": "none",
  "/toshi.workspace.v1.VolumeService/ListVolumes": "read",
  "/toshi.workspace.v1.VolumeService/GetVolume": "read",
  "/toshi.workspace.v1.VolumeService/AttachVolume": "none",
  "/toshi.workspace.v1.VolumeService/DetachVolume": "none",
  "/toshi.workspace.v1.VolumeService/ListVolumeVersions": "read",
  "/toshi.workspace.v1.VolumeService/RestoreVolume": "none",
  "/toshi.workspace.v1.VolumeService/CreateVolume": "keyed",
  "/toshi.workspace.v1.VolumeService/UpdateVolume": "none",
  "/toshi.workspace.v1.VolumeService/DeleteVolume": "none",
  "/toshi.workspace.v1.ArtifactService/ListArtifacts": "read",
  "/toshi.workspace.v1.ArtifactService/GetArtifact": "read",
  "/toshi.workspace.v1.ArtifactService/GetArtifactDownloadURL": "read",
  "/toshi.workspace.v1.ArtifactUploadService/ReserveUpload": "none",
  "/toshi.workspace.v1.ArtifactUploadService/CompleteUpload": "none",
  "/toshi.workspace.v1.WorkspaceService/GetWorkspace": "read",
  "/toshi.workspace.v1.WorkspaceService/UpdateWorkspace": "none",
  "/toshi.workspace.v1.WorkspaceService/ListWorkspaces": "read",
  "/toshi.workspace.v1.WorkspaceService/GetWorkspaceBilling": "read",
  "/toshi.workspace.v1.WorkspaceService/GetWorkspaceStatement": "read",
  "/toshi.workspace.v1.WorkspaceService/ListEgressIPs": "read",
  "/toshi.workspace.v1.WorkspaceService/GetUsage": "read",
  "/toshi.workspace.v1.WorkspaceService/GetQueueTimes": "read",
  "/toshi.workspace.v1.WorkspaceService/GetWorkflowUsage": "read",
  "/toshi.workspace.v1.WorkspaceService/ListPlans": "read",
  "/toshi.workspace.v1.WorkspaceService/CreateCheckoutSession": "none",
  "/toshi.workspace.v1.WorkspaceService/CreateBillingPortalSession": "none",
  "/toshi.workspace.v1.WorkspaceService/GetVersion": "read",
  "/toshi.workspace.v1.WorkspaceService/ListSeats": "read",
  "/toshi.workspace.v1.WorkspaceService/AssignSeat": "none",
  "/toshi.workspace.v1.WorkspaceService/RemoveSeat": "none",
  "/toshi.workspace.v1.WorkspaceService/DeleteWorkspace": "none",
  "/toshi.workspace.v1.WorkspaceService/CancelWorkspaceDeletion": "none",
  "/toshi.workspace.v1.HostJobService/ListHostJobs": "read",
  "/toshi.workspace.v1.HostJobService/GetHostJob": "read",
  "/toshi.workspace.v1.HostJobService/CancelHostJob": "none",
  "/toshi.workspace.v1.HostJobService/GetHostJobFailure": "read",
  "/toshi.workspace.v1.HostJobService/GetHostJobTelemetry": "read",
  // Not a read: it hands out a debug key and a suspended workspace is refused
  // it; the request carries no request_key, so it is never retried.
  "/toshi.workspace.v1.HostJobService/GetHostJobDebugAccess": "none",
  "/toshi.workspace.v1.HostJobService/StopHostJobDebug": "none",
  "/toshi.workspace.v1.HostService/ListHosts": "read",
  "/toshi.workspace.v1.HostService/ListHostStorage": "read",
  "/toshi.workspace.v1.HostService/ListHostAlerts": "read",
  "/toshi.workspace.v1.HostService/SetHostState": "none",
  "/toshi.workspace.v1.HostService/RetireHost": "none",
  "/toshi.workspace.v1.HostService/CreateCloudHost": "keyed",
  "/toshi.workspace.v1.HostService/CheckCloudHost": "none",
  "/toshi.workspace.v1.HostService/CreateEnrollmentToken": "none",
  "/toshi.workspace.v1.TokenService/ListTokens": "read",
  "/toshi.workspace.v1.TokenService/CreateWorkspaceToken": "none",
  "/toshi.workspace.v1.TokenService/RollWorkspaceToken": "none",
  "/toshi.workspace.v1.TokenService/UpdateToken": "none",
  "/toshi.workspace.v1.TokenService/RevokeToken": "none",
  "/toshi.workspace.v1.AuditEventService/ListAuditEvents": "read",
  "/toshi.workspace.v1.AuditEventService/ExportAuditEvents": "none",
  "/toshi.workspace.v1.FillerService/ListFillers": "read",
  "/toshi.workspace.v1.FillerService/PutFiller": "none",
  "/toshi.workspace.v1.FillerService/DeleteFiller": "none",
  "/toshi.workspace.v1.FillerService/SetFillerEnabled": "none",
  "/toshi.workspace.v1.FillerService/ListFillerRuns": "read",
  "/toshi.workspace.v1.GrantService/CreateGrant": "keyed",
  "/toshi.workspace.v1.GrantService/GetGrant": "read",
  "/toshi.workspace.v1.GrantService/ListGrants": "read",
  "/toshi.workspace.v1.GrantService/AcceptGrant": "none",
  "/toshi.workspace.v1.GrantService/DeclineGrant": "none",
  "/toshi.workspace.v1.GrantService/UpdateGrant": "none",
  "/toshi.workspace.v1.GrantService/RevokeGrant": "none",
  "/toshi.workspace.v1.GrantService/LeaveGrant": "none",
  "/toshi.workspace.v1.StorageProviderService/ListStorageProviders": "read",
  "/toshi.workspace.v1.StorageProviderService/CreateStorageProvider": "keyed",
  "/toshi.workspace.v1.StorageProviderService/CheckStorageProvider": "none",
  "/toshi.workspace.v1.StorageProviderService/DeleteStorageProvider": "none",
  "/toshi.workspace.v1.ProductService/ListProducts": "read",
  "/toshi.workspace.v1.ProductService/UpdateProduct": "none",
  "/toshi.workspace.v1.DiscoveryService/Discover": "read",
  "/toshi.workspace.v1.ConnectionService/ListConnections": "read",
  "/toshi.workspace.v1.ConnectionService/GetConnection": "read",
  "/toshi.workspace.v1.ConnectionService/CreateConnection": "keyed",
  "/toshi.workspace.v1.ConnectionService/DeleteConnection": "keyed",
  "/toshi.workspace.v1.ConnectionService/RotateConnectionSecret": "keyed",
  "/toshi.workspace.v1.ConnectionService/UpdateConnection": "none",
  "/toshi.workspace.v1.ConnectionService/ListConnectionDeliveries": "read",
  "/toshi.workspace.v1.ConnectionService/GetConnectionDelivery": "read",
  "/toshi.workspace.v1.ConnectionService/ReplayConnectionDelivery": "keyed",
  "/toshi.workspace.v1.ImageService/BuildImage": "none",
  "/toshi.workspace.v1.ImageService/CreateImage": "keyed",
  "/toshi.workspace.v1.ImageService/DeleteImage": "none",
  "/toshi.workspace.v1.ImageService/GetImage": "read",
  "/toshi.workspace.v1.ImageService/ListImages": "read",
  "/toshi.workspace.v1.ImageService/UpdateImage": "none",
  "/toshi.workspace.v1.RoleService/ListRoles": "read",
  "/toshi.workspace.v1.RoleService/CreateRole": "keyed",
  "/toshi.workspace.v1.RoleService/UpdateRole": "none",
  "/toshi.workspace.v1.RoleService/DeleteRole": "none",
  "/toshi.workspace.v1.RoleService/ListRoleGrants": "read",
  "/toshi.workspace.v1.RoleService/GrantRole": "none",
  "/toshi.workspace.v1.RoleService/RevokeRole": "none",
  "/toshi.workspace.v1.RoleService/ListMembers": "read",
  "/toshi.workspace.v1.RoleService/RemoveMember": "none",
  "/toshi.workspace.v1.RoleService/CreateInvitation": "none",
  "/toshi.workspace.v1.RoleService/ListInvitations": "read",
  "/toshi.workspace.v1.RoleService/RevokeInvitation": "none",
  // A repeat answers ALREADY_EXISTS ("a caller who is already a member fails
  // with ALREADY_EXISTS"), so a retry would report failure for a call that
  // worked; its permission's level is read although it changes state.
  "/toshi.workspace.v1.RoleService/AcceptInvitation": "none",
  "/toshi.workspace.v1.RoleService/ApproveMember": "none",
  "/toshi.workspace.v1.RoleService/DeclineMember": "none",
  "/toshi.workspace.v1.TriggerService/CreateTrigger": "keyed",
  "/toshi.workspace.v1.TriggerService/GetTrigger": "read",
  "/toshi.workspace.v1.TriggerService/ListTriggers": "read",
  "/toshi.workspace.v1.TriggerService/UpdateTrigger": "keyed",
  "/toshi.workspace.v1.TriggerService/DeleteTrigger": "keyed",
  "/toshi.workspace.v1.DomainService/CreateDomain": "keyed",
  "/toshi.workspace.v1.DomainService/GetDomain": "read",
  "/toshi.workspace.v1.DomainService/ListDomains": "read",
  "/toshi.workspace.v1.DomainService/VerifyDomain": "keyed",
  "/toshi.workspace.v1.DomainService/IssueDomain": "keyed",
  "/toshi.workspace.v1.DomainService/DeleteDomain": "none",
};


/** The retry class of a generated procedure path; an unknown path is "none". */
export function retryClassFor(procedure: string): RetryClass {
  return procedureRetryClass[procedure] ?? "none";
}

/** The `/<service typeName>/<method name>` path the client keys the retry table by. */
export function procedurePath(service: { readonly typeName: string }, method: { readonly name: string }): string {
  return `/${service.typeName}/${method.name}`;
}

/** Fills defaults and clamps the policy; false stays false. */
export function normalizeRetry(retry?: Partial<RetryPolicy> | false): RetrySetting {
  if (retry === false) {
    return false;
  }
  const merged = { ...defaultRetryPolicy, ...(retry ?? {}) };
  return {
    maxAttempts: Math.max(1, Math.trunc(merged.maxAttempts)),
    initialBackoffMs: Math.max(0, merged.initialBackoffMs),
    maxBackoffMs: Math.max(0, merged.maxBackoffMs),
  };
}

// The Node system error codes connect-node 2.2.0 maps to Aborted or Unavailable
// in node-error.js:36-51: ERR_STREAM_DESTROYED, ERR_HTTP2_INVALID_STREAM,
// ECONNRESET (Aborted); ETIMEDOUT, ENOTFOUND, EAI_AGAIN, ECONNREFUSED (Unavailable).
// ERR_STREAM_WRITE_AFTER_END is left out: node-error.js:23-34 maps it to Aborted
// to say the server already answered with an error, so a retry repeats a refusal.
// An HTTP/2 stream reset reaches us as Code.Internal with Node's
// ERR_HTTP2_STREAM_ERROR, before connect's own reset mapping (node-error.js:105-125)
// runs. REFUSED_STREAM says the server never processed the stream, so it is a loss,
// as toshi-go's Unavailable for it is; every other reset code is returned.
const nodeLossCodes: ReadonlySet<string> = new Set([
  "ERR_STREAM_DESTROYED",
  "ERR_HTTP2_INVALID_STREAM",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
]);

// Whether the error chain carries one of those Node system error codes.
function hasNodeLossCause(cause: unknown): boolean {
  let current: unknown = cause;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (nodeLossCodes.has((current as { code?: unknown }).code as string)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

// Whether the error chain carries Node's report of a REFUSED_STREAM reset.
function hasRefusedStreamCause(cause: unknown): boolean {
  let current: unknown = cause;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (
      (current as { code?: unknown }).code === "ERR_HTTP2_STREAM_ERROR" &&
      current.message.endsWith("NGHTTP2_REFUSED_STREAM")
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * True only for a dropped connection or an unavailable server: Code.Unavailable,
 * or Code.Aborted caused by one of the Node codes above (retry.go:143-147).
 * A close that matches neither is returned to the caller, not resumed.
 */
export function isTransportLoss(err: unknown): boolean {
  if (!(err instanceof ConnectError)) {
    return false;
  }
  if (err.code === Code.Unavailable) {
    return true;
  }
  if (err.code === Code.Internal) {
    return hasRefusedStreamCause(err.cause);
  }
  return err.code === Code.Aborted && hasNodeLossCause(err.cause);
}

/**
 * isTransportLoss, plus a Connect stream that ended without its EndStreamResponse
 * (connect 2.2.0 protocol-connect/transport.js:198 throws InvalidArgument with
 * this message); that case is a lost stream, not a server refusal.
 */
export function isStreamLoss(err: unknown): boolean {
  return (
    isTransportLoss(err) ||
    (err instanceof ConnectError &&
      err.code === Code.InvalidArgument &&
      err.rawMessage === "protocol error: missing EndStreamResponse")
  );
}

/** A uniform jittered delay in [0, min(maxBackoffMs, initialBackoffMs * 2**attempt)]. */
export function backoffDelay(policy: RetryPolicy, attempt: number): number {
  const limit = Math.min(policy.maxBackoffMs, policy.initialBackoffMs * 2 ** attempt);
  if (limit <= 0) {
    return 0;
  }
  // The jitter is not a secret, so a non-cryptographic source is enough.
  const random = Math.random();
  return Math.floor(random * (limit + 1));
}

/**
 * How long the server asked the client to wait before a retry, in
 * milliseconds, or undefined when it named no wait. A RESOURCE_EXHAUSTED
 * refusal names the wait in a google.rpc.RetryInfo detail and in its
 * Retry-After header, the detail winning when both are there; the API's rate
 * limit sends both, with the same whole seconds. Such a refusal is retried
 * only when it names a wait: one without, such as a plan's limit, does not
 * pass on a retry. An HTTP 429 without a Connect error body reaches the
 * client as Code.Unavailable with the message "HTTP 429" and the response's
 * headers (connect 2.2.0 protocol-connect/validate-response.js:33), and names
 * the wait in its Retry-After. Every other error names none.
 */
export function serverWaitMs(err: unknown): number | undefined {
  if (!(err instanceof ConnectError)) {
    return undefined;
  }
  if (err.code === Code.ResourceExhausted) {
    for (const detail of err.details) {
      if (!("type" in detail) || detail.type !== "google.rpc.RetryInfo") {
        continue;
      }
      const ms = decodeRetryInfoMs(detail.value);
      if (ms !== undefined) {
        return ms;
      }
    }
    return parseRetryAfterMs(err.metadata.get("Retry-After"));
  }
  if (err.code === Code.Unavailable && err.rawMessage === "HTTP 429") {
    return parseRetryAfterMs(err.metadata.get("Retry-After"));
  }
  return undefined;
}

/**
 * The delay before retry attempt + 1: the backoff's, or the server's wait when
 * that is longer, never more than maxBackoffMs.
 */
export function retryDelayMs(policy: RetryPolicy, attempt: number, waitMs: number | undefined): number {
  return Math.min(Math.max(backoffDelay(policy, attempt), waitMs ?? 0), policy.maxBackoffMs);
}

/** A Retry-After of whole seconds, the form the API sends; a date or anything else names no wait. */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || !/^\s*\d+\s*$/.test(value)) {
    return undefined;
  }
  const ms = Number(value.trim()) * 1000;
  return Number.isSafeInteger(ms) ? ms : undefined;
}

/**
 * Reads google.rpc.RetryInfo's retry_delay (1), a google.protobuf.Duration of
 * seconds (1) and nanos (2), as milliseconds, reading the wire format itself
 * as errors.ts does for ErrorInfo.
 */
function decodeRetryInfoMs(bytes: Uint8Array): number | undefined {
  try {
    const reader = new BinaryReader(bytes);
    while (reader.pos < reader.len) {
      const [field, wireType] = reader.tag();
      if (field !== 1 || wireType !== WireType.LengthDelimited) {
        reader.skip(wireType);
        continue;
      }
      const duration = new BinaryReader(reader.bytes());
      let seconds = 0;
      let nanos = 0;
      while (duration.pos < duration.len) {
        const [part, partType] = duration.tag();
        if (part === 1 && partType === WireType.Varint) {
          seconds = Number(duration.int64());
        } else if (part === 2 && partType === WireType.Varint) {
          nanos = duration.int32();
        } else {
          duration.skip(partType);
        }
      }
      const ms = seconds * 1000 + Math.ceil(nanos / 1e6);
      return seconds >= 0 && nanos >= 0 && Number.isSafeInteger(ms) ? ms : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Sleeps, rejecting at once when the signal aborts (retry.go:186-200). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The signal's reason as an error, or a Canceled ConnectError. */
export function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new ConnectError("the call was cancelled", Code.Canceled);
}

/** A 128-bit request key as 32 lowercase hex characters (retry.go:226-231). */
export function newRequestKey(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let key = "";
  for (const byte of bytes) {
    key += byte.toString(16).padStart(2, "0");
  }
  return key;
}
