import { createHash } from "node:crypto";

/**
 * A signing secret in the API's form, "whsec_" and the base64 of 32 bytes,
 * built at run time so no literal of that form sits in the tree.
 */
export function testWebhookSecret(): string {
  return `whsec_${createHash("sha256").update("sdk-test-webhook-secret").digest("base64")}`;
}
