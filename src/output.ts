import { clone } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";

import type { CallOptions, OutputWatch } from "./client.js";
import { WatchOutputRequestSchema } from "./gen/toshi/workspace/v1/workspace_pb.js";
import type {
  WatchOutputRequest,
  WatchOutputResponse,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import type { WorkloadService } from "./gen/toshi/workspace/v1/workloads_pb.js";
import type { RetrySetting } from "./retry.js";
import { READER_TAKEN, WatchState, createReader, reconnect, streamEnded } from "./stream.js";
import { timeoutError } from "./timeout.js";

/** Starts an output watch at the request's offsets, counting the bytes it hands out (output.go:14-52). */
export function openOutputWatch(
  service: Client<typeof WorkloadService>,
  retry: RetrySetting,
  req: WatchOutputRequest,
  opts?: CallOptions,
): Promise<OutputWatch> {
  const state = new WatchState("", opts?.signal, opts?.timeoutMs);
  const request = clone(WatchOutputRequestSchema, req);
  let stdout = req.stdoutOffset;
  let stderr = req.stderrOffset;

  async function* run(): AsyncGenerator<WatchOutputResponse, void, undefined> {
    let attempt = 0;
    try {
      for (;;) {
        if (state.closed) {
          return;
        }
        let cause: unknown;
        try {
          request.stdoutOffset = stdout;
          request.stderrOffset = stderr;
          const stream = service.watchOutput(request, { signal: state.signal });
          for await (const msg of stream) {
            state.markOpen();
            attempt = 0;
            if (msg.message.case === "end") {
              // output.go:157-160: release the RPC before the caller sees the
              // end message, and never reopen after it.
              state.close();
              yield msg;
              return;
            }
            if (msg.message.case === "stdout") {
              stdout += BigInt(msg.message.value.length);
            } else if (msg.message.case === "stderr") {
              stderr += BigInt(msg.message.value.length);
            }
            yield msg;
          }
          if (state.closed) {
            return;
          }
          cause = streamEnded;
        } catch (err) {
          if (state.closed) {
            return;
          }
          if (state.timedOut) {
            throw timeoutError(state.timeoutMs as number);
          }
          cause = err;
        }
        attempt = await reconnect(retry, attempt, cause, state);
      }
    } catch (err) {
      if (state.closed) {
        return;
      }
      throw err;
    }
  }

  let reader: AsyncIterableIterator<WatchOutputResponse> | undefined;
  const watch: OutputWatch = {
    get offsets(): { readonly stdout: bigint; readonly stderr: bigint } {
      return { stdout, stderr };
    },
    close(): void {
      state.close();
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<WatchOutputResponse> {
      if (reader !== undefined) {
        throw new Error(READER_TAKEN);
      }
      reader = createReader(run, () => state.close());
      return reader;
    },
  };
  return Promise.resolve(watch);
}
