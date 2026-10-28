import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";

import { createFake } from "../src/test/index.js";
import { VolumeService } from "../src/gen/toshi/workspace/v1/volumes_pb.js";

const saved = new Date("2026-10-28T08:00:00Z");

describe("volume versions", () => {
  it("lists a volume's versions newest first and restores one", async () => {
    const fake = createFake();
    fake.on(VolumeService.method.listVolumes, () =>
      Promise.resolve({
        volumes: [{ id: "vol-1", name: "cache", latestVersion: 2n, latestVersionTime: timestampFromDate(saved) }],
      }),
    );
    fake.on(VolumeService.method.listVolumeVersions, (request) => {
      expect(request.volumeId).toBe("vol-1");
      if (request.pageToken === "") {
        return Promise.resolve({
          versions: [
            { number: 2n, createTime: timestampFromDate(saved), sizeBytes: 4096n, sha256: "0f1e", restoredFrom: 1n },
          ],
          nextPageToken: "page-2",
        });
      }
      return Promise.resolve({
        versions: [{ number: 1n, createTime: timestampFromDate(new Date("2026-10-28T07:00:00Z")), sizeBytes: 2048n }],
      });
    });
    fake.on(VolumeService.method.restoreVolume, (request) => {
      expect(request.volumeId).toBe("vol-1");
      expect(request.version).toBe(1n);
      return Promise.resolve({
        version: { number: 3n, restoredFrom: 1n, sizeBytes: 2048n },
        volume: { id: "vol-1", latestVersion: 3n, latestVersionTime: timestampFromDate(new Date("2026-10-28T08:01:00Z")) },
      });
    });

    const toshi = fake.client();
    const volumes = await toshi.volume.listVolumes({});
    const volume = volumes.volumes[0];
    expect(volume.latestVersion).toBe(2n);
    expect(volume.latestVersionTime === undefined ? undefined : timestampDate(volume.latestVersionTime).toISOString()).toBe(
      saved.toISOString(),
    );

    const first = await toshi.volume.listVolumeVersions({ volumeId: "vol-1" });
    expect(first.versions[0].number).toBe(2n);
    expect(first.versions[0].restoredFrom).toBe(1n);
    expect(first.versions[0].sha256).toBe("0f1e");
    expect(first.versions[0].sizeBytes).toBe(4096n);

    const second = await toshi.volume.listVolumeVersions({ volumeId: "vol-1", pageToken: first.nextPageToken });
    expect(second.nextPageToken).toBe("");
    expect(second.versions[0].number).toBe(1n);

    const restored = await toshi.volume.restoreVolume({ volumeId: "vol-1", version: 1n });
    expect(restored.version?.number).toBe(3n);
    expect(restored.version?.restoredFrom).toBe(1n);
    expect(restored.volume?.latestVersion).toBe(3n);
  });
});
