# toshi-ts

A TypeScript client for the Toshi Workspace API, `toshi.workspace.v1`,
published as ES modules with type declarations.

```sh
npm install @toshicloud/sdk @bufbuild/protobuf @connectrpc/connect
```

The browser entry needs a transport such as `@connectrpc/connect-web`; the
Node entry needs `@connectrpc/connect-node`. Both are peer dependencies, so
install the ones your application uses.

Versions up to 0.1.2 were published as `@toshicloud/toshi-ts`.

## Using the client

In Node, `@toshicloud/sdk/node` builds the transport and fills the server
and the token from the environment:

<!-- examples/quick-start.ts -->

```ts
import { createToshiClient } from "@toshicloud/sdk/node";

const toshi = createToshiClient({ project: "default" });

const { projects } = await toshi.project.listProjects({});
console.log(projects.length);
```

In a browser, with `@connectrpc/connect-web`:

<!-- examples/browser.ts -->

```ts
import { createConnectTransport } from "@connectrpc/connect-web";
import { createToshiClient } from "@toshicloud/sdk";

// The token the browser app already holds.
declare const token: string;

export const toshi = createToshiClient({
  transport: (interceptors) =>
    createConnectTransport({ baseUrl: "https://toshi.example.com", interceptors }),
  token,
  project: "default",
});
```

Interceptors of your own go before the client's. The Node entry takes
`interceptors`; with a transport of your own, put them first:
`interceptors: [...mine, ...interceptors]`. Each unary call enters them
once, with its retries inside, and they never see the Authorization
header: the client sets it on a copy of the request below them.

The browser entry reads no environment variable and no file. The Node
entry reads `TOSHI_SERVER`, `TOSHI_TOKEN`, `TOSHI_TOKEN_FILE` and
`TOSHI_CA_FILE`; see Node options.

### Options

- `tokenSource`: a function that gives each request attempt its token, so a
  refreshed token is used without a new client; it wins over `token`. See
  Tokens that change.
- `token`: sent as `Authorization: Bearer <token>` on every call.
- `project`, `environment`: fill the request's `project` and
  `environment` fields when they are empty. A value in the request wins.
  `environment` is left empty on a request with `shared: true`.
- `retry`: `{ maxAttempts, initialBackoffMs, maxBackoffMs }`, by default
  5, 200 ms and 10 s, with full jitter. Reads, and the calls whose request
  takes a `request_key`, are retried; a stream and every other call is not.
  `retry: false` turns off retries and watch reconnects.
- `defaultTimeoutMs`: bounds each unary call except the Wait calls,
  which their request's timeout bounds; streams ignore it.

A call may set `timeoutMs` instead: it bounds the whole call, retries
included, and on a watch it bounds the open. It composes with `signal`.
`ToshiOptions` is the object the client takes, and `CallOptions` the second
argument of each call, which carries `signal` and `timeoutMs`.

### Node options

`@toshicloud/sdk/node` builds a connect-node transport over HTTP/2 and
fills what is missing from the environment:

- `server`, else `TOSHI_SERVER`: the control plane's URL. Without either,
  the client refuses to start.
- `tokenSource`, `token`, `tokenFile`, `TOSHI_TOKEN`, `TOSHI_TOKEN_FILE`, in
  that order. A token file is trimmed, and an empty file is an error.
- `caFile`, else `TOSHI_CA_FILE`: a PEM bundle trusted besides Node's
  built-in roots.
- `userAgent`: put in front of the User-Agent, for example "myapp/1.2".
- `interceptors`: run before the client's own, in the order given.
- `defaultTimeoutMs`: bounds each unary call except the Wait calls,
  which their request's timeout bounds; streams ignore it.
- `transport`: a transport of your own; then `server` and `caFile` are not
  required.

Every request carries `User-Agent: toshi-ts/<version> (node/<node
version>)`, with `userAgent` and one space in front when it is set. The
root entry sends no User-Agent: browsers own it.

### Tokens that change

`tokenSource` gives the client a function it calls for the token of every
request attempt, so a token that is refreshed, for example from a secret
manager, is used without a new client. It wins over every other token
option. The client asks it once per attempt, a retry included, and may
ask it concurrently, so it must be fast: keep the token somewhere and
refresh it outside the call. A source that throws, or that answers an
empty token, fails the call with `UNAUTHENTICATED`, with the error as the
cause, and the call is not retried.

<!-- examples/token-source.ts -->

```ts
// A token a refresh loop replaces; the client asks for it on every call.
let token = "first-token";

export const toshi = createToshiClient({
  project: "default",
  tokenSource: () => token,
});

export function rotate(next: string): void {
  token = next;
}
```

A token file, from `tokenFile` or `TOSHI_TOKEN_FILE`, is read again
before a request when its modification time or size has changed, so a
rotated token, such as a Kubernetes projected service account token, is
picked up without a new client.

### The client's shape

The client has one field per Workspace API service: `project`, `secret`,
`webhook`, `display`, `channel`, `recording`, `volume`, `artifact`,
`artifactUpload`, `workspace`, `hostJob`, `host`, `token`, `auditEvent`,
`filler`, `grant`, `storageProvider`, `product`, `discovery`, `connection`,
`role`, `trigger`, `account`, `image` and `domain`, each holding that service's
generated client.
`workload` holds `WorkloadService`'s calls, grouped by the type they
name: `workload.jobs`, `workload.sandboxes` and `workload.services`, one
method for each call (`create`, `get`, `list`, `update`, `delete`, `wait`,
`watch`, and `cancel` on a job, `execute`, `start` and `stop` on a sandbox,
`start`, `stop`, `setMode`, `listRuns`, `wake`, `hold`, `release`,
`listRevisions`, `getRevision`, `rollback` and `listActivations` on a
service). The calls that
span the three types sit on `workload` itself: `listEvents`, `watchEvents`,
`getOperation` and `waitOperation`. `run` sits at the top of the client, as
`toshi run` sits at the top of the CLI.

<!-- examples/client-shape.ts -->

```ts
const { jobs } = await toshi.workload.jobs.list({ pageSize: 10 });
const { job } = await toshi.workload.jobs.get({ id: jobs[0].id });
console.log(job?.id);
```

### Lists

`workload.jobs.all`, `workload.sandboxes.all`,
`workload.sandboxes.allPreviewShareLinks`, `workload.services.all`,
`workload.services.allRuns` and `workload.allEvents` take the request their
`list` method takes and yield every item, one page after another. Each
response's `nextPageToken` becomes the next request's `pageToken`, and a
`pageToken` in the request resumes from that page. A service with no
`all` method is one `paginate` call away: it takes the list call and a
function that picks a response's items.

<!-- examples/lists.ts -->

```ts
import { paginate } from "@toshicloud/sdk";

import { toshi } from "./client.js";

// Every job that matches the request, one page after another.
for await (const job of toshi.workload.jobs.all({ pageSize: 10 })) {
  console.log(job.id);
}

// A service with no all() method: paginate takes its list call and items.
for await (const project of paginate(
  {},
  (req, opts) => toshi.project.listProjects(req, opts),
  (resp) => resp.projects,
)) {
  console.log(project.name);
}
```

`paginate` sends a copy of the request, so the caller's request keeps its
fields. Every page is a call of its own, so `opts` goes to each one, and
`timeoutMs` bounds a page and not the whole iteration. An error throws once
and ends the iteration; leaving the loop sends no further request.
`PageRequest` is a list request, which may name the page to read first with
`pageToken`, and `PageResponse` a list response, which names the page after
it with `nextPageToken`.

### Retries

The client retries a read, and a write that carries a request key, when
the connection fails: a `ConnectError` with code `Unavailable`, a
connection reset or destroyed stream that `@connectrpc/connect-node`
reports, or a stream the server refused before reading it
(`REFUSED_STREAM`). A write that takes a request key gets a random one when the
request has none, so the server applies a retried write once. Other
writes are never retried.

A `ResourceExhausted` refusal that names how long to wait, as the API's
rate limit does, is retried the same way. The wait comes from its
`google.rpc.RetryInfo` detail, else from its `Retry-After` header. So is an
HTTP 429 with a `Retry-After`, which reaches the client as `Unavailable`.
The client waits the longer of that wait and the backoff, never more than
`maxBackoffMs`, and stops when the call's signal aborts. A
`ResourceExhausted` that names no wait, such as a plan's limit, reaches the
caller unchanged, as do every other error the server sends, including
`Aborted` and `InvalidArgument`, and any connection failure the client
cannot tell apart from a server error.

`RetryPolicy` says how often and how long a call is retried, `maxAttempts`
counting the first try; `defaultRetryPolicy` is the default — five
attempts, a 200 ms initial backoff and a 10 s cap.

### Waiting and watching

- `workload.jobs.wait(req)`, `workload.sandboxes.wait(req)` and
  `workload.services.wait(req)` ask again until the workload reaches the
  state; `workload.waitOperation(req)` asks until the operation is done. A
  call starts at least a second, and at most 1.2 seconds, after the start of
  the one before, and a signal ends a pause with its own error.
- `workload.getOperation(req)` returns one operation by id: a call that
  takes long hands one back, and this asks for it again.
- An event's payload says what happened: a trigger's `TriggerResult` names
  the key's `reason` and its workload, and with `process_exited` or
  `setup_failed` it carries the sandbox's `exitCode` and `message`.
- `workload.listEvents(req)` returns the events after a cursor, oldest
  first, a page at a time, for a client that polls or catches up after
  downtime; `workload.watchEvents(req)` is the live form.
- `workload.jobs.watch(req)`, `workload.sandboxes.watch(req)`,
  `workload.services.watch(req)`, `workload.watchEvents(req)` and
  `workload.jobs.watchOutput(req)` resolve to a watch you read with
  `for await`. A watch opens its stream when you start reading and
  reconnects after a connection failure from where it stopped: `cursor`
  for the typed watches and events, `offsets` (bytes, as `bigint`) for
  output. With no cursor, a typed watch lists that type first, and
  `snapshot` holds them once its promise resolves; `watchEvents`
  yields the past events page by page before the live ones. `close()` or
  leaving the loop ends the stream. The output watch ends at the output's
  end.
- Every watch yields the stream's responses: a job watch yields
  `WatchJobsResponse` (`job`, `cursor`, `type`), an event watch yields
  `WatchEventsResponse` (`event`), and the output watch yields
  `WatchOutputResponse` (`stdout`, `stderr` or `end`).

<!-- examples/watch-events.ts -->

```ts
const id = "workload-id";
const watch = await toshi.workload.watchEvents({ workloadId: id });
for await (const { event } of watch) {
  console.log(event?.name);
}
// watch.cursor resumes a later watch after the last event read.
```

Every helper takes `{ signal }`, an `AbortSignal` that ends it.

### Running a command

`workload.sandboxes.execute(start)` runs a command in a running sandbox
and resolves once the server has started it. The process is one stream of output chunks, `{ stream: "stdout" |
"stderr", data: Uint8Array }`. `write` sends standard input in frames of
at most 64 KiB and resolves once the stream has taken the last one; await
it before the next `write`, which is refused while one is pending, so the
client holds at most one buffer of input. `closeStdin` ends standard input
after a pending write, and a later `write` is refused. `wait` settles when
the command ends.

<!-- examples/execute.ts -->

```ts
const id = "sandbox-id";
const proc = await toshi.workload.sandboxes.execute({
  sandboxId: id,
  command: { argv: ["cat"] },
});
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

### Running a job

`run(req)` creates a job with a `CreateJobRequest` and resolves to the
job and its output, which is what `toshi run` does: `CreateJob`, then
`WatchOutput`. It yields output chunks like an execution, and `wait()`
resolves when the job exits 0 and rejects with `JobExitError` otherwise.

<!-- examples/run-job.ts -->

```ts
const run = await toshi.run({
  spec: { command: { argv: ["./test.sh"] } },
});
for await (const chunk of run) {
  process[chunk.stream].write(chunk.data);
}
await run.wait(); // rejects with JobExitError on a non-zero exit
```

Stopping the loop stops only the output stream: the job keeps running,
and `workload.jobs.cancel` ends it.

## Products that are off

A call for a product that is off for the workspace rejects with a
`ProductError`, `wait`, the watches and `execute` included.
`isProductError(err)` tells it apart. It is still a `ConnectError` with the
same `code`, and it has the product's ID (`product`), the `reason`
(`ProductReason.Unavailable`), the input that turned the product off
(`productCause`: `build`, `operator`, `plan` or `workspace`) and, for a
product the deployment turns off, how far it has wound down (`state`:
`no_new_work`, `draining` or `stopped`).

<!-- examples/product-error.ts -->

```ts
import { isProductError } from "@toshicloud/sdk";

import { toshi } from "./client.js";

// Turn a product on for the workspace.
const enable = { id: "acme_ci", enabled: true };
try {
  await toshi.product.updateProduct(enable);
} catch (err) {
  if (!isProductError(err)) {
    throw err;
  }
  // Off for the workspace: which product, the input that turns it off, and,
  // for the deployment's config, how far it has wound down.
  console.log(err.product, err.productCause, err.state);
}
```

## Refusals with a reason

A refusal that is not a product's rejects with a `RefusalError`;
`isRefusalError(err)` tells it apart. It is still a `ConnectError` with the
same `code`, and its `reason` is one of `RefusalReason`:
`RefusalReason.ImageInUse` when an image a workload or a revision still uses
cannot be deleted, `RefusalReason.ImageNotReady` when a job, a sandbox or a
service revision names a workspace image with no ready version,
`RefusalReason.PlanExcludesImages` when the plan has no images, `RefusalReason.LastIdentity` when the caller's last identity cannot
be unlinked, and so on for images, volumes, roles and display sessions.

`workload.services.rollback` asks the revision's registry whether it still
serves the revision's image before it selects it, and refuses with
`RefusalReason.ImageNotServed` when the registry answered that it does not
serve the image, or `RefusalReason.ImageCheckFailed` when it could not say.
A revision's `imageCheck` carries the last answer: its `outcome`, the
registry's `status` and `message`, and when it was asked, `checkedAt`.
Reading a revision asks no registry.

## Testing with `@toshicloud/sdk/test`

`createFake()` serves the whole Workspace API in memory: no server, no port,
nothing to close, and no Node module, so it runs in the same runtimes as the
client. `fake.client()` returns a `ToshiClient` wired to it, with the token
`test-token` and the scope `default`/`production`, which is enough to drive
`run`, the watchers and the generated clients from a test.

<!-- examples/testing.ts -->

```ts
import { createFake } from "@toshicloud/sdk/test";

const fake = createFake();
fake.job("job-1").stdout("deployed\n").exitCode(0);

const toshi = fake.client();
const run = await toshi.run({ spec: { command: { argv: ["./deploy.sh"] } } });
for await (const chunk of run) {
  process[chunk.stream].write(chunk.data);
}
await run.wait();
```

`fake.on(method, impl)` replaces the state machine for one method with a hook
typed by that method: one call for unary, server-stream and bidirectional
methods alike. `fake.calls()` returns every call the fake received, oldest
first, with the procedure, the request and the headers.

## Generated code

`src/gen/toshi/workspace/v1/` is generated by
[`protoc-gen-es`](https://github.com/bufbuild/protobuf-es) from the protos
in `proto/toshi/workspace/v1` of the
[toshi-api](https://github.com/toshicloud/toshi-api) repository, one
`*_pb.ts` file per proto, and `src/gen/toshi/permission_pb.ts` from
`proto/toshi/permission.proto`, which they import. The generated code is committed and imports
only `@bufbuild/protobuf`, so installing the package needs no generator.

`pin.env` names the toshi-api commit the code is generated from:
`2184ae8440834bb5b91991b3e4d62d14ce9dd15a` today, the commit of the
release tag `v0.4.1`. `mise.toml` pins the versions of Node, pnpm and `buf`;
`package.json` pins `protoc-gen-es` at the same version as the
`@bufbuild/protobuf` development dependency.

To regenerate:

```sh
mise install
pnpm install --frozen-lockfile
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
`0.x` and is generated from a pinned commit. `VERSION` is the package
version, the one `package.json` carries.

## Publishing

Releases are published to npm by the publish workflow
(`.github/workflows/publish.yml`) through npm trusted publishing: the
workflow authenticates with its GitHub OIDC token, and no npm token
exists. It runs on a `vX.Y.Z` tag that matches the version in
`package.json`. A new version is a commit on `main` that sets the version
in `package.json`, followed by its tag.

## Integration test

`test/integration/` runs the client against a real `toshi serve` over
HTTPS with a test CA it mints itself. `TOSHI_INTEGRATION_BIN` names the
`toshi` binary it runs; when `TOSHI_INTEGRATION_EXPECT_COMMIT` is set, the
binary must report that commit:

```sh
TOSHI_INTEGRATION_BIN=/path/to/toshi mise exec -- pnpm vitest run test/integration
```

The Toshi server's CI runs it against each server change. Without
`TOSHI_INTEGRATION_BIN`, `pnpm test` skips the integration test and says
why.

## Licence

Apache License 2.0, see LICENSE.
