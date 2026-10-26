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
