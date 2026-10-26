import { createToshiClient } from "@toshicloud/sdk/node";

// The client the other examples use; the quick start shows the environment defaults.
export const toshi = createToshiClient({
  server: "https://toshi.example.com",
  token: process.env.TOSHI_TOKEN,
  project: "default",
});
