import type { Client } from "@connectrpc/connect";

import type { CallOptions } from "./client.js";
import type { WorkloadService } from "./gen/toshi/workspace/v1/workloads_pb.js";
import type {
  WaitJobRequest,
  WaitJobResponse,
  WaitSandboxRequest,
  WaitSandboxResponse,
  WaitServiceRequest,
  WaitServiceResponse,
} from "./gen/toshi/workspace/v1/workloads_pb.js";
import type { Operation, WaitOperationRequest } from "./gen/toshi/workspace/v1/workspace_pb.js";
import { abortReason } from "./retry.js";
import { runWithDeadline } from "./timeout.js";

/** Asks again while the job is not in a state it waits for, and returns the answer when it is. */
export function waitJob(
  service: Client<typeof WorkloadService>,
  req: WaitJobRequest,
  opts?: CallOptions,
): Promise<WaitJobResponse> {
  return runWithDeadline(opts, (callOpts) => waitReached((o) => service.waitJob(req, o), callOpts));
}

/** Asks again while the sandbox is not in a state it waits for. */
export function waitSandbox(
  service: Client<typeof WorkloadService>,
  req: WaitSandboxRequest,
  opts?: CallOptions,
): Promise<WaitSandboxResponse> {
  return runWithDeadline(opts, (callOpts) => waitReached((o) => service.waitSandbox(req, o), callOpts));
}

/** Asks again while the service is not in a state it waits for. */
export function waitService(
  service: Client<typeof WorkloadService>,
  req: WaitServiceRequest,
  opts?: CallOptions,
): Promise<WaitServiceResponse> {
  return runWithDeadline(opts, (callOpts) => waitReached((o) => service.waitService(req, o), callOpts));
}

/** Asks again while the operation is not done, and returns it when it is (wait.go:29-45). */
export function waitOperation(
  service: Client<typeof WorkloadService>,
  req: WaitOperationRequest,
  opts?: CallOptions,
): Promise<Operation> {
  return runWithDeadline(opts, async (callOpts) => {
    for (;;) {
      throwIfAborted(callOpts);
      const resp = await service.waitOperation(req, callOpts);
      const op = resp.operation;
      if (op !== undefined && op.done) {
        return op;
      }
    }
  });
}

// The three waits share one loop: each answers reached when the state arrived.
async function waitReached<Resp extends { readonly reached: boolean }>(
  call: (opts: CallOptions | undefined) => Promise<Resp>,
  opts: CallOptions | undefined,
): Promise<Resp> {
  for (;;) {
    throwIfAborted(opts);
    const resp = await call(opts);
    if (resp.reached) {
      return resp;
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
