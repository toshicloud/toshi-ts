# toshi-ts

A TypeScript client for the Toshi Workspace API, `toshi.workspace.v1`,
published as ES modules with type declarations.

```sh
npm install @toshicloud/toshi-ts @connectrpc/connect @connectrpc/connect-node
```

## Using the client

`createToshiClient` takes one set of options. The transport belongs to
the caller: the client hands its interceptors to the `transport`
function, and that function builds a transport with them. Every call then
gets the same token, scope and retries: the helpers below and the
generated clients alike.

In Node, with `@connectrpc/connect-node`:

```ts
import { readFileSync } from "node:fs";
import { createConnectTransport } from "@connectrpc/connect-node";
import { createToshiClient } from "@toshicloud/toshi-ts";

const toshi = createToshiClient({
  transport: (interceptors) =>
    createConnectTransport({
      baseUrl: "https://toshi.example.com",
      httpVersion: "2",
      interceptors,
      // Only for a server whose certificate a private CA signed.
      nodeOptions: { ca: readFileSync("ca.pem") },
    }),
  token: process.env.TOSHI_TOKEN,
  project: "default",
});

const { projects } = await toshi.projects.listProjects({});
```

In a browser, with `@connectrpc/connect-web`:

```ts
import { createConnectTransport } from "@connectrpc/connect-web";
import { createToshiClient } from "@toshicloud/toshi-ts";

const toshi = createToshiClient({
  transport: (interceptors) =>
    createConnectTransport({ baseUrl: "https://toshi.example.com", interceptors }),
  token,
  project: "default",
});
```

To add interceptors of your own, put them before the client's:
`interceptors: [...mine, ...interceptors]`.

The package reads no environment variable and no file. The token, the
server and any CA come from the caller.

### Options

- `token`: sent as `Authorization: Bearer <token>` on every call.
- `project`, `environment`: fill the request's `project` and
  `environment` fields when they are empty. A value in the request wins.
  `environment` is left empty on a request with `shared: true`.
- `retry`: `{ maxAttempts, initialBackoffMs, maxBackoffMs }`, by default
  5, 200 ms and 10 s, with full jitter. `retry: false` turns off retries
  and watch reconnects.

### Retries

The client retries a read, and a write that carries a request key, when
the connection fails: a `ConnectError` with code `Unavailable`, a
connection reset or destroyed stream that `@connectrpc/connect-node`
reports, or a stream the server refused before reading it
(`REFUSED_STREAM`). A write that takes a request key gets a random one when the
request has none, so the server applies a retried write once. Other
writes are never retried. An error the server sends, including
`Aborted`, `InvalidArgument` and `ResourceExhausted`, reaches the caller
unchanged. So does any connection failure the client cannot tell apart
from a server error.

### Waiting and watching

- `waitWorkload(req)` and `waitOperation(req)` ask again until the
  workload reaches the state or the operation is done.
- `watchWorkloads(req)`, `watchEvents(req)` and `watchOutput(req)`
  resolve to a watch you read with `for await`. A watch opens its stream
  when you start reading and reconnects after a connection failure from
  where it stopped: `cursor` for workloads and events, `offsets` (bytes,
  as `bigint`) for output. With no cursor, `watchWorkloads` lists the
  workloads first, and `snapshot` holds them once its promise resolves;
  `watchEvents` yields the past events page by page before the live ones.
  `close()` or leaving the loop ends the stream. The output watch ends at
  the output's end.

```ts
const watch = await toshi.watchEvents({ workloadId: id });
for await (const event of watch) {
  console.log(event.name);
}
// watch.cursor resumes a later watch after the last event read.
```

Every helper takes `{ signal }`, an `AbortSignal` that ends it.

### Running a command

`execute(start)` runs a command and resolves once the server has started
it. The process is one stream of output chunks, `{ stream: "stdout" |
"stderr", data: Uint8Array }`. `write` sends standard input in frames of
at most 64 KiB and resolves once the stream has taken the last one; await
it before the next `write`, which is refused while one is pending, so the
client holds at most one buffer of input. `closeStdin` ends standard input
after a pending write, and a later `write` is refused. `wait` settles when
the command ends.

```ts
const proc = await toshi.execute({ workloadId: id, command: { argv: ["cat"] } });
await proc.write("hello\n");
await proc.closeStdin();
for await (const chunk of proc) {
  process[chunk.stream].write(chunk.data);
}
await proc.wait(); // rejects with ExitError on a non-zero exit
```

Without a loop, `wait()` reads and drops the output itself. It rejects
with `ExitError` when the command fails, is cancelled or ends without an
exit status, and with `StreamLostError` when the stream ends first. The
client never runs a command again by itself. Standard input cannot be
replayed, so the caller decides whether to start again with the same
`requestKey`. Leaving the loop early cancels the stream, and `wait()`
then rejects with a `Canceled` error.

Execute needs a bidirectional stream: `@connectrpc/connect-node` with
`httpVersion: "2"`. In a browser, `execute` rejects at once and makes no
call. Over a transport without HTTP/2, the call fails with the
transport's or the server's error.

## Generated code

`src/gen/toshi/workspace/v1/` is generated by
[`protoc-gen-es`](https://github.com/bufbuild/protobuf-es) from the protos
in `proto/toshi/workspace/v1` of the
[toshi-api](https://github.com/toshicloud/toshi-api) repository, one
`*_pb.ts` file per proto. The generated code is committed and imports
only `@bufbuild/protobuf`, so installing the package needs no generator.

`pin.env` names the toshi-api commit (or, once one exists, the release
tag) the code is generated from, and the Toshi server commit the
integration test runs against. `mise.toml` pins the versions of Node,
pnpm, `buf` and `protoc-gen-es`.

To regenerate:

```sh
mise install
mise exec -- scripts/generate.sh
```

Moving to another commit or tag is one pull request that changes
`pin.env` and `src/gen/` together. CI regenerates the code from `pin.env`
and fails if the result differs from what is committed
(`scripts/check-generated.sh`).

## Versions

The package's major version follows the API's: `1.x` will serve
`toshi.workspace.v1`, and a `toshi.workspace.v2` gets a new major
version. Until a Toshi release serves the API, the package stays at
`0.x` and is generated from a pinned commit.

## Integration test

`test/integration/` runs the client against a real `toshi serve` over
HTTPS with a test CA it mints itself. `scripts/integration.sh` clones
the server repository that `TOSHI_SERVER_REPOSITORY` names at the commit
in `pin.env`, builds `toshi` with that commit's own Go version, and runs
the test:

```sh
TOSHI_SERVER_REPOSITORY=<repository URL> mise exec -- scripts/integration.sh
```

Without `TOSHI_INTEGRATION_BIN` (which the script sets), `pnpm test`
skips the integration test and says why.

## Licence

Apache License 2.0, see LICENSE.
