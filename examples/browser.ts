import { createConnectTransport } from "@connectrpc/connect-web";
import { createToshiClient } from "@toshicloud/sdk";

// The token the browser app already holds.
declare const token: string;

export const toshi = createToshiClient({
  transport: (interceptors) =>
    createConnectTransport({ baseUrl: "https://toshi.example.com", interceptors }),
  token,
  project: "default",
});
