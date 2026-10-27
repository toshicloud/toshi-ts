import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { createToshiClient } from "../src/client.js";
import type { ToshiClient } from "../src/client.js";
import { ProductError, ProductReason, isProductError } from "../src/errors.js";
import type { ExecuteRequest, ExecuteResponse } from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { ProjectService } from "../src/gen/toshi/workspace/v1/projects_pb.js";
import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";

// A google.rpc.ErrorInfo, written field by field: the SDK has no package for
// the googleapis types.
function errorInfo(domain: string, reason: string, metadata: Record<string, string>): Uint8Array {
  const writer = new BinaryWriter();
  writer.tag(1, 2).string(reason);
  writer.tag(2, 2).string(domain);
  for (const [key, value] of Object.entries(metadata)) {
    writer.tag(3, 2).fork().tag(1, 2).string(key).tag(2, 2).string(value).join();
  }
  return writer.finish();
}

function refusal(code: Code, domain: string, reason: string, metadata: Record<string, string>): ConnectError {
  const err = new ConnectError("refused", code);
  err.details.push({ type: "google.rpc.ErrorInfo", value: errorInfo(domain, reason, metadata) });
  return err;
}

function turnedOff(): ConnectError {
  return refusal(Code.FailedPrecondition, "toshi.run", "PRODUCT_TURNED_OFF", {
    product: "acme_ci",
    feature: "acme_ci.enabled",
    switch: "workspace",
  });
}

function clientWith(routes: (router: ConnectRouter) => void): ToshiClient {
  return createToshiClient({
    project: "proj",
    environment: "env",
    retry: false,
    transport: (interceptors: Interceptor[]) => createRouterTransport(routes, { transport: { interceptors } }),
  });
}

function listProjectsRefusing(err: ConnectError): ToshiClient {
  return clientWith((router) => {
    router.service(ProjectService, {
      listProjects() {
        throw err;
      },
    });
  });
}

function failingStream(err: Error): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(err) }),
  };
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("the call did not fail");
}

describe("ProductError", () => {
  const cases: ReadonlyArray<{
    name: string;
    code: Code;
    reason: string;
    metadata: Record<string, string>;
    want: Pick<ProductError, "product" | "reason" | "feature" | "state" | "access">;
  }> = [
    {
      name: "not installed",
      code: Code.Unimplemented,
      reason: "PRODUCT_NOT_INSTALLED",
      metadata: { product: "runners", feature: "runners.enabled", switch: "build" },
      want: { product: "runners", reason: ProductReason.NotInstalled, feature: "runners.enabled", state: "", access: [] },
    },
    {
      name: "disabled while draining",
      code: Code.FailedPrecondition,
      reason: "PRODUCT_DISABLED",
      metadata: { product: "runners", feature: "runners.enabled", switch: "deployment", state: "draining" },
      want: {
        product: "runners",
        reason: ProductReason.Disabled,
        feature: "runners.enabled",
        state: "draining",
        access: [],
      },
    },
    {
      name: "not entitled",
      code: Code.PermissionDenied,
      reason: "PRODUCT_NOT_ENTITLED",
      metadata: { product: "runners", feature: "runners.enabled", switch: "entitlement" },
      want: { product: "runners", reason: ProductReason.NotEntitled, feature: "runners.enabled", state: "", access: [] },
    },
    {
      name: "turned off",
      code: Code.FailedPrecondition,
      reason: "PRODUCT_TURNED_OFF",
      metadata: { product: "acme_ci", feature: "acme_ci.enabled", switch: "workspace" },
      want: { product: "acme_ci", reason: ProductReason.TurnedOff, feature: "acme_ci.enabled", state: "", access: [] },
    },
    {
      name: "access not accepted",
      code: Code.FailedPrecondition,
      reason: "ACCESS_NOT_ACCEPTED",
      metadata: { product: "acme_ci", access: "projects.read,secrets.read" },
      want: {
        product: "acme_ci",
        reason: ProductReason.AccessNotAccepted,
        feature: "",
        state: "",
        access: ["projects.read", "secrets.read"],
      },
    },
  ];

  for (const tc of cases) {
    it(`reads ${tc.name}`, async () => {
      const client = listProjectsRefusing(refusal(tc.code, "toshi.run", tc.reason, tc.metadata));
      const err = await caught(client.project.listProjects({}));
      if (!isProductError(err)) {
        throw new Error(`not a ProductError: ${String(err)}`);
      }
      expect({
        product: err.product,
        reason: err.reason,
        feature: err.feature,
        state: err.state,
        access: err.access,
      }).toEqual(tc.want);
      expect(err).toBeInstanceOf(ConnectError);
      expect(err.code).toBe(tc.code);
      expect(err.rawMessage).toBe("refused");
      expect(err.cause).toBeInstanceOf(ConnectError);
    });
  }

  it("leaves other errors as they are", async () => {
    for (const err of [
      new ConnectError("refused", Code.FailedPrecondition),
      refusal(Code.FailedPrecondition, "example.com", "PRODUCT_TURNED_OFF", { product: "x" }),
      refusal(Code.FailedPrecondition, "toshi.run", "QUOTA_EXCEEDED", { product: "x" }),
    ]) {
      const got = await caught(listProjectsRefusing(err).project.listProjects({}));
      expect(isProductError(got)).toBe(false);
      expect(got).toBeInstanceOf(ConnectError);
      expect(isProductError(new Error("plain"))).toBe(false);
    }
  });

  it("is thrown through wait, watch and execute", async () => {
    const client = clientWith((router) => {
      router.service(WorkloadService, {
        waitJob() {
          throw turnedOff();
        },
        watchJobs() {
          return failingStream(turnedOff());
        },
        execute(requests: AsyncIterable<ExecuteRequest>): AsyncIterable<ExecuteResponse> {
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                await requests[Symbol.asyncIterator]().next();
                throw turnedOff();
              },
            }),
          };
        },
      });
    });

    const waitErr = await caught(client.workload.jobs.wait({ id: "job-1" }));
    expect(isProductError(waitErr) && waitErr.product).toBe("acme_ci");

    const watchErr = await caught(
      (async () => {
        const watch = await client.workload.jobs.watch({ cursor: "c1" });
        for await (const msg of watch) {
          void msg;
        }
      })(),
    );
    expect(isProductError(watchErr) && watchErr.reason).toBe(ProductReason.TurnedOff);

    const executeErr = await caught(client.workload.sandboxes.execute({ sandboxId: "sb-1" }));
    expect(isProductError(executeErr) && executeErr.product).toBe("acme_ci");
  });
});
