import { BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import type { ConnectRouter, Interceptor, Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { createToshiClient } from "../src/client.js";
import type { ToshiClient } from "../src/client.js";
import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";

// Each wait before a retry is a setTimeout of the fake clock, so a test
// records it and spends no time on it. The policy backs off at most 1 ms on
// the first retry, so a longer wait is the server's, and caps a wait at 5 s.
const retry = { maxAttempts: 4, initialBackoffMs: 1, maxBackoffMs: 5_000 };

let timers: MockInstance<typeof setTimeout>;
let fakeTimeout: typeof setTimeout;

beforeEach(() => {
  vi.useFakeTimers();
  fakeTimeout = globalThis.setTimeout;
  timers = vi.spyOn(globalThis, "setTimeout");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function waits(): number[] {
  return timers.mock.calls.map((call) => call[1] ?? 0);
}

function client(transport: (interceptors: Interceptor[]) => Transport): ToshiClient {
  return createToshiClient({ retry, transport });
}

function routed(routes: (router: ConnectRouter) => void): ToshiClient {
  return client((interceptors) => createRouterTransport(routes, { transport: { interceptors } }));
}

/** google.rpc.RetryInfo with a retry_delay of whole seconds. */
function retryInfo(seconds: number): { type: string; value: Uint8Array } {
  const writer = new BinaryWriter();
  writer.tag(1, WireType.LengthDelimited).fork().tag(1, WireType.Varint).int64(seconds).join();
  return { type: "google.rpc.RetryInfo", value: writer.finish() };
}

/** A RESOURCE_EXHAUSTED refusal as the API's rate limit makes one, each part left out when undefined. */
function exhausted(retryInfoSeconds: number | undefined, retryAfter: string | undefined): ConnectError {
  const metadata = new Headers();
  if (retryAfter !== undefined) {
    metadata.set("Retry-After", retryAfter);
  }
  const err = new ConnectError("too many requests", Code.ResourceExhausted, metadata);
  if (retryInfoSeconds !== undefined) {
    err.details.push(retryInfo(retryInfoSeconds));
  }
  return err;
}

/** A client whose GetJob answers with errs in turn, then succeeds; calls counts the requests. */
function refusing(...errs: ConnectError[]): { client: ToshiClient; calls: () => number } {
  let calls = 0;
  const harness = routed((router) => {
    router.service(WorkloadService, {
      getJob() {
        calls += 1;
        const err = errs[calls - 1];
        if (err !== undefined) {
          throw err;
        }
        return {};
      },
    });
  });
  return { client: harness, calls: () => calls };
}

async function settle<T>(pending: Promise<T>): Promise<T> {
  // A rejection is handled when it happens, not only once the timers have run.
  pending.catch(() => undefined);
  await vi.runAllTimersAsync();
  return pending;
}

describe("retry after RESOURCE_EXHAUSTED", () => {
  it.each([
    { name: "RetryInfo", retryInfoSeconds: 3, retryAfter: undefined, want: 3_000 },
    { name: "Retry-After", retryInfoSeconds: undefined, retryAfter: "2", want: 2_000 },
    { name: "both, RetryInfo wins", retryInfoSeconds: 4, retryAfter: "1", want: 4_000 },
    { name: "capped at maxBackoffMs", retryInfoSeconds: 30, retryAfter: "30", want: 5_000 },
  ])("waits for the server's wait: $name", async ({ retryInfoSeconds, retryAfter, want }) => {
    const { client, calls } = refusing(exhausted(retryInfoSeconds, retryAfter));
    await settle(client.workload.jobs.get({ id: "w" }));
    expect(calls()).toBe(2);
    expect(waits()).toEqual([want]);
  });

  it("returns a refusal that names no wait without a retry", async () => {
    const { client, calls } = refusing(exhausted(undefined, undefined));
    const err: unknown = await settle(client.workload.jobs.get({ id: "w" })).catch((reason: unknown) => reason);
    expect(ConnectError.from(err).code).toBe(Code.ResourceExhausted);
    expect(calls()).toBe(1);
    expect(waits()).toEqual([]);
  });

  it("stops waiting when the signal aborts", async () => {
    const controller = new AbortController();
    timers.mockImplementation(((handler: () => void, ms?: number) => {
      // Abort once the wait has started.
      queueMicrotask(() => controller.abort());
      return fakeTimeout(handler, ms);
    }) as typeof setTimeout);
    const { client, calls } = refusing(exhausted(3, "3"));
    const err: unknown = await settle(client.workload.jobs.get({ id: "w" }, { signal: controller.signal })).catch(
      (reason: unknown) => reason,
    );
    expect(ConnectError.from(err).code).toBe(Code.Canceled);
    expect(calls()).toBe(1);
    expect(waits()).toEqual([3_000]);
  });
});

/**
 * A client over a fetch that answers the first request with status and a
 * Retry-After in plain text, as a proxy would, and every other with an empty
 * GetJob response.
 */
function plainFirst(status: number, retryAfter: string): ToshiClient {
  let served = false;
  const fetchFake = (): Promise<Response> => {
    if (!served) {
      served = true;
      return Promise.resolve(
        new Response("slow down\n", { status, headers: { "Content-Type": "text/plain", "Retry-After": retryAfter } }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
  };
  return client((interceptors) =>
    createConnectTransport({ baseUrl: "https://toshi.test", interceptors, fetch: fetchFake }),
  );
}

describe("retry after an HTTP status", () => {
  it("waits for a 429's Retry-After", async () => {
    await settle(plainFirst(429, "2").workload.jobs.get({ id: "w" }));
    expect(waits()).toEqual([2_000]);
  });

  it("keeps the backoff after a 503, whatever its Retry-After", async () => {
    await settle(plainFirst(503, "7").workload.jobs.get({ id: "w" }));
    const [wait, ...rest] = waits();
    expect(rest).toEqual([]);
    expect(wait).toBeLessThanOrEqual(1);
  });
});
