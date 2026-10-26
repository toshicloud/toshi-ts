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
