import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import { ConnectError } from "@connectrpc/connect";
import type { ExecutionExit, OutputEnd } from "./gen/toshi/workspace/v1/workspace_pb.js";

/** A command that ended non-zero, or was cancelled before it had a status (errors.go:9-26). */
export class ExitError extends Error {
  /** The execution the exit belongs to. */
  readonly executionId: string;
  /** The execution's exit message. */
  readonly exit: ExecutionExit;

  constructor(executionId: string, exit: ExecutionExit) {
    super(exitMessage(executionId, exit));
    this.name = "ExitError";
    this.executionId = executionId;
    this.exit = exit;
  }
}

/** A job `run` started that did not exit 0. */
export class JobExitError extends Error {
  /** The job's id. */
  readonly jobId: string;
  /** The job's end-of-output message. */
  readonly end: OutputEnd;

  constructor(jobId: string, end: OutputEnd) {
    super(jobMessage(jobId, end));
    this.name = "JobExitError";
    this.jobId = jobId;
    this.end = end;
  }
}

function jobMessage(jobId: string, end: OutputEnd): string {
  if (end.cancelled) {
    return `toshi: job ${jobId} was cancelled`;
  }
  if (end.exitCode === undefined) {
    return `toshi: job ${jobId} ended without an exit status`;
  }
  return `toshi: job ${jobId} exited with status ${end.exitCode}`;
}

function exitMessage(executionId: string, exit: ExecutionExit): string {
  if (exit.cancelled) {
    return `toshi: execution ${executionId} was cancelled`;
  }
  if (exit.exitCode === undefined) {
    return `toshi: execution ${executionId} ended without an exit status`;
  }
  return `toshi: execution ${executionId} exited with status ${exit.exitCode}`;
}

/**
 * An Execute stream that ended before its exit message; stdin cannot be replayed
 * (errors.go:28-49). The cause is the error that ended the stream.
 */
export class StreamLostError extends Error {
  /** Empty when the stream was lost before the start was acknowledged. */
  readonly executionId: string;
  /** The request key of the start, so the caller may start again deliberately. */
  readonly requestKey: string;

  constructor(executionId: string, requestKey: string, cause?: unknown) {
    super(lostMessage(executionId, requestKey, cause), cause === undefined ? undefined : { cause });
    this.name = "StreamLostError";
    this.executionId = executionId;
    this.requestKey = requestKey;
  }
}

function lostMessage(executionId: string, requestKey: string, cause: unknown): string {
  const detail = cause === undefined ? "" : `: ${describe(cause)}`;
  if (executionId === "") {
    return `toshi: execution stream lost before the start was acknowledged (request key ${requestKey})${detail}`;
  }
  return `toshi: execution ${executionId} stream lost (request key ${requestKey})${detail}`;
}

// The way Go's %v would print it, without stringifying an object as [object Object].
function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  if (typeof cause === "string" || typeof cause === "number" || typeof cause === "boolean") {
    return String(cause);
  }
  return "the stream ended";
}

/** Why the API refused a call for a product: the reason of the refusal's ErrorInfo detail. */
export type ProductReason =
  | "PRODUCT_NOT_INSTALLED"
  | "PRODUCT_DISABLED"
  | "PRODUCT_NOT_ENTITLED"
  | "PRODUCT_TURNED_OFF"
  | "ACCESS_NOT_ACCEPTED";

/** The reasons a call is refused for a product. */
export const ProductReason = {
  /** The deployment's build does not include the product; the code is Unimplemented. */
  NotInstalled: "PRODUCT_NOT_INSTALLED",
  /** The deployment turned the product off; the code is FailedPrecondition. */
  Disabled: "PRODUCT_DISABLED",
  /** The workspace's entitlements leave the product out; the code is PermissionDenied. */
  NotEntitled: "PRODUCT_NOT_ENTITLED",
  /**
   * The workspace's settings turn the product off, or an outside product's
   * installation is turned off; the code is FailedPrecondition.
   */
  TurnedOff: "PRODUCT_TURNED_OFF",
  /**
   * Turning an outside product on installs it, and the call did not accept the
   * access it asks for; the code is FailedPrecondition.
   */
  AccessNotAccepted: "ACCESS_NOT_ACCEPTED",
} as const satisfies Record<string, ProductReason>;

const productReasons: ReadonlySet<string> = new Set(Object.values(ProductReason));

/** Why a rollback's image check refused it: the reason of the refusal's ErrorInfo detail. */
export type RollbackImageReason = "IMAGE_NOT_SERVED" | "IMAGE_CHECK_FAILED";

/** The reasons RollbackService's image check refuses a rollback. */
export const RollbackImageReason = {
  /** The revision's registry answered that it does not serve the image digest; the code is FailedPrecondition. */
  ImageNotServed: "IMAGE_NOT_SERVED",
  /** The registry could not be reached, refused the login or failed; the code is FailedPrecondition. */
  ImageCheckFailed: "IMAGE_CHECK_FAILED",
} as const satisfies Record<string, RollbackImageReason>;

const rollbackImageReasons: ReadonlySet<string> = new Set(Object.values(RollbackImageReason));

// The ErrorInfo domain of the API's refusals.
const errorInfoDomain = "toshi.run";

/**
 * The API's refusal of a call for a product: one that is off for the
 * workspace, or an outside product whose access the call did not accept.
 * Every call the client makes throws it in place of the ConnectError, wait,
 * watch and execute included. It is a ConnectError, so `instanceof
 * ConnectError` and `code` read as before; test for it with
 * {@link isProductError}.
 */
export class ProductError extends ConnectError {
  /** The product's ID, such as `runners`. */
  readonly product: string;
  readonly reason: ProductReason;
  /** The setting that turns the product on, such as `runners.enabled`; empty for ACCESS_NOT_ACCEPTED. */
  readonly feature: string;
  /** How far a product the deployment disables has wound down: `no_new_work`, `draining` or `stopped`; empty otherwise. */
  readonly state: string;
  /** The access an outside product asks for, for ACCESS_NOT_ACCEPTED: accept exactly this list to install it. */
  readonly access: string[];

  constructor(err: ConnectError, reason: ProductReason, metadata: ReadonlyMap<string, string>) {
    super(err.rawMessage, err.code, err.metadata, undefined, err);
    // ConnectError's instanceof accepts a subclass only by this name.
    this.name = "ConnectError";
    this.details = err.details;
    this.product = metadata.get("product") ?? "";
    this.reason = reason;
    this.feature = metadata.get("feature") ?? "";
    this.state = metadata.get("state") ?? "";
    const access = metadata.get("access") ?? "";
    this.access = access === "" ? [] : access.split(",");
  }

  // ConnectError's own check would accept any ConnectError.
  static override [Symbol.hasInstance](v: unknown): boolean {
    return Function.prototype[Symbol.hasInstance].call(ProductError, v);
  }
}

/** Reports whether err is a product's refusal. */
export function isProductError(err: unknown): err is ProductError {
  return err instanceof ProductError;
}

/**
 * RollbackService's refusal by the check of the revision's image: the
 * registry does not serve it, or could not say. It is a ConnectError, so
 * `instanceof ConnectError` and `code` read as before; test for it with
 * {@link isRollbackImageError}.
 */
export class RollbackImageError extends ConnectError {
  readonly reason: RollbackImageReason;

  constructor(err: ConnectError, reason: RollbackImageReason) {
    super(err.rawMessage, err.code, err.metadata, undefined, err);
    // ConnectError's instanceof accepts a subclass only by this name.
    this.name = "ConnectError";
    this.details = err.details;
    this.reason = reason;
  }

  // ConnectError's own check would accept any ConnectError.
  static override [Symbol.hasInstance](v: unknown): boolean {
    return Function.prototype[Symbol.hasInstance].call(RollbackImageError, v);
  }
}

/** Reports whether err is a rollback's refusal by its image check. */
export function isRollbackImageError(err: unknown): err is RollbackImageError {
  return err instanceof RollbackImageError;
}

/** err as a ProductError when it is a product's refusal, and err unchanged otherwise. */
export function asProductError(err: unknown): unknown {
  if (!(err instanceof ConnectError) || err instanceof ProductError) {
    return err;
  }
  for (const detail of err.details) {
    if (!("type" in detail) || detail.type !== "google.rpc.ErrorInfo") {
      continue;
    }
    const info = decodeErrorInfo(detail.value);
    if (info === undefined || info.domain !== errorInfoDomain || !productReasons.has(info.reason)) {
      continue;
    }
    return new ProductError(err, info.reason as ProductReason, info.metadata);
  }
  return err;
}

/** err as a RollbackImageError when it is a rollback's refusal by its image check, and err unchanged otherwise. */
export function asRollbackImageError(err: unknown): unknown {
  if (!(err instanceof ConnectError) || err instanceof RollbackImageError) {
    return err;
  }
  for (const detail of err.details) {
    if (!("type" in detail) || detail.type !== "google.rpc.ErrorInfo") {
      continue;
    }
    const info = decodeErrorInfo(detail.value);
    if (info === undefined || info.domain !== errorInfoDomain || !rollbackImageReasons.has(info.reason)) {
      continue;
    }
    return new RollbackImageError(err, info.reason as RollbackImageReason);
  }
  return err;
}

/** err as one of this module's typed errors when the API's ErrorInfo detail names a reason it knows, and err unchanged otherwise. */
export function asTypedError(err: unknown): unknown {
  return asRollbackImageError(asProductError(err));
}

interface ErrorInfo {
  reason: string;
  domain: string;
  metadata: Map<string, string>;
}

/**
 * Reads a google.rpc.ErrorInfo message: reason (1), domain (2) and metadata
 * (3), a map of strings. It reads the wire format itself, so the SDK needs no
 * package for the googleapis types.
 */
function decodeErrorInfo(bytes: Uint8Array): ErrorInfo | undefined {
  const info: ErrorInfo = { reason: "", domain: "", metadata: new Map() };
  try {
    const reader = new BinaryReader(bytes);
    while (reader.pos < reader.len) {
      const [field, wireType] = reader.tag();
      if (wireType !== WireType.LengthDelimited) {
        reader.skip(wireType);
        continue;
      }
      switch (field) {
        case 1:
          info.reason = reader.string();
          break;
        case 2:
          info.domain = reader.string();
          break;
        case 3: {
          const [key, value] = decodeMapEntry(reader.bytes());
          info.metadata.set(key, value);
          break;
        }
        default:
          reader.skip(wireType);
      }
    }
  } catch {
    return undefined;
  }
  return info;
}

/** Reads one entry of a map<string, string>: key (1), value (2). */
function decodeMapEntry(bytes: Uint8Array): [string, string] {
  let key = "";
  let value = "";
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [field, wireType] = reader.tag();
    if (wireType === WireType.LengthDelimited && field === 1) {
      key = reader.string();
    } else if (wireType === WireType.LengthDelimited && field === 2) {
      value = reader.string();
    } else {
      reader.skip(wireType);
    }
  }
  return [key, value];
}
