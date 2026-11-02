# Webhooks

Toshi signs every webhook POST with the symmetric scheme of the
[Standard Webhooks](https://www.standardwebhooks.com/) specification.
`verifyWebhook` from `@toshicloud/sdk` verifies it, in Node and in the
browser alike: it uses the Web Crypto API.

## What a signed POST carries

| Header | Constant | Holds |
|---|---|---|
| `webhook-id` | `webhookIdHeader` | the event's id, the same on every try, so a receiver can drop a repeat |
| `webhook-timestamp` | `webhookTimestampHeader` | the try's time in unix seconds; a retry carries its own |
| `webhook-signature` | `webhookSignatureHeader` | a space-separated list of signatures, each `v1,` and a base64 HMAC-SHA256 |

A signature is the HMAC-SHA256, under the endpoint's secret, of the id, the
timestamp and the body joined by full stops: `<id>.<timestamp>.<body>`.
While an endpoint's secret rotates, the header holds one signature under
the new secret and one under the previous one, so a receiver that still
holds either keeps verifying.

The secret reaches the receiver as `whsec_` and the base64 of its bytes,
24 to 64 of them. `formatWebhookSecret(bytes)` writes bytes in that form,
for a test that signs its own POSTs.

## Verify

`verifyWebhook(headers, body, secret, now?)` takes the request's headers (a
Fetch `Headers` or a record such as Node's `req.headers`), the body exactly
as received (a string or bytes), the secret in its `whsec_` form and the
current time, which defaults to now. Read the body before parsing it: a body
that was parsed and serialised again is not the body Toshi signed.

<!-- examples/webhook.ts -->

```ts
import { createServer } from "node:http";
import { verifyWebhook } from "@toshicloud/sdk";

// The endpoint's secret, "whsec_" and base64, as Toshi gave it.
const secret = process.env.TOSHI_WEBHOOK_SECRET ?? "";

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    verifyWebhook(req.headers, body, secret).then(
      () => {
        // body is the event, exactly as Toshi sent it.
        res.writeHead(204).end();
      },
      () => {
        res.writeHead(401).end("unverified webhook");
      },
    );
  });
}).listen(8080);
```

The promise resolves when one `v1` signature in the list matches, compared
in constant time; entries of another version are skipped. Otherwise it
rejects with a `WebhookVerifyError` whose `reason` is one of
`WebhookVerifyReason`:

| Reason | When |
|---|---|
| `SECRET` | the secret is not `whsec_` and the base64 of 24 to 64 bytes |
| `MISSING_HEADER` | a header is missing, the id is empty or holds a full stop or a space, or the timestamp is not a whole number of seconds |
| `OUTSIDE_TOLERANCE` | the timestamp is more than `webhookToleranceSeconds`, five minutes, from `now` either way |
| `BAD_SIGNATURE` | no `v1` signature matches |

No error's message holds the secret or a signature.
