import { describe, expect, it } from "vitest";
import {
  WebhookVerifyError,
  type WebhookVerifyReason,
  formatWebhookSecret,
  verifyWebhook,
  webhookIdHeader,
  webhookSignatureHeader,
  webhookTimestampHeader,
  webhookToleranceSeconds,
} from "../src/index.js";
import { testWebhookSecret } from "./webhook-secret.js";

interface Vector {
  name: string;
  id: string;
  timestamp: string;
  body: string;
  signature: string;
}

// Signed by Toshi's own signer with the secret of the seed
// "sdk-test-webhook-secret"; "rotation" carries a second signature under the
// seed "sdk-test-webhook-secret-previous".
const vectors: readonly Vector[] = [
  {
    name: "json",
    id: "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W",
    timestamp: "1700000000",
    body: '{"type":"job.ended","data":{"id":"job-1","exit_code":0}}',
    signature: "v1,2fZ/4I1cxjdjNpEOxtEharf346Elw65NT+H+/hU8bAk=",
  },
  {
    name: "empty body",
    id: "evt-0001",
    timestamp: "1730000000",
    body: "",
    signature: "v1,O1Or6sa9E9odKVi0myGaOUyx3MzMcMbcdo7WEzR+hGI=",
  },
  {
    name: "utf-8",
    id: "evt_ünï",
    timestamp: "1762000000",
    body: "héllo wörld ✓\n",
    signature: "v1,HeBcS1zAQC1xlER7W9UxaZZv9qaZaxUqlAbMOlkl+48=",
  },
  {
    name: "rotation",
    id: "evt-rotate",
    timestamp: "1762090000",
    body: '{"type":"service.started"}',
    signature:
      "v1,i7YYduR72D+M3Uh/A+eXrdlI/3gHlpx4JdIIBtkR2lQ= v1,qFKwIw7BbybKLLMvb3GzyOHsAlWXqciKSIKQ2YcgRu0=",
  },
];

const secret = testWebhookSecret();

function headers(vector: Vector, change: Record<string, string | undefined> = {}): Record<string, string> {
  const all: Record<string, string | undefined> = {
    [webhookIdHeader]: vector.id,
    [webhookTimestampHeader]: vector.timestamp,
    [webhookSignatureHeader]: vector.signature,
    ...change,
  };
  return Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function at(vector: Vector, offsetSeconds: number): Date {
  return new Date((Number(vector.timestamp) + offsetSeconds) * 1000);
}

async function reason(promise: Promise<void>): Promise<WebhookVerifyReason | "accepted"> {
  try {
    await promise;
    return "accepted";
  } catch (error) {
    expect(error).toBeInstanceOf(WebhookVerifyError);
    return (error as WebhookVerifyError).reason;
  }
}

describe("verifyWebhook", () => {
  it("names the headers and the tolerance of Toshi's signer", () => {
    expect([webhookIdHeader, webhookTimestampHeader, webhookSignatureHeader]).toEqual([
      "webhook-id",
      "webhook-timestamp",
      "webhook-signature",
    ]);
    expect(webhookToleranceSeconds).toBe(300);
  });

  for (const vector of vectors) {
    it(`accepts Toshi's signature: ${vector.name}`, async () => {
      for (const offset of [0, webhookToleranceSeconds, -webhookToleranceSeconds]) {
        await expect(verifyWebhook(headers(vector), vector.body, secret, at(vector, offset))).resolves.toBeUndefined();
      }
      const bytes = new TextEncoder().encode(vector.body);
      await expect(verifyWebhook(headers(vector), bytes, secret, at(vector, 0))).resolves.toBeUndefined();
    });
  }

  it("accepts Fetch Headers and names in any case", async () => {
    const vector = vectors[0];
    await expect(verifyWebhook(new Headers(headers(vector)), vector.body, secret, at(vector, 0))).resolves.toBeUndefined();
    const upper = Object.fromEntries(Object.entries(headers(vector)).map(([name, value]) => [name.toUpperCase(), value]));
    await expect(verifyWebhook(upper, vector.body, secret, at(vector, 0))).resolves.toBeUndefined();
  });

  it("accepts a rotation's previous secret and a v1 entry after another version", async () => {
    const rotation = vectors[3];
    const previous = testWebhookSecret("sdk-test-webhook-secret-previous");
    await expect(verifyWebhook(headers(rotation), rotation.body, previous, at(rotation, 0))).resolves.toBeUndefined();
    const vector = vectors[0];
    const mixed = headers(vector, { [webhookSignatureHeader]: `v2,c2lnbmVk ${vector.signature}` });
    await expect(verifyWebhook(mixed, vector.body, secret, at(vector, 0))).resolves.toBeUndefined();
  });

  const vector = vectors[0];
  const refusals: ReadonlyArray<
    readonly [string, Record<string, string>, string, string, Date, WebhookVerifyReason]
  > = [
    ["no id", headers(vector, { [webhookIdHeader]: undefined }), vector.body, secret, at(vector, 0), "MISSING_HEADER"],
    ["no timestamp", headers(vector, { [webhookTimestampHeader]: undefined }), vector.body, secret, at(vector, 0), "MISSING_HEADER"],
    ["no signature", headers(vector, { [webhookSignatureHeader]: undefined }), vector.body, secret, at(vector, 0), "MISSING_HEADER"],
    ["an id with a full stop", headers(vector, { [webhookIdHeader]: "evt.1" }), vector.body, secret, at(vector, 0), "MISSING_HEADER"],
    ["a timestamp not in seconds", headers(vector, { [webhookTimestampHeader]: "1700000000.5" }), vector.body, secret, at(vector, 0), "MISSING_HEADER"],
    ["a second past the tolerance", headers(vector), vector.body, secret, at(vector, webhookToleranceSeconds + 1), "OUTSIDE_TOLERANCE"],
    ["a second before the tolerance", headers(vector), vector.body, secret, at(vector, -webhookToleranceSeconds - 1), "OUTSIDE_TOLERANCE"],
    ["a changed body", headers(vector), `${vector.body} `, secret, at(vector, 0), "BAD_SIGNATURE"],
    ["another secret", headers(vector), vector.body, testWebhookSecret("another"), at(vector, 0), "BAD_SIGNATURE"],
    ["another id", headers(vector, { [webhookIdHeader]: "evt-2" }), vector.body, secret, at(vector, 0), "BAD_SIGNATURE"],
    ["only another version", headers(vector, { [webhookSignatureHeader]: `v2${vector.signature.slice(2)}` }), vector.body, secret, at(vector, 0), "BAD_SIGNATURE"],
    ["a signature that is not base64", headers(vector, { [webhookSignatureHeader]: "v1,!!!" }), vector.body, secret, at(vector, 0), "BAD_SIGNATURE"],
    ["a secret without whsec_", headers(vector), vector.body, secret.slice("whsec_".length), at(vector, 0), "SECRET"],
    ["a secret of 16 bytes", headers(vector), vector.body, formatWebhookSecret(new Uint8Array(16)), at(vector, 0), "SECRET"],
  ];
  for (const [name, given, body, key, now, want] of refusals) {
    it(`refuses ${name}`, async () => {
      expect(await reason(verifyWebhook(given, body, key, now))).toBe(want);
    });
  }
});
