# Testing with `@toshicloud/sdk/test`


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

The fake also keeps a service's alarms: `setAlarm`, `getAlarm`, `listAlarms`,
`deleteAlarm`, `pauseAlarm`, `resumeAlarm` and `runAlarmNow` answer from its
state machine.

`fake.on(method, impl)` replaces the state machine for one method with a hook
typed by that method: one call for unary, server-stream and bidirectional
methods alike. `fake.calls()` returns every call the fake received, oldest
first, with the procedure, the request and the headers.

