import { create } from "@bufbuild/protobuf";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Client } from "@connectrpc/connect";
import { createWritableIterable } from "@connectrpc/connect/protocol";
import type { WritableIterable } from "@connectrpc/connect/protocol";
import type { CallOptions, OutputChunk, Process } from "./client.js";
import { ExitError, StreamLostError } from "./errors.js";
import { isStreamLoss } from "./retry.js";
import {
  ExecuteRequestSchema,
  ExecuteStartSchema,
  type ExecuteResponse,
  type ExecuteStart,
  type ExecutionExit,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import type { WorkloadService } from "./gen/toshi/workspace/v1/workloads_pb.js";

// The largest standard-input frame Execute sends (execute.go:14-16).
const STDIN_CHUNK = 64 << 10;

const BROWSER_MESSAGE =
  'toshi: Execute needs a Node transport over HTTP/2 (@connectrpc/connect-node with httpVersion "2"); a browser cannot open a bidirectional stream';

/** Starts a command and returns its process; the only export of this module. */
export async function executeCommand(
  service: Client<typeof WorkloadService>,
  start: MessageInitShape<typeof ExecuteStartSchema> | undefined,
  opts?: CallOptions,
): Promise<Process> {
  // G3: the browser check runs before any message or transport work, and reads
  // process only through globalThis so src/ needs no Node import.
  const nodeProcess = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (typeof nodeProcess?.versions?.node !== "string") {
    throw new Error(BROWSER_MESSAGE);
  }
  if (start == null) {
    throw new Error("toshi: Execute needs a start message");
  }
  const startMessage = create(ExecuteStartSchema, start);

  const abort = new AbortController();
  const signal = opts?.signal;
  const requests = createWritableIterable<MessageInitShape<typeof ExecuteRequestSchema>>();
  const requestIterator = requests[Symbol.asyncIterator]();
  const input: AsyncIterable<MessageInitShape<typeof ExecuteRequestSchema>> = {
    [Symbol.asyncIterator]: () => requestIterator,
  };

  // The handshake and, after it, the process both answer to the caller's signal.
  const owner: { process?: ExecuteProcess } = {};
  const onAbort = (): void => {
    if (owner.process === undefined) {
      abort.abort();
      return;
    }
    owner.process.cancel();
  };
  // A signal that is already aborted starts nothing.
  if (signal?.aborted === true) {
    throw cancelledError();
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  const finishHandshake = (): void => {
    signal?.removeEventListener("abort", onAbort);
  };

  const responses = service.execute(input, { signal: abort.signal });
  const responseIterator = responses[Symbol.asyncIterator]();
  // Send the start and read the answer together: the request stream only moves
  // while the call is running. The created message is the one the interceptors
  // fill with scope and key, as fillRequestKey does (execute.go:26-27).
  const startRequest: MessageInitShape<typeof ExecuteRequestSchema> = {
    message: { case: "start", value: startMessage },
  };

  let first: IteratorResult<ExecuteResponse>;
  try {
    const firstRead = responseIterator.next();
    void firstRead.catch(() => undefined);
    // The write resolves only once the request stream is read past the frame,
    // and a server may answer the start without reading again, so both are
    // awaited together: the first answer is the start's acknowledgement.
    const startSent = requests.write(startRequest);
    first = await Promise.race([firstRead, startSent.then(() => firstRead)]);
    // A failure after the first answer is the stream's loss, reported by the
    // output reader, not by the start's write.
    void startSent.catch(() => undefined);
  } catch (err) {
    finishHandshake();
    closeRequest(requestIterator, err);
    closeResponse(responseIterator);
    abort.abort();
    // A caller's own abort is a cancellation, not a lost server stream.
    if (signal !== undefined && signal.aborted) {
      throw cancelledError();
    }
    throw beforeStarted(err, readRequestKey(startMessage));
  }

  const message = first.done === true ? undefined : first.value.message;
  if (message === undefined || message.case !== "started") {
    const failure =
      message === undefined
        ? new StreamLostError(
            "",
            readRequestKey(startMessage),
            new Error("toshi: the Execute stream ended before its started message"),
          )
        : new Error("toshi: the Execute stream did not answer with a started message");
    finishHandshake();
    closeRequest(requestIterator, failure);
    closeResponse(responseIterator);
    abort.abort();
    throw failure;
  }

  const process = new ExecuteProcess(
    message.value.executionId,
    readRequestKey(startMessage),
    requests,
    requestIterator,
    responseIterator,
    abort,
    signal,
    onAbort,
  );
  owner.process = process;
  return process;
}

/** What ended the process; set once, never cleared. */
type Terminal =
  | { readonly kind: "exit"; readonly exit: ExecutionExit; readonly error: ExitError | undefined }
  | { readonly kind: "lost"; readonly error: StreamLostError }
  | { readonly kind: "cancelled"; readonly error: ConnectError };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (value: T) => settle(value) };
}

function cancelledError(): ConnectError {
  return new ConnectError("the call was cancelled", Code.Canceled);
}

/**
 * Before started, a ConnectError is the server's answer and goes back
 * unchanged; anything else is a lost stream (execute.go:30-46).
 */
function beforeStarted(err: unknown, requestKey: string): Error {
  if (err instanceof ConnectError && !isStreamLoss(err)) {
    return err;
  }
  return new StreamLostError("", requestKey, err);
}

/** The key the start carried, including one the client's interceptor filled. */
function readRequestKey(start: ExecuteStart): string {
  return start.requestKey;
}

function closeRequest(iterator: AsyncIterator<unknown>, reason: unknown): void {
  try {
    void iterator.throw?.(reason)?.catch(() => undefined);
  } catch {
    // the request stream is already gone
  }
}

function closeResponse(iterator: AsyncIterator<unknown>): void {
  try {
    void iterator.return?.()?.catch(() => undefined);
  } catch {
    // the response stream is already gone
  }
}

/**
 * One execution started by Execute. It reads the response only when its output
 * is pulled or wait() drains it, so a stalled reader stalls the server's
 * stream rather than buffering without bound.
 */
class ExecuteProcess implements Process {
  readonly executionId: string;
  readonly requestKey: string;

  private readonly requests: WritableIterable<MessageInitShape<typeof ExecuteRequestSchema>>;
  private readonly requestIterator: AsyncIterator<MessageInitShape<typeof ExecuteRequestSchema>>;
  private readonly responses: AsyncIterator<ExecuteResponse>;
  private readonly abort: AbortController;
  private readonly signal: AbortSignal | undefined;
  private readonly onSignalAbort: () => void;
  private readonly terminalSignal = deferred<void>();
  private readonly queue: OutputChunk[] = [];
  private terminal: Terminal | undefined;
  private readerOwned = false;
  private waitPromise: Promise<void> | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private writing = false;
  private stdinClosed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    executionId: string,
    requestKey: string,
    requests: WritableIterable<MessageInitShape<typeof ExecuteRequestSchema>>,
    requestIterator: AsyncIterator<MessageInitShape<typeof ExecuteRequestSchema>>,
    responses: AsyncIterator<ExecuteResponse>,
    abort: AbortController,
    signal: AbortSignal | undefined,
    onSignalAbort: () => void,
  ) {
    this.executionId = executionId;
    this.requestKey = requestKey;
    this.requests = requests;
    this.requestIterator = requestIterator;
    this.responses = responses;
    this.abort = abort;
    this.signal = signal;
    this.onSignalAbort = onSignalAbort;
    if (signal?.aborted === true) {
      this.cancel();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<OutputChunk> {
    if (this.readerOwned) {
      throw new Error("toshi: this process already has an output reader");
    }
    this.readerOwned = true;
    return {
      next: () => this.pull(),
      // A break aborts the local stream; wait() then reports Canceled.
      return: () => {
        this.cancel();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  /**
   * Sends stdin in frames of at most 64 KiB and resolves once the last frame
   * was consumed. One write at a time: a write while another is pending is
   * refused, so the client holds at most one caller buffer and one frame.
   */
  write(data: Uint8Array | string): Promise<void> {
    if (this.terminal !== undefined) {
      return Promise.reject(this.closedReason());
    }
    if (this.stdinClosed) {
      return Promise.reject(new Error("toshi: standard input is closed"));
    }
    if (this.writing) {
      return Promise.reject(new Error("toshi: a write is still pending; await it before writing again"));
    }
    this.writing = true;
    const run = (typeof data === "string" ? this.sendText(data) : this.sendFrames(data)).finally(() => {
      this.writing = false;
    });
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  /** Sends close_stdin once, after a pending write; later writes are refused (execute.go:243-256). */
  closeStdin(): Promise<void> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    this.stdinClosed = true;
    const run = this.writeChain.then(() => {
      if (this.terminal !== undefined) {
        return;
      }
      // Not awaited: the frame is consumed only when the request stream is read
      // past it, and the server stops reading after close_stdin.
      const sent = this.requests.write({ message: { case: "closeStdin", value: true } });
      void sent.catch(() => undefined);
    });
    this.closePromise = run;
    return run;
  }

  /** The process's outcome; the same promise on every call. */
  wait(): Promise<void> {
    this.waitPromise ??= this.awaitOutcome();
    return this.waitPromise;
  }

  /** Ends the process as cancelled: early break and an aborted call signal. */
  cancel(): void {
    this.finish({ kind: "cancelled", error: cancelledError() });
  }

  private async sendFrames(bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < bytes.length; offset += STDIN_CHUNK) {
      const end = Math.min(offset + STDIN_CHUNK, bytes.length);
      // Copied, as the sender copies each chunk (execute.go:227).
      const frame = bytes.slice(offset, end);
      await this.requests.write({ message: { case: "stdin", value: frame } });
    }
  }
  // Encodes one frame at a time, so a long string is never copied whole.
  private async sendText(text: string): Promise<void> {
    const encoder = new TextEncoder();
    let rest = text;
    while (rest.length > 0) {
      const frame = new Uint8Array(STDIN_CHUNK);
      const { read, written } = encoder.encodeInto(rest, frame);
      rest = rest.slice(read);
      await this.requests.write({ message: { case: "stdin", value: frame.subarray(0, written) } });
    }
  }


  private async awaitOutcome(): Promise<void> {
    if (!this.readerOwned && this.terminal === undefined) {
      // No reader owns the output: take it and drain it, so wait() never stalls on unread output.
      this.readerOwned = true;
      try {
        for (;;) {
          const result = await this.pull();
          if (result.done === true) {
            break;
          }
        }
      } catch {
        // pull() recorded the terminal outcome; it is reported below.
      }
    }
    await this.terminalSignal.promise;
    const terminal = this.terminal;
    if (terminal === undefined) {
      throw cancelledError();
    }
    switch (terminal.kind) {
      case "exit":
        if (terminal.error !== undefined) {
          throw terminal.error;
        }
        return;
      default:
        throw terminal.error;
    }
  }

  private async pull(): Promise<IteratorResult<OutputChunk>> {
    for (;;) {
      const chunk = this.queue.shift();
      if (chunk !== undefined) {
        return { done: false, value: chunk };
      }
      if (this.terminal !== undefined) {
        return this.terminalResult();
      }
      await this.readOne();
    }
  }

  private terminalResult(): IteratorResult<OutputChunk> {
    const terminal = this.terminal;
    if (terminal === undefined || terminal.kind === "exit") {
      return { done: true, value: undefined };
    }
    throw terminal.error;
  }

  private async readOne(): Promise<void> {
    const next = this.responses.next();
    // Losing the race must not leave an unhandled rejection behind: both
    // branches below are attached before the race settles.
    const raced = await Promise.race([
      next.then(
        (result) => ({ kind: "message" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      this.terminalSignal.promise.then(() => ({ kind: "terminal" as const })),
    ]);
    if (raced.kind === "terminal") {
      return;
    }
    if (raced.kind === "error") {
      // After started, every end before the exit message is a lost stream
      // (execute.go:113-118).
      this.finish({ kind: "lost", error: this.lost(raced.error) });
      return;
    }
    if (raced.result.done === true) {
      this.finish({
        kind: "lost",
        error: this.lost(new Error("toshi: the Execute stream ended without an exit message")),
      });
      return;
    }
    this.handle(raced.result.value);
  }

  private handle(response: ExecuteResponse): void {
    const message = response.message;
    switch (message.case) {
      case "stdout":
        this.queue.push({ stream: "stdout", data: message.value });
        return;
      case "stderr":
        this.queue.push({ stream: "stderr", data: message.value });
        return;
      case "exit":
        this.finishExit(message.value);
        return;
      default:
        // A repeated started is ignored, as the receive switch does (execute.go:107-127).
        return;
    }
  }

  private lost(cause: unknown): StreamLostError {
    return new StreamLostError(this.executionId, this.requestKey, cause);
  }

  private finishExit(exit: ExecutionExit): void {
    // Only a zero exit code is success; an absent one never is (execute.go:197-204).
    const ok = exit.exitCode === 0;
    this.finish({
      kind: "exit",
      exit,
      error: ok ? undefined : new ExitError(this.executionId, exit),
    });
  }

  private finish(terminal: Terminal): void {
    if (this.terminal !== undefined) {
      return;
    }
    this.terminal = terminal;
    this.terminalSignal.resolve();
    if (this.signal !== undefined) {
      this.signal.removeEventListener("abort", this.onSignalAbort);
    }
    // Closing the request side rejects pending writes (execute.go:131-151).
    closeRequest(this.requestIterator, this.closedReason());
    this.abort.abort();
    closeResponse(this.responses);
  }

  private closedReason(): Error {
    const terminal = this.terminal;
    if (terminal === undefined) {
      return cancelledError();
    }
    if (terminal.kind === "exit") {
      return terminal.error ?? new Error("toshi: the execution has ended");
    }
    return terminal.error;
  }
}
