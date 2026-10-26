import { Code, ConnectError } from "@connectrpc/connect";
import type { Transport } from "@connectrpc/connect";

/** The error a call ends with when its timeout fires. */
export function timeoutError(timeoutMs: number): ConnectError {
  return new ConnectError(`the call timed out after ${timeoutMs} ms`, Code.DeadlineExceeded);
}

/** A running deadline: one timer, one signal, and its state for the caller. */
export interface Deadline {
  /** Aborts when the timeout fires or the caller's signal aborts. */
  readonly signal: AbortSignal;
  /** Whether the timeout fired, rather than the caller's signal. */
  readonly timedOut: boolean;
  /** Whether the caller's own signal aborted. */
  readonly callerAborted: boolean;
  /** Stops the timer; safe to call more than once. */
  clear(): void;
}

/** Starts the deadline for a call's timeoutMs, or returns undefined without one. */
export function startDeadline(timeoutMs: number | undefined, caller?: AbortSignal): Deadline | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort(timeoutError(timeoutMs));
  }, timeoutMs);
  return {
    signal: caller === undefined ? controller.signal : AbortSignal.any([controller.signal, caller]),
    get timedOut(): boolean {
      return fired;
    },
    get callerAborted(): boolean {
      return caller?.aborted === true;
    },
    clear(): void {
      clearTimeout(timer);
    },
  };
}

/** Runs body with a deadline signal, and reports the timeout instead of an abort. */
export async function runWithDeadline<O extends { signal?: AbortSignal; timeoutMs?: number }, T>(
  opts: O | undefined,
  body: (opts: O | undefined) => Promise<T>,
): Promise<T> {
  const deadline = startDeadline(opts?.timeoutMs, opts?.signal);
  const withDeadline = (deadline === undefined ? opts : { ...opts, signal: deadline.signal }) as O | undefined;
  try {
    return await body(withDeadline);
  } catch (err) {
    if (deadline?.timedOut === true && !deadline.callerAborted) {
      throw timeoutError(opts?.timeoutMs as number);
    }
    throw err;
  } finally {
    deadline?.clear();
  }
}

/**
 * Gives every unary call defaultTimeoutMs when the caller set no timeout. The
 * Wait calls are long polls: their request's timeout bounds them, so the
 * default skips them. A stream keeps the timeout it was given, so a default
 * never ends a watch.
 */
export function withDefaultUnaryTimeout(transport: Transport, timeoutMs: number | undefined): Transport {
  if (timeoutMs === undefined) {
    return transport;
  }
  const unary = transport.unary.bind(transport);
  return {
    unary: (method, signal, timeout, header, input, contextValues) =>
      unary(method, signal, timeout ?? (isWaitCall(method) ? undefined : timeoutMs), header, input, contextValues),
    stream: transport.stream.bind(transport),
  };
}

// WaitJob, WaitSandbox, WaitService and WaitOperation: the server holds the
// call for the timeout the request names, so a client default would cut it.
function isWaitCall(method: { readonly name: string }): boolean {
  return method.name.startsWith("Wait");
}
