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
  [root.WorkloadService, "toshi.workspace.v1.WorkloadService", 41],
  [root.ProjectService, "toshi.workspace.v1.ProjectService", 12],
  [root.SecretService, "toshi.workspace.v1.SecretService", 10],
  [root.WebhookService, "toshi.workspace.v1.WebhookService", 8],
  [root.DisplayService, "toshi.workspace.v1.DisplayService", 8],
  [root.ChannelService, "toshi.workspace.v1.ChannelService", 13],
  [root.RecordingService, "toshi.workspace.v1.RecordingService", 5],
  [root.VolumeService, "toshi.workspace.v1.VolumeService", 3],
  [root.ArtifactService, "toshi.workspace.v1.ArtifactService", 3],
  [root.ArtifactUploadService, "toshi.workspace.v1.ArtifactUploadService", 2],
];

describe("src/index.ts", () => {
  for (const [service, typeName, methodCount] of services) {
    it(`re-exports ${typeName} with ${methodCount} methods`, () => {
      expect(service.typeName).toBe(typeName);
      expect(service.methods).toHaveLength(methodCount);
    });
  }

  it("marks Execute as bidirectional streaming", () => {
    expect(requireMethod(root.WorkloadService, "execute").methodKind).toBe("bidi_streaming");
  });

  it("marks the watch RPCs as server streaming", () => {
    for (const localName of [
      "watchJobs",
      "watchSandboxes",
      "watchServices",
      "watchOutput",
      "watchEvents",
      "watchTelemetry",
      "watchGuestLog",
    ]) {
      expect(requireMethod(root.WorkloadService, localName).methodKind).toBe("server_streaming");
    }
  });
});
