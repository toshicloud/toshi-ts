import { abortReason, backoffDelay, isStreamLoss, sleep } from "./retry.js";
import type { RetrySetting } from "./retry.js";

/** The one-reader guard every watch shares. */
export const READER_TAKEN = "toshi: this watch already has a reader";

// watch.go:473-476, output.go:120-127: a stream that ends without its end
// message is a loss, so it is retried like one and reported with Go's wording
// once no attempt remains.
export const streamEnded = new Error("toshi: stream ended without an error");

interface AsyncGeneratorFactory<T> {
  (): AsyncGenerator<T, void, undefined>;
}

// connect's generated client exposes only next() (promise-client.ts:201-215), so
// the watch owns the release: close() aborts the controller, and the reader's
// return() does the same before ending the iteration.
export function createReader<T>(start: AsyncGeneratorFactory<T>, close: () => void): AsyncIterableIterator<T> {
  const generator = start();
  return {
    // Every end, an error included, releases the watch: a rejected next() is
    // not followed by return(), so the caller's abort listener goes here.
    next(): Promise<IteratorResult<T>> {
      return generator.next().then(
        (result) => {
          if (result.done === true) {
            close();
          }
          return result;
        },
        (err: unknown) => {
          close();
          throw err;
        },
      );
    },
    async return(): Promise<IteratorResult<T>> {
      close();
      await generator.return(undefined);
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
      return this;
    },
  };
}

// watch.go:104-118, output.go:74-86: maxAttempts - 1 reconnects in a row, the
// same jittered backoff, and the count reset by every message received. Anything
// that is not a lost stream ends the iteration with that error.
export async function reconnect(
  retry: RetrySetting,
  attempt: number,
  cause: unknown,
  state: WatchState,
): Promise<number> {
  const lost = cause === streamEnded || isStreamLoss(cause);
  if (retry === false || !lost || attempt >= retry.maxAttempts - 1) {
    throw cause;
  }
  await sleep(backoffDelay(retry, attempt), state.signal);
  return attempt + 1;
}

// Owns the AbortController that cancels the open RPC, a pending next() and any
// backoff sleep; close() is the local end, an abort of the caller's signal is an
// error for the caller (watch.go:221-233, output.go:194-206).
export class WatchState {
  /** The caller-visible resume point; the output watch passes "" and ignores it. */
  cursor: string;
  closed = false;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly caller: AbortSignal | undefined;
  private readonly onCallerAbort = (): void => {
    if (this.caller !== undefined) {
      this.controller.abort(abortReason(this.caller));
    }
  };

  constructor(initialCursor: string, caller: AbortSignal | undefined) {
    this.cursor = initialCursor;
    this.caller = caller;
    this.signal = this.controller.signal;
    if (caller !== undefined) {
      if (caller.aborted) {
        this.onCallerAbort();
      } else {
        caller.addEventListener("abort", this.onCallerAbort, { once: true });
      }
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.caller?.removeEventListener("abort", this.onCallerAbort);
    this.controller.abort();
  }
}
