import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createToshiClient } from "../src/client.js";
import { RollbackImageError, RollbackImageReason, isProductError, isRollbackImageError } from "../src/errors.js";
import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";

// A google.rpc.ErrorInfo, written field by field: the SDK has no package for
// the googleapis types.
function errorInfo(domain: string, reason: string): Uint8Array {
  const writer = new BinaryWriter();
  writer.tag(1, 2).string(reason);
  writer.tag(2, 2).string(domain);
  return writer.finish();
}

function refusal(code: Code, domain: string, reason: string): ConnectError {
  const err = new ConnectError("refused", code);
  err.details.push({ type: "google.rpc.ErrorInfo", value: errorInfo(domain, reason) });
  return err;
}

function rollbackRefusing(err: ConnectError) {
  return createToshiClient({
    project: "proj",
    environment: "env",
    retry: false,
    transport: (interceptors: Interceptor[]) =>
      createRouterTransport(
        (router: ConnectRouter) => {
          router.service(WorkloadService, {
            rollbackService() {
              throw err;
            },
          });
        },
        { transport: { interceptors } },
      ),
  });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("the call did not fail");
}

describe("a rollback's image check refusal", () => {
  for (const [reason, want] of [
    ["IMAGE_NOT_SERVED", RollbackImageReason.ImageNotServed],
    ["IMAGE_CHECK_FAILED", RollbackImageReason.ImageCheckFailed],
  ] as const) {
    it(`carries the reason ${reason}`, async () => {
      const client = rollbackRefusing(refusal(Code.FailedPrecondition, "toshi.run", reason));
      const err = await caught(client.workload.services.rollback({ id: "svc-1", revision: 2n }));
      expect(isRollbackImageError(err)).toBe(true);
      const imageErr = err as RollbackImageError;
      expect(imageErr.reason).toBe(want);
      expect(imageErr.code).toBe(Code.FailedPrecondition);
      expect(err).toBeInstanceOf(ConnectError);
      expect(isProductError(err)).toBe(false);
    });
  }
});
