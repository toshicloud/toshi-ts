import { createToshiClient } from "@toshicloud/sdk/node";

// A token a refresh loop replaces; the client asks for it on every call.
let token = "first-token";

export const toshi = createToshiClient({
  project: "default",
  tokenSource: () => token,
});

export function rotate(next: string): void {
  token = next;
}
