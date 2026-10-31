import type { Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import { createToshiClient } from "@toshicloud/sdk/node";

const baseUrl = "https://toshi.example.com";

// An operator's token, the reason its calls carry and the workspace they
// act on.
declare const token: string;

const operator: Interceptor = (next) => (req) => {
  req.header.set("Toshi-Operator-Reason", "investigating a report");
  req.header.set("Toshi-Workspace", "acme");
  return next(req);
};

export const toshi = createToshiClient({
  transport: (interceptors) =>
    createConnectTransport({
      baseUrl,
      httpVersion: "2",
      interceptors: [...interceptors, operator],
    }),
  token,
  project: "default",
});
