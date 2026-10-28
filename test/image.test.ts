import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
  ImageKind,
  ImageVersionState,
  ListImagesResponseSchema,
} from "../src/gen/toshi/workspace/v1/images_pb.js";
import { ImageService } from "../src/gen/toshi/workspace/v1/images_pb.js";
import { createFake } from "../src/test/index.js";

describe("images", () => {
  it("creates, reads, lists, builds and deletes an image through the client", async () => {
    const fake = createFake();
    fake.on(ImageService.method.createImage, (request) => {
      expect(request.name).toBe("base");
      expect(request.kind).toBe(ImageKind.DISK);
      return Promise.resolve({
        image: { id: "img-1", name: "base", kind: ImageKind.DISK, base: "ubuntu-24.04", size: "toshi-linux-2x" },
        version: { id: "iv-2", number: 2n, state: ImageVersionState.BUILDING, buildJobId: "job-1" },
      });
    });
    fake.on(ImageService.method.getImage, () =>
      Promise.resolve({
        image: { id: "img-1", name: "base" },
        versions: [
          {
            number: 2n,
            state: ImageVersionState.PENDING_DELETION,
            sizeBytes: 1n << 30n,
            pinnedBy: [{ serviceId: "svc-1", serviceName: "web", revision: 3n }],
          },
          { number: 1n, state: ImageVersionState.READY, sizeBytes: 1n << 30n },
        ],
      }),
    );
    fake.on(ImageService.method.listImages, () =>
      Promise.resolve(create(ListImagesResponseSchema, { images: [{ id: "img-1", name: "base" }] })),
    );
    fake.on(ImageService.method.buildImage, () =>
      Promise.resolve({ version: { id: "iv-3", number: 3n, state: ImageVersionState.BUILDING } }),
    );
    fake.on(ImageService.method.deleteImage, () => Promise.resolve({}));

    const toshi = fake.client();
    const created = await toshi.image.createImage({
      name: "base",
      kind: ImageKind.DISK,
      base: "ubuntu-24.04",
      size: "toshi-linux-2x",
    });
    expect(created.image?.name).toBe("base");
    expect(created.version?.number).toBe(2n);
    expect(created.version?.state).toBe(ImageVersionState.BUILDING);

    const got = await toshi.image.getImage({ name: "base" });
    expect(got.versions).toHaveLength(2);
    expect(got.versions[0].state).toBe(ImageVersionState.PENDING_DELETION);
    expect(got.versions[0].pinnedBy[0].serviceName).toBe("web");
    expect(got.versions[1].state).toBe(ImageVersionState.READY);

    const listed = await toshi.image.listImages({});
    expect(listed.images.map((image) => image.id)).toEqual(["img-1"]);

    const built = await toshi.image.buildImage({ name: "base" });
    expect(built.version?.id).toBe("iv-3");

    await toshi.image.deleteImage({ name: "base" });
  });
});
