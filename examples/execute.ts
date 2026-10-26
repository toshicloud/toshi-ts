import { toshi } from "./client.js";

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
