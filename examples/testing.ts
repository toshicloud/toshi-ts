import { createFake } from "@toshicloud/sdk/test";

const fake = createFake();
fake.job("job-1").stdout("deployed\n").exitCode(0);

const toshi = fake.client();
const run = await toshi.run({ spec: { command: { argv: ["./deploy.sh"] } } });
for await (const chunk of run) {
  process[chunk.stream].write(chunk.data);
}
await run.wait();
