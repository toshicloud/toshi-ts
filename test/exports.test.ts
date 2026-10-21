import { describe, expect, it } from "vitest";
import type { DescMethod, DescService } from "@bufbuild/protobuf";
import * as root from "../src/index.js";

/** The part of a service descriptor this test reads; MethodKind is a string literal in Protobuf-ES v2. */
type ServiceLike = Pick<DescService, "typeName" | "methods">;

function requireMethod(service: ServiceLike, localName: string): DescMethod {
  const method = service.methods.find((candidate) => candidate.localName === localName);
  if (method === undefined) {
    throw new Error(`${service.typeName} has no method ${localName}`);
  }
  return method;
}

const services: ReadonlyArray<readonly [ServiceLike, string, number]> = [
  [root.WorkspaceService, "toshi.workspace.v1.WorkspaceService", 21],
  [root.ProjectService, "toshi.workspace.v1.ProjectService", 9],
  [root.SecretService, "toshi.workspace.v1.SecretService", 10],
  [root.WebhookService, "toshi.workspace.v1.WebhookService", 8],
  [root.DisplayService, "toshi.workspace.v1.DisplayService", 8],
];

describe("src/index.ts", () => {
  for (const [service, typeName, methodCount] of services) {
    it(`re-exports ${typeName} with ${methodCount} methods`, () => {
      expect(service.typeName).toBe(typeName);
      expect(service.methods).toHaveLength(methodCount);
    });
  }

  it("marks Execute as bidirectional streaming", () => {
    expect(requireMethod(root.WorkspaceService, "execute").methodKind).toBe("bidi_streaming");
  });

  it("marks the watch RPCs as server streaming", () => {
    for (const localName of ["watchWorkloads", "watchOutput", "watchEvents"]) {
      expect(requireMethod(root.WorkspaceService, localName).methodKind).toBe("server_streaming");
    }
  });
});
