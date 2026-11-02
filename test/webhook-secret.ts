import { createHash } from "node:crypto";
import { formatWebhookSecret } from "../src/webhook.js";

/** The bytes of the secret the tests sign with, derived at run time. */
export function testWebhookSecretBytes(seed = "sdk-test-webhook-secret"): Uint8Array {
  return createHash("sha256").update(seed).digest();
}

/**
 * A signing secret in the API's form, "whsec_" and the base64 of 32 bytes,
 * built at run time with formatWebhookSecret so no literal of that form sits
 * in the tree.
 */
export function testWebhookSecret(seed?: string): string {
  return formatWebhookSecret(testWebhookSecretBytes(seed));
}
