import type { Client } from "@connectrpc/connect";

import type { CallOptions } from "./client.js";
import type { WorkspaceService } from "./gen/toshi/workspace/v1/workspace_pb.js";
import type {
  Operation,
  WaitOperationRequest,
  WaitWorkloadRequest,
  WaitWorkloadResponse,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import { abortReason } from "./retry.js";

/** Asks again while reached is false, and returns the response when it is (wait.go:11-27). */
export async function waitWorkload(
  workspace: Client<typeof WorkspaceService>,
  req: WaitWorkloadRequest,
  opts?: CallOptions,
): Promise<WaitWorkloadResponse> {
  for (;;) {
    throwIfAborted(opts);
    const resp = await workspace.waitWorkload(req, opts);
    if (resp.reached) {
      return resp;
    }
  }
}

/** Asks again while the operation is not done, and returns it when it is (wait.go:29-45). */
export async function waitOperation(
  workspace: Client<typeof WorkspaceService>,
  req: WaitOperationRequest,
  opts?: CallOptions,
): Promise<Operation> {
  for (;;) {
    throwIfAborted(opts);
    const resp = await workspace.waitOperation(req, opts);
    const op = resp.operation;
    if (op !== undefined && op.done) {
      return op;
    }
  }
}

// wait.go:16-18: the caller's context ends the loop with its own error.
function throwIfAborted(opts: CallOptions | undefined): void {
  const signal = opts?.signal;
  if (signal?.aborted === true) {
    throw abortReason(signal);
  }
}
