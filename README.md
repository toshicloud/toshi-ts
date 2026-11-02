<p align="center">
  <img src="docs/assets/toshi-logo.svg" alt="Toshi" width="120">
</p>

<h1 align="center">toshi-ts</h1>

<p align="center">The TypeScript SDK for the Toshi API.</p>

<p align="center">
  <img alt="licence" src="https://img.shields.io/badge/licence-Apache--2.0-blue">
  <img alt="node" src="https://img.shields.io/badge/node-22%2B-339933">
  <img alt="status" src="https://img.shields.io/badge/status-early-orange">
</p>

<p align="center">
  <a href="docs/usage.md">Get started</a> ·
  <a href="docs/usage.md">Docs</a> ·
  <a href="https://github.com/toshicloud/toshi-ts/issues">Issues</a>
</p>

A TypeScript client for the Toshi Workspace API, `toshi.workspace.v1`, published as ES modules with type declarations, for Node and browser programs that start jobs, sandboxes and services on Toshi and follow them. It retries safe calls, resumes watches and ships an in-memory fake Toshi for tests.

> **Early stage.** The package stays at 0.x until a Toshi release serves the API; the latest release is the one to use.
> Interfaces may change before 1.0.
> Read the [release notes](https://github.com/toshicloud/toshi-ts/releases) when upgrading.

## Quick start

```sh
npm install @toshicloud/sdk @bufbuild/protobuf @connectrpc/connect
# For the Node entry, @toshicloud/sdk/node:
npm install @connectrpc/connect-node
```

The peer dependencies need `@bufbuild/protobuf` ^2.16.0 and
`@connectrpc/connect` ^2.2.0, and the Node entry also
`@connectrpc/connect-node` ^2.2.0. In Node the package needs Node 22 or
later.

<!-- examples/quick-start.ts -->

```ts
import { createToshiClient } from "@toshicloud/sdk/node";

const toshi = createToshiClient({ project: "default" });

const { projects } = await toshi.project.listProjects({});
console.log(projects.length);
```

The Node entry reads `TOSHI_SERVER` and `TOSHI_TOKEN` from the environment; the [usage guide](docs/usage.md) continues from there, including the browser entry.

## Verify a webhook

Toshi signs every webhook it sends. A receiver checks the signature on the
raw body before it trusts the event:

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

[Webhooks](docs/webhooks.md) says what `verifyWebhook` checks and how it refuses.

## Documentation

- [Usage](docs/usage.md): the client, options, retries, lists, watches, commands and jobs
- [Errors](docs/errors.md): products that are off and refusals with a reason
- [Webhooks](docs/webhooks.md): verifying the webhooks Toshi sends
- [Testing with `@toshicloud/sdk/test`](docs/testing.md): the in-memory fake
- [Development](docs/development.md): generated code, versions, publishing and the integration test
- [The package on npm](https://www.npmjs.com/package/@toshicloud/sdk)
- [The Toshi API](https://github.com/toshicloud/toshi-api) the client calls
- [Releases](https://github.com/toshicloud/toshi-ts/releases)
- [Security](SECURITY.md) · [Licence](LICENSE)

## Status and support

Issues and questions go to [GitHub issues](https://github.com/toshicloud/toshi-ts/issues).
Security reports follow [SECURITY.md](SECURITY.md).

Apache-2.0
