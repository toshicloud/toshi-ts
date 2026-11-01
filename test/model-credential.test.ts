import { Code, ConnectError } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";

import { ModelCredentialService } from "../src/gen/toshi/workspace/v1/model_credentials_pb.js";
import { createFake } from "../src/test/index.js";

describe("model credentials", () => {
  it("creates a credential through the client and answers an unhooked call with UNIMPLEMENTED", async () => {
    const fake = createFake();
    fake.on(ModelCredentialService.method.createModelCredential, (request) => {
      expect(request.name).toBe("work");
      expect(request.provider).toBe("anthropic");
      expect(request.secret).toBe("ANTHROPIC_API_KEY");
      expect(request.project).toBe("default");
      expect(request.environment).toBe("production");
      return Promise.resolve({
        modelCredential: {
          id: "mcr-1",
          name: request.name,
          provider: request.provider,
          mine: true,
        },
      });
    });

    const toshi = fake.client();
    const created = await toshi.modelCredential.createModelCredential({
      name: "work",
      provider: "anthropic",
      secret: "ANTHROPIC_API_KEY",
    });
    expect(created.modelCredential?.id).toBe("mcr-1");
    expect(created.modelCredential?.mine).toBe(true);

    const error: unknown = await toshi.modelCredential.getModelCredential({ id: "mcr-1" }).catch(
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).code).toBe(Code.Unimplemented);
    expect((error as ConnectError).message).toContain(
      "/toshi.workspace.v1.ModelCredentialService/GetModelCredential",
    );
    expect((error as ConnectError).message).toContain(
      "fake.on(ModelCredentialService.method.getModelCredential)",
    );
  });
});
