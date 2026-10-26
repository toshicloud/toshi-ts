import { toshi } from "./client.js";

const id = "workload-id";
const watch = await toshi.workload.watchEvents({ workloadId: id });
for await (const { event } of watch) {
  console.log(event?.name);
}
// watch.cursor resumes a later watch after the last event read.
