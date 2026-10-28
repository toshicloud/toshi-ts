import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createToshiClient } from "../src/client.js";
import type { ToshiClient } from "../src/client.js";
import { RefusalError, RefusalReason, isProductError, isRefusalError } from "../src/errors.js";
import { ProjectService } from "../src/gen/toshi/workspace/v1/projects_pb.js";

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

function listProjectsRefusing(err: ConnectError): ToshiClient {
  return createToshiClient({
    project: "proj",
    environment: "env",
    retry: false,
    transport: (interceptors: Interceptor[]) =>
      createRouterTransport(
        (router: ConnectRouter) => {
          router.service(ProjectService, {
            listProjects() {
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

describe("a refusal that names a reason", () => {
  for (const [reason, code, want] of [
    ["DISPLAY_INPUT_NOT_ENABLED", Code.FailedPrecondition, RefusalReason.DisplayInputNotEnabled],
    ["IMAGE_BUILD_IN_PROGRESS", Code.FailedPrecondition, RefusalReason.ImageBuildInProgress],
    ["IMAGE_CHECK_FAILED", Code.FailedPrecondition, RefusalReason.ImageCheckFailed],
    ["IMAGE_IN_USE", Code.FailedPrecondition, RefusalReason.ImageInUse],
    ["IMAGE_NAME_TAKEN", Code.AlreadyExists, RefusalReason.ImageNameTaken],
    ["IMAGE_NOT_SERVED", Code.FailedPrecondition, RefusalReason.ImageNotServed],
    ["LAST_IDENTITY", Code.FailedPrecondition, RefusalReason.LastIdentity],
    ["LAST_MEMBER", Code.FailedPrecondition, RefusalReason.LastMember],
    ["LAST_OWNER", Code.FailedPrecondition, RefusalReason.LastOwner],
    ["PERMISSION_MISSING", Code.PermissionDenied, RefusalReason.PermissionMissing],
    ["PLAN_EXCLUDES_IMAGES", Code.FailedPrecondition, RefusalReason.PlanExcludesImages],
    ["TOSHI_LICENSED_WINDOWS", Code.FailedPrecondition, RefusalReason.ToshiLicensedWindows],
  ] as const) {
    it(`carries the reason ${reason}`, async () => {
      const client = listProjectsRefusing(refusal(code, "toshi.run", reason));
      const err = await caught(client.project.listProjects({}));
      expect(isRefusalError(err)).toBe(true);
      const refused = err as RefusalError;
      expect(refused.reason).toBe(want);
      expect(refused.code).toBe(code);
      expect(err).toBeInstanceOf(ConnectError);
      expect(isProductError(err)).toBe(false);
    });
  }

  it("leaves a reason it does not know as it is", async () => {
    const client = listProjectsRefusing(refusal(Code.FailedPrecondition, "toshi.run", "QUOTA_EXCEEDED"));
    const err = await caught(client.project.listProjects({}));
    expect(isRefusalError(err)).toBe(false);
    expect(err).toBeInstanceOf(ConnectError);
  });
});
