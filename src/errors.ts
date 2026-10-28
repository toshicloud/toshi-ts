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

/**
 * Why the API refused a call and named the reason: the reason of the
 * refusal's ErrorInfo detail, for a refusal that is not a product's.
 */
export type RefusalReason =
  | "DISPLAY_INPUT_NOT_ENABLED"
  | "IMAGE_BUILD_IN_PROGRESS"
  | "IMAGE_CHECK_FAILED"
  | "IMAGE_IN_USE"
  | "IMAGE_NAME_TAKEN"
  | "IMAGE_NOT_SERVED"
  | "LAST_IDENTITY"
  | "LAST_MEMBER"
  | "LAST_OWNER"
  | "PERMISSION_MISSING"
  | "PLAN_EXCLUDES_IMAGES"
  | "TOSHI_LICENSED_WINDOWS";

/** The reasons the API names on a refusal that is not a product's. */
export const RefusalReason = {
  /** The Windows VM takes no display input; the code is FailedPrecondition. */
  DisplayInputNotEnabled: "DISPLAY_INPUT_NOT_ENABLED",
  /** The image already has a build running; the code is FailedPrecondition. */
  ImageBuildInProgress: "IMAGE_BUILD_IN_PROGRESS",
  /** The registry of the revision's image could not say whether it serves the digest; the code is FailedPrecondition. */
  ImageCheckFailed: "IMAGE_CHECK_FAILED",
  /** A workload or a service revision still uses the image; the code is FailedPrecondition. */
  ImageInUse: "IMAGE_IN_USE",
  /** Another live image of the workspace has the name; the code is AlreadyExists. */
  ImageNameTaken: "IMAGE_NAME_TAKEN",
  /** The revision's registry answered that it does not serve the image digest; the code is FailedPrecondition. */
  ImageNotServed: "IMAGE_NOT_SERVED",
  /** The call would remove the caller's last identity; the code is FailedPrecondition. */
  LastIdentity: "LAST_IDENTITY",
  /** The call would remove the workspace's last member; the code is FailedPrecondition. */
  LastMember: "LAST_MEMBER",
  /** The call would leave the workspace without an owner; the code is FailedPrecondition. */
  LastOwner: "LAST_OWNER",
  /** A role change names a permission the caller does not hold where the role applies; the code is PermissionDenied. */
  PermissionMissing: "PERMISSION_MISSING",
  /** The workspace's plan does not include images; the code is FailedPrecondition. */
  PlanExcludesImages: "PLAN_EXCLUDES_IMAGES",
  /** A Windows job Toshi licenses opens no display session; the code is FailedPrecondition. */
  ToshiLicensedWindows: "TOSHI_LICENSED_WINDOWS",
} as const satisfies Record<string, RefusalReason>;

const refusalReasons: ReadonlySet<string> = new Set(Object.values(RefusalReason));

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
 * The API's refusal that names a reason: an image still in use, a plan
 * without images, a last identity, a rollback whose revision's image is gone,
 * and the rest of {@link RefusalReason}. Every call the client makes throws
 * it in place of the ConnectError. It is a ConnectError, so `instanceof
 * ConnectError` and `code` read as before; test for it with
 * {@link isRefusalError}.
 */
export class RefusalError extends ConnectError {
  readonly reason: RefusalReason;

  constructor(err: ConnectError, reason: RefusalReason) {
    super(err.rawMessage, err.code, err.metadata, undefined, err);
    // ConnectError's instanceof accepts a subclass only by this name.
    this.name = "ConnectError";
    this.details = err.details;
    this.reason = reason;
  }

  // ConnectError's own check would accept any ConnectError.
  static override [Symbol.hasInstance](v: unknown): boolean {
    return Function.prototype[Symbol.hasInstance].call(RefusalError, v);
  }
}

/** Reports whether err is a refusal that names a reason this module knows. */
export function isRefusalError(err: unknown): err is RefusalError {
  return err instanceof RefusalError;
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

/** err as a RefusalError when it is a refusal that names a reason this module knows, and err unchanged otherwise. */
export function asRefusalError(err: unknown): unknown {
  if (!(err instanceof ConnectError) || err instanceof RefusalError) {
    return err;
  }
  for (const detail of err.details) {
    if (!("type" in detail) || detail.type !== "google.rpc.ErrorInfo") {
      continue;
    }
    const info = decodeErrorInfo(detail.value);
    if (info === undefined || info.domain !== errorInfoDomain || !refusalReasons.has(info.reason)) {
      continue;
    }
    return new RefusalError(err, info.reason as RefusalReason);
  }
  return err;
}

/** err as one of this module's typed errors when the API's ErrorInfo detail names a reason it knows, and err unchanged otherwise. */
export function asTypedError(err: unknown): unknown {
  return asRefusalError(asProductError(err));
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
