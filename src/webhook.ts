/**
 * Verifying the webhooks Toshi sends.
 *
 * Toshi signs every webhook POST with the symmetric scheme of the Standard
 * Webhooks specification (https://www.standardwebhooks.com/): three headers
 * carry the event's id, the time of the try and a list of signatures, each
 * "v1," and the base64 HMAC-SHA256 of "<id>.<timestamp>.<body>" under the
 * endpoint's secret. The secret is given to the receiver as "whsec_" and the
 * base64 of its bytes.
 */

/** The event's id: the same on every try, so a receiver can drop a repeat. */
export const webhookIdHeader = "webhook-id";
/** The try's time in unix seconds; a retry carries its own. */
export const webhookTimestampHeader = "webhook-timestamp";
/**
 * A space-separated list of signatures, each "v1," and the base64
 * HMAC-SHA256. While an endpoint's secret rotates it holds one signature
 * under each secret.
 */
export const webhookSignatureHeader = "webhook-signature";
/** How far, either way, `verifyWebhook` accepts a timestamp from now, in seconds. */
export const webhookToleranceSeconds = 300;

const secretPrefix = "whsec_";
const signatureVersion = "v1";

/** Why `verifyWebhook` refused a POST. */
export type WebhookVerifyReason = "SECRET" | "MISSING_HEADER" | "OUTSIDE_TOLERANCE" | "BAD_SIGNATURE";

/** The reasons of `WebhookVerifyError`. */
export const WebhookVerifyReason = {
  /** The secret is not "whsec_" and the base64 of 24 to 64 bytes. */
  Secret: "SECRET",
  /**
   * A header is missing, the id is empty or holds a full stop or a space, or
   * the timestamp is not a whole number of seconds.
   */
  MissingHeader: "MISSING_HEADER",
  /** The timestamp is more than `webhookToleranceSeconds` from now. */
  OutsideTolerance: "OUTSIDE_TOLERANCE",
  /** No "v1" signature matches the id, timestamp and body under the secret. */
  BadSignature: "BAD_SIGNATURE",
} as const satisfies Record<string, WebhookVerifyReason>;

const messages: Readonly<Record<WebhookVerifyReason, string>> = {
  SECRET: "webhook: the secret is not whsec_ and base64 of 24 to 64 bytes",
  MISSING_HEADER: "webhook: a webhook header is missing or malformed",
  OUTSIDE_TOLERANCE: "webhook: timestamp outside the tolerance",
  BAD_SIGNATURE: "webhook: no signature matches",
};

/** A webhook POST `verifyWebhook` refused. Its message holds neither the secret nor a signature. */
export class WebhookVerifyError extends Error {
  /** Why the POST was refused. */
  readonly reason: WebhookVerifyReason;

  constructor(reason: WebhookVerifyReason) {
    super(messages[reason]);
    this.name = "WebhookVerifyError";
    this.reason = reason;
  }
}

/** A request's headers: a Fetch `Headers`, or a record such as Node's `IncomingHttpHeaders`. */
export type WebhookHeaders = Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

/** Returns a secret's bytes in the form Toshi gives a receiver: "whsec_" and their base64. */
export function formatWebhookSecret(raw: Uint8Array): string {
  let binary = "";
  for (const byte of raw) {
    binary += String.fromCharCode(byte);
  }
  return secretPrefix + btoa(binary);
}

/**
 * Checks a webhook POST: it refuses a timestamp more than
 * `webhookToleranceSeconds` from `now`, then resolves when one "v1" entry of
 * the signature header equals the HMAC-SHA256 of the id, the timestamp and
 * `body` under `secret`, compared in constant time. Entries of another
 * version are skipped. `secret` is the endpoint's secret as Toshi gives it,
 * "whsec_" and base64; `body` is the request body exactly as received.
 *
 * It rejects with a `WebhookVerifyError` whose `reason` says why.
 */
export async function verifyWebhook(
  headers: WebhookHeaders,
  body: string | Uint8Array,
  secret: string,
  now: Date = new Date(),
): Promise<void> {
  const key = parseSecret(secret);
  const id = header(headers, webhookIdHeader);
  const timestamp = header(headers, webhookTimestampHeader);
  const list = header(headers, webhookSignatureHeader);
  if (id === "" || /[. \t\r\n]/.test(id) || timestamp === "" || list === "") {
    throw new WebhookVerifyError("MISSING_HEADER");
  }
  const seconds = parseSeconds(timestamp);
  if (seconds === undefined) {
    throw new WebhookVerifyError("MISSING_HEADER");
  }
  if (Math.abs(now.getTime() - seconds * 1000) > webhookToleranceSeconds * 1000) {
    throw new WebhookVerifyError("OUTSIDE_TOLERANCE");
  }
  const hmacKey = await globalThis.crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const prefix = new TextEncoder().encode(`${id}.${timestamp}.`);
  const content = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const signed = new Uint8Array(prefix.length + content.length);
  signed.set(prefix);
  signed.set(content, prefix.length);
  for (const entry of list.split(/\s+/)) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== signatureVersion) {
      continue;
    }
    const signature = decodeBase64(entry.slice(comma + 1));
    if (signature !== undefined && (await globalThis.crypto.subtle.verify("HMAC", hmacKey, signature, signed))) {
      return;
    }
  }
  throw new WebhookVerifyError("BAD_SIGNATURE");
}

/** Reverses `formatWebhookSecret`. */
function parseSecret(secret: string): Uint8Array<ArrayBuffer> {
  const bytes = secret.startsWith(secretPrefix) ? decodeBase64(secret.slice(secretPrefix.length)) : undefined;
  if (bytes === undefined || bytes.length < 24 || bytes.length > 64) {
    throw new WebhookVerifyError("SECRET");
  }
  return bytes;
}

/** A header's value, the first of a record's list, or "" when it is absent; a record's names are matched without case. */
function header(headers: WebhookHeaders, name: string): string {
  if (headers instanceof Headers) {
    return headers.get(name) ?? "";
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      const first = typeof value === "string" ? value : value?.[0];
      return first ?? "";
    }
  }
  return "";
}

/** A timestamp in whole seconds, a signed 64-bit integer, or undefined. */
function parseSeconds(text: string): number | undefined {
  if (!/^[+-]?\d+$/.test(text)) {
    return undefined;
  }
  const value = BigInt(text);
  if (value < -(2n ** 63n) || value >= 2n ** 63n) {
    return undefined;
  }
  return Number(value);
}

/** Decodes padded standard base64, or returns undefined. */
function decodeBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    return undefined;
  }
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
