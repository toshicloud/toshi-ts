import { create } from "@bufbuild/protobuf";
import { createClient, createRouterTransport } from "@connectrpc/connect";
import type { ServiceImpl } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import {
  WaitOperationRequestSchema,
  WaitWorkloadRequestSchema,
  WorkspaceService,
} from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { waitOperation, waitWorkload } from "../src/wait.js";

function workspaceWith(impl: Partial<ServiceImpl<typeof WorkspaceService>>) {
  const transport = createRouterTransport((router) => {
    router.service(WorkspaceService, impl);
  });
  return createClient(WorkspaceService, transport);
}

describe("waitWorkload", () => {
  it("calls again while reached is false and returns the reached response", async () => {
    let calls = 0;
    const workspace = workspaceWith({
      waitWorkload() {
        calls += 1;
        return { reached: calls >= 3 };
      },
    });

    const resp = await waitWorkload(
      workspace,
      create(WaitWorkloadRequestSchema, { project: "p", environment: "e", id: "w1" }),
    );

    expect(calls).toBe(3);
    expect(resp.reached).toBe(true);
  });

  it("ends the loop with the signal's error", async () => {
    const controller = new AbortController();
    let calls = 0;
    const workspace = workspaceWith({
      waitWorkload() {
        calls += 1;
        controller.abort(new Error("stop waiting"));
        return { reached: false };
      },
    });

    await expect(
      waitWorkload(workspace, create(WaitWorkloadRequestSchema, { id: "w1" }), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop waiting");
    expect(calls).toBe(1);
  });
});

describe("waitOperation", () => {
  it("calls again while done is false and returns the done operation", async () => {
    let calls = 0;
    const workspace = workspaceWith({
      waitOperation() {
        calls += 1;
        return { operation: { id: "op1", done: calls >= 3 } };
      },
    });

    const operation = await waitOperation(workspace, create(WaitOperationRequestSchema, { id: "op1" }));

    expect(calls).toBe(3);
    expect(operation.id).toBe("op1");
    expect(operation.done).toBe(true);
  });

  it("ends the loop with the signal's error", async () => {
    const controller = new AbortController();
    let calls = 0;
    const workspace = workspaceWith({
      waitOperation() {
        calls += 1;
        controller.abort(new Error("stop waiting"));
        return { operation: { id: "op1", done: false } };
      },
    });

    await expect(
      waitOperation(workspace, create(WaitOperationRequestSchema, { id: "op1" }), {
        signal: controller.signal,
      }),
    ).rejects.toThrow("stop waiting");
    expect(calls).toBe(1);
  });
});
