import { createToshiClient } from "@toshicloud/sdk/node";

const toshi = createToshiClient({ project: "default" });

const { projects } = await toshi.project.listProjects({});
console.log(projects.length);
