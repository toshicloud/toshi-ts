import { Code, ConnectError } from "@connectrpc/connect";

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

// One entry per procedure of the five services, verbatim from the Go client's retry table.
// A procedure missing from this table is treated as "none".
const procedureRetryClass: Readonly<Record<string, RetryClass>> = {
  "/toshi.workspace.v1.WorkspaceService/CreateWorkload": "keyed",
  "/toshi.workspace.v1.WorkspaceService/GetWorkload": "read",
  "/toshi.workspace.v1.WorkspaceService/ListWorkloads": "read",
  "/toshi.workspace.v1.WorkspaceService/PatchWorkload": "keyed",
  "/toshi.workspace.v1.WorkspaceService/DeleteWorkload": "keyed",
  "/toshi.workspace.v1.WorkspaceService/CancelWorkload": "none",
  "/toshi.workspace.v1.WorkspaceService/WaitWorkload": "read",
  "/toshi.workspace.v1.WorkspaceService/WatchWorkloads": "none",
  "/toshi.workspace.v1.WorkspaceService/WatchOutput": "none",
  "/toshi.workspace.v1.WorkspaceService/WatchTelemetry": "none",
  "/toshi.workspace.v1.WorkspaceService/WatchGuestLog": "none",
  "/toshi.workspace.v1.WorkspaceService/Execute": "none",
  "/toshi.workspace.v1.WorkspaceService/CancelExecution": "keyed",
  "/toshi.workspace.v1.WorkspaceService/GetOperation": "read",
  "/toshi.workspace.v1.WorkspaceService/WaitOperation": "read",
  "/toshi.workspace.v1.WorkspaceService/ListEvents": "read",
  "/toshi.workspace.v1.WorkspaceService/WatchEvents": "none",
  "/toshi.workspace.v1.WorkspaceService/CreatePreviewShareLink": "none",
  "/toshi.workspace.v1.WorkspaceService/ListPreviewShareLinks": "read",
  "/toshi.workspace.v1.WorkspaceService/RevokePreviewShareLink": "none",
  "/toshi.workspace.v1.WorkspaceService/StartService": "none",
  "/toshi.workspace.v1.WorkspaceService/StopService": "none",
  "/toshi.workspace.v1.WorkspaceService/SetServiceMode": "none",
  "/toshi.workspace.v1.WorkspaceService/WakeService": "none",
  "/toshi.workspace.v1.WorkspaceService/HoldService": "none",
  "/toshi.workspace.v1.WorkspaceService/ReleaseService": "none",
  "/toshi.workspace.v1.WorkspaceService/ListServiceRuns": "read",
  "/toshi.workspace.v1.SecretService/CreateSecretSet": "none",
  "/toshi.workspace.v1.SecretService/ListSecretSets": "read",
  "/toshi.workspace.v1.SecretService/DeleteSecretSet": "none",
  "/toshi.workspace.v1.SecretService/SetSecret": "none",
  "/toshi.workspace.v1.SecretService/DeleteSecret": "none",
  "/toshi.workspace.v1.SecretService/ListSecrets": "read",
  "/toshi.workspace.v1.SecretService/ListSecretVersions": "read",
  "/toshi.workspace.v1.SecretService/GrantSecretSet": "none",
  "/toshi.workspace.v1.SecretService/RevokeSecretSet": "none",
  "/toshi.workspace.v1.SecretService/ListSecretSetGrants": "read",
  "/toshi.workspace.v1.ProjectService/ListProjects": "read",
  "/toshi.workspace.v1.ProjectService/ListRepositories": "read",
  "/toshi.workspace.v1.ProjectService/GetProject": "read",
  "/toshi.workspace.v1.ProjectService/ListBranchRules": "read",
  "/toshi.workspace.v1.ProjectService/CreateProject": "none",
  "/toshi.workspace.v1.ProjectService/ClaimRepository": "none",
  "/toshi.workspace.v1.ProjectService/CreateEnvironment": "none",
  "/toshi.workspace.v1.ProjectService/DeleteEnvironment": "none",
  "/toshi.workspace.v1.ProjectService/SetBranchRules": "none",
  "/toshi.workspace.v1.ProjectService/CreateEmbedToken": "none",
  "/toshi.workspace.v1.ProjectService/ListEmbedTokens": "read",
  "/toshi.workspace.v1.ProjectService/RevokeEmbedToken": "none",
  "/toshi.workspace.v1.WebhookService/CreateWebhookEndpoint": "keyed",
  "/toshi.workspace.v1.WebhookService/GetWebhookEndpoint": "read",
  "/toshi.workspace.v1.WebhookService/ListWebhookEndpoints": "read",
  "/toshi.workspace.v1.WebhookService/UpdateWebhookEndpoint": "keyed",
  "/toshi.workspace.v1.WebhookService/DeleteWebhookEndpoint": "keyed",
  "/toshi.workspace.v1.WebhookService/RotateWebhookEndpointSecret": "keyed",
  "/toshi.workspace.v1.WebhookService/ListWebhookDeliveries": "read",
  "/toshi.workspace.v1.WebhookService/ReplayWebhookEvents": "keyed",
  "/toshi.workspace.v1.DisplayService/OpenDisplaySession": "none",
  "/toshi.workspace.v1.DisplayService/GetDisplaySession": "read",
  "/toshi.workspace.v1.DisplayService/ListDisplaySessions": "read",
  "/toshi.workspace.v1.DisplayService/CloseDisplaySession": "none",
  "/toshi.workspace.v1.DisplayService/SendDisplayKeys": "none",
  "/toshi.workspace.v1.DisplayService/SendDisplayPointer": "none",
  "/toshi.workspace.v1.DisplayService/SetDisplayClipboard": "none",
  "/toshi.workspace.v1.DisplayService/TakeDisplayScreenshot": "none",
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
  const random = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  return Math.floor(random * (limit + 1));
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
