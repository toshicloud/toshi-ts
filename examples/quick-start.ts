import { readFileSync } from "node:fs";
import { createConnectTransport } from "@connectrpc/connect-node";
import { createToshiClient } from "@toshicloud/sdk";

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

const { projects } = await toshi.project.listProjects({});
console.log(projects.length);
