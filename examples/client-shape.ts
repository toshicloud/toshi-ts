import { toshi } from "./client.js";

const { jobs } = await toshi.workload.jobs.list({ pageSize: 10 });
const { job } = await toshi.workload.jobs.get({ id: jobs[0].id });
console.log(job?.id);
