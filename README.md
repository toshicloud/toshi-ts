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
npm install @toshicloud/sdk @bufbuild/protobuf @connectrpc/connect @connectrpc/connect-node
```

<!-- examples/quick-start.ts -->

```ts
import { createToshiClient } from "@toshicloud/sdk/node";

const toshi = createToshiClient({ project: "default" });

const { projects } = await toshi.project.listProjects({});
console.log(projects.length);
```

The Node entry reads `TOSHI_SERVER` and `TOSHI_TOKEN` from the environment; the [usage guide](docs/usage.md) continues from there, including the browser entry.

## Documentation

- [Usage](docs/usage.md): the client, options, retries, lists, watches, commands and jobs
- [Errors](docs/errors.md): products that are off and refusals with a reason
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
