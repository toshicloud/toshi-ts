import { toshi } from "./client.js";

const run = await toshi.run({
  spec: { command: { argv: ["./test.sh"] } },
});
for await (const chunk of run) {
  process[chunk.stream].write(chunk.data);
}
await run.wait(); // rejects with JobExitError on a non-zero exit
