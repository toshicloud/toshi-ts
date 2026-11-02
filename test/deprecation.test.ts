import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import type { ServiceImpl } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createToshiClient } from "../src/client.js";
import { deprecationMessage } from "../src/deprecation.js";
import { SecretService } from "../src/gen/toshi/workspace/v1/secrets_pb.js";

// 2026-01-01T00:00:00Z, the date a call is marked deprecated in these tests.
const since = "@1767225600";
const sunset = "Wed, 01 Jul 2026 00:00:00 GMT";
const link = '<https://example.com/docs/deprecations>; rel="deprecation"; type="text/html"';

function clientWith(impl: Partial<ServiceImpl<typeof SecretService>>, warn?: (message: string) => void) {
  return createToshiClient({
    transport: (interceptors) =>
      createRouterTransport(
        (router) => {
          router.service(SecretService, impl);
        },
        { transport: { interceptors } },
      ),
    token: "t",
    retry: false,
    ...(warn === undefined ? {} : { warn }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a deprecated call", () => {
  it("warns once per call per process, naming the call, the dates and the link", async () => {
    const messages: string[] = [];
    const toshi = clientWith(
      {
        listSecrets(_req, ctx) {
          ctx.responseHeader.set("Deprecation", since);
          ctx.responseHeader.set("Sunset", sunset);
          ctx.responseHeader.set("Link", link);
          return {};
        },
      },
      (message) => messages.push(message),
    );
    await toshi.secret.listSecrets({});
    await toshi.secret.listSecrets({});
    await clientWith({ listSecrets: () => ({}) }, (message) => messages.push(message)).secret.listSecrets({});
    expect(messages).toEqual([
      "toshi: /toshi.workspace.v1.SecretService/ListSecrets is deprecated since 2026-01-01 and is removed after 2026-07-01; see https://example.com/docs/deprecations",
    ]);
  });

  it("warns on an answer that is an error, and leaves the error as it was", async () => {
    const messages: string[] = [];
    const toshi = clientWith(
      {
        deleteSecret(_req, ctx) {
          ctx.responseHeader.set("Deprecation", since);
          throw new ConnectError("no such secret", Code.NotFound);
        },
      },
      (message) => messages.push(message),
    );
    await expect(toshi.secret.deleteSecret({})).rejects.toMatchObject({ code: Code.NotFound });
    expect(messages).toEqual(["toshi: /toshi.workspace.v1.SecretService/DeleteSecret is deprecated since 2026-01-01"]);
  });

  it("goes to console.warn when the client sets no warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const toshi = clientWith({
      listSecretVersions(_req, ctx) {
        ctx.responseHeader.set("Sunset", sunset);
        return {};
      },
    });
    await toshi.secret.listSecretVersions({});
    await toshi.secret.listSecretVersions({});
    expect(warn.mock.calls).toEqual([
      ["toshi: /toshi.workspace.v1.SecretService/ListSecretVersions is deprecated and is removed after 2026-07-01"],
    ]);
  });

  it("changes nothing when the answer carries neither header", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const messages: string[] = [];
    const toshi = clientWith({ putSecret: () => ({}) }, (message) => messages.push(message));
    await toshi.secret.putSecret({});
    const plain = clientWith({ putSecret: () => ({}) });
    await plain.secret.putSecret({});
    expect(messages).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("deprecationMessage", () => {
  it("leaves out a value it cannot read", () => {
    expect(deprecationMessage("/s/M", "2026-01-01", "soon", "<https://x>; rel=sunset")).toBe("toshi: /s/M is deprecated");
  });

  it("finds the deprecation link among others, with rel unquoted or in a list", () => {
    expect(deprecationMessage("/s/M", since, null, '<https://a>; rel="next", <https://b>; rel=deprecation')).toBe(
      "toshi: /s/M is deprecated since 2026-01-01; see https://b",
    );
    expect(deprecationMessage("/s/M", since, null, '<https://c>; rel="alternate deprecation"')).toBe(
      "toshi: /s/M is deprecated since 2026-01-01; see https://c",
    );
  });
});
