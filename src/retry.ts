import { Code, ConnectError } from "@connectrpc/connect";
import { getOption } from "@bufbuild/protobuf";
import type { DescMethod } from "@bufbuild/protobuf";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";

import { permission } from "./gen/toshi/permission_pb.js";

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

// A call's retry class comes from the generated descriptors, so a call a new
// API version adds has one without an edit here:
//   - a stream is never retried here (a watch reconnects on its own);
//   - a unary call whose request has a request_key field is "keyed": it is
//     retried with that key, so the server answers a retry with the first
//     result;
//   - a unary call whose toshi.permission level is read is a "read";
//   - every other call is "none".
// The API has no option that marks a call whose retry would answer with an
// error after the first try worked, so such a call is listed below.

/**
 * The calls the rule above gets wrong, each because a retry would report
 * failure for a call that worked. test/retry.test.ts fails when the rule
 * gives one of them its listed class, so the list only holds real exceptions.
 */
export const retryExceptions: Readonly<Record<string, RetryClass>> = {
  // A retry returns the session the first call opened, with replayed set and
  // no token, and opens nothing, so it cannot give the caller a session it
  // can use; its request takes a request_key.
  "/toshi.workspace.v1.DisplayService/OpenDisplaySession": "none",
};

/** The class the descriptors give a call, before the exceptions above. */
export function derivedRetryClass(method: DescMethod): RetryClass {
  if (method.methodKind !== "unary") {
    return "none";
  }
  if (method.input.fields.some((field) => field.name === "request_key")) {
    return "keyed";
  }
  return getOption(method, permission).endsWith(".read") ? "read" : "none";
}

/** The retry class of a call: an exception's, else the one the descriptors give it. */
export function retryClassFor(method: DescMethod): RetryClass {
  return retryExceptions[procedurePath(method.parent, method)] ?? derivedRetryClass(method);
}

/** The `/<service typeName>/<method name>` path a call is sent to. */
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
