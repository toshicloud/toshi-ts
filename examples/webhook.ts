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
