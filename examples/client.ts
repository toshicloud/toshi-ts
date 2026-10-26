import { createConnectTransport } from "@connectrpc/connect-node";
import { createToshiClient } from "@toshicloud/sdk";

// The client the other examples use; the quick start shows the same setup in full.
export const toshi = createToshiClient({
  transport: (interceptors) =>
    createConnectTransport({
      baseUrl: "https://toshi.example.com",
      httpVersion: "2",
      interceptors,
    }),
  token: process.env.TOSHI_TOKEN,
  project: "default",
});
