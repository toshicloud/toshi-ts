import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http2";
import type { Http2Server, ServerHttp2Session, ServerHttp2Stream } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import type { ConnectRouter, Interceptor, Transport } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as root from "../src/index.js";
import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import { createToshiClient } from "../src/node/client.js";
import type { NodeToshiOptions } from "../src/node/client.js";
import * as nodeEntry from "../src/node/index.js";

const ENV_KEYS = ["TOSHI_SERVER", "TOSHI_TOKEN", "TOSHI_TOKEN_FILE", "TOSHI_CA_FILE"] as const;

const temporaryDirectories: string[] = [];
let savedEnvironment: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnvironment = {};
  for (const key of ENV_KEYS) {
    savedEnvironment[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnvironment[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnvironment[key];
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryFile(name: string, contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "toshi-ts-node-"));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

// A client whose transport is connect's in-memory router, as in client.test.ts.
function clientWith(routes: (router: ConnectRouter) => void, options: NodeToshiOptions = {}): ReturnType<typeof createToshiClient> {
  return createToshiClient({
    ...options,
    transport: (interceptors) => createRouterTransport(routes, { transport: { interceptors } }),
  });
}

function projectOf(req: { readonly message: unknown }): string {
  return (req.message as { project?: string }).project ?? "";
}

describe("the Node entry", () => {
  it("re-exports the root entry with its own createToshiClient", () => {
    expect(nodeEntry.createToshiClient).not.toBe(root.createToshiClient);
    expect(nodeEntry.WorkloadService).toBe(root.WorkloadService);
    expect(nodeEntry.VERSION).toBe(root.VERSION);
  });

  it("keeps VERSION equal to package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(root.VERSION).toBe(pkg.version);
  });
});

describe("environment defaults", () => {
  it("sends TOSHI_TOKEN when no token is given", async () => {
    process.env.TOSHI_TOKEN = "env-token";
    let authorization: string | null = null;
    const client = clientWith((router) => {
      router.service(WorkloadService, {
        getJob(_req, ctx) {
          authorization = ctx.requestHeader.get("authorization");
          return {};
        },
      });
    });

    await client.workload.jobs.get({ id: "job-1" });

    expect(authorization).toBe("Bearer env-token");
  });

  it("picks the token option, then its file, then TOSHI_TOKEN, then TOSHI_TOKEN_FILE", async () => {
    const fromFile = temporaryFile("token", "  file-token\n");
    const cases: ReadonlyArray<readonly [NodeToshiOptions, string | undefined, string | undefined, string]> = [
      [{ token: "option-token" }, "env-token", fromFile, "Bearer option-token"],
      [{ tokenFile: fromFile }, "env-token", undefined, "Bearer file-token"],
      [{}, "env-token", fromFile, "Bearer env-token"],
      [{}, undefined, fromFile, "Bearer file-token"],
    ];
    for (const [options, token, tokenFile, want] of cases) {
      setEnvironment("TOSHI_TOKEN", token);
      setEnvironment("TOSHI_TOKEN_FILE", tokenFile);
      let authorization: string | null = null;
      const client = clientWith((router) => {
        router.service(WorkloadService, {
          getJob(_req, ctx) {
            authorization = ctx.requestHeader.get("authorization");
            return {};
          },
        });
      }, options);
      await client.workload.jobs.get({ id: "job-1" });
      expect(authorization, JSON.stringify(options)).toBe(want);
    }
  });

  it("refuses a missing server and a missing token with the Go client's wording", () => {
    expect(() => createToshiClient({ token: "t" })).toThrow(
      "toshi: no server: use the server option or set TOSHI_SERVER",
    );
    process.env.TOSHI_SERVER = "http://127.0.0.1:1";
    expect(() => createToshiClient({})).toThrow(
      "toshi: no token: use the token or tokenFile option, or set TOSHI_TOKEN or TOSHI_TOKEN_FILE",
    );
  });

  it("reads a token file and refuses a missing or an empty one", () => {
    process.env.TOSHI_SERVER = "http://127.0.0.1:1";
    const missing = join(tmpdir(), "toshi-ts-no-such-token-file");
    expect(() => createToshiClient({ tokenFile: missing })).toThrow(`toshi: read token file ${missing}:`);
    const empty = temporaryFile("empty-token", "  \n");
    expect(() => createToshiClient({ tokenFile: empty })).toThrow(`toshi: token file ${empty} is empty`);
  });

  it("reads TOSHI_CA_FILE, and the caFile option wins over it", () => {
    process.env.TOSHI_SERVER = "http://127.0.0.1:1";
    const fromEnvironment = join(tmpdir(), "toshi-ts-no-such-ca-from-env");
    const fromOption = join(tmpdir(), "toshi-ts-no-such-ca-from-option");
    process.env.TOSHI_CA_FILE = fromEnvironment;
    expect(() => createToshiClient({ token: "t" })).toThrow(`toshi: read CA file ${fromEnvironment}:`);
    expect(() => createToshiClient({ token: "t", caFile: fromOption })).toThrow(
      `toshi: read CA file ${fromOption}:`,
    );
  });

  it("builds a transport from TOSHI_SERVER, TOSHI_TOKEN and the User-Agent over HTTP/2", async () => {
    const server = createHttp2Server();
    const served = await listen(server);
    process.env.TOSHI_SERVER = served.url;
    process.env.TOSHI_TOKEN = "env-token";
    try {
      const client = createToshiClient({ userAgent: "myapp/1.2" });
      const version = await client.workspace.getVersion({});
      expect(version).toBeDefined();
      const headers = served.headers[0];
      expect(headers?.["authorization"]).toBe("Bearer env-token");
      expect(headers?.["user-agent"]).toBe(`myapp/1.2 toshi-ts/${root.VERSION} (node/${process.versions.node})`);
    } finally {
      await served.close();
    }
  });
});

describe("User-Agent", () => {
  it("names the client and the Node version, with userAgent in front when set", async () => {
    const base = `toshi-ts/${root.VERSION} (node/${process.versions.node})`;
    for (const [product, want] of [
      [undefined, base],
      ["myapp/1.2", `myapp/1.2 ${base}`],
      ["", base],
    ] as const) {
      let agent: string | null = null;
      const client = clientWith(
        (router) => {
          router.service(WorkloadService, {
            getJob(_req, ctx) {
              agent = ctx.requestHeader.get("user-agent");
              return {};
            },
          });
        },
        product === undefined ? {} : { userAgent: product },
      );
      await client.workload.jobs.get({ id: "job-1" });
      expect(agent, String(product)).toBe(want);
    }
  });
});

describe("interceptors", () => {
  it("run before scope and auth, once per call, with the retries inside", async () => {
    const events: string[] = [];
    const recording = (name: string): Interceptor => (next) => async (req) => {
      events.push(`${name}:before:${projectOf(req)}:${req.header.get("authorization")}`);
      const resp = await next(req);
      events.push(`${name}:after:${projectOf(req)}:${req.header.get("authorization")}`);
      return resp;
    };
    let calls = 0;
    const client = clientWith(
      (router) => {
        router.service(WorkloadService, {
          getJob() {
            calls += 1;
            if (calls < 3) {
              throw new ConnectError("unavailable", Code.Unavailable);
            }
            return {};
          },
        });
      },
      {
        token: "tok",
        project: "proj",
        environment: "env",
        retry: { maxAttempts: 3, initialBackoffMs: 0, maxBackoffMs: 0 },
        interceptors: [recording("a"), recording("b")],
      },
    );

    await client.workload.jobs.get({ id: "job-1" });

    expect(calls).toBe(3);
    expect(events).toEqual([
      "a:before::null",
      "b:before::null",
      "b:after:proj:null",
      "a:after:proj:null",
    ]);
  });
});

describe("timeouts", () => {
  it("bounds a helper through its retries", async () => {
    const client = clientWith(
      (router) => {
        router.service(WorkloadService, {
          createJob() {
            throw new ConnectError("unavailable", Code.Unavailable);
          },
        });
      },
      { token: "t", retry: { maxAttempts: 5, initialBackoffMs: 2_000, maxBackoffMs: 2_000 } },
    );

    const started = Date.now();
    const failure = client.run({ spec: { command: { argv: ["true"] } } }, { timeoutMs: 50 });
    await expect(failure).rejects.toMatchObject({ code: Code.DeadlineExceeded });
    await expect(failure).rejects.toThrow("the call timed out after 50 ms");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("bounds a wait that keeps answering not reached", async () => {
    const client = clientWith(
      (router) => {
        router.service(WorkloadService, {
          async waitJob() {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return { reached: false };
          },
        });
      },
      { token: "t", retry: false },
    );

    await expect(client.workload.jobs.wait({ id: "job-1" }, { timeoutMs: 50 })).rejects.toThrow(
      "the call timed out after 50 ms",
    );
  });

  it("gives each unary call defaultTimeoutMs and leaves streams alone", async () => {
    const captured = captureTransport();
    const client = createToshiClient({
      token: "t",
      defaultTimeoutMs: 250,
      transport: () => captured.transport,
    });

    await client.workspace.getVersion({});
    await client.workspace.getVersion({}, { timeoutMs: 100 });

    const watch = await client.workload.jobs.watch({ cursor: "cursor-1" });
    const iterator = watch[Symbol.asyncIterator]();
    await iterator.next();
    watch.close();

    expect(captured.calls.map((call) => [call.method, call.timeoutMs])).toEqual([
      ["GetVersion", 250],
      ["GetVersion", 100],
      ["WatchJobs", undefined],
    ]);
  });

  it("does not cut a Wait call with defaultTimeoutMs, and still cuts another unary call", async () => {
    const client = createToshiClient({
      token: "t",
      defaultTimeoutMs: 20,
      transport: () => delayedTransport(80),
    });

    // WaitJob is a long poll: its request's timeout bounds it, so the answer
    // arrives after the default would have cut it.
    const resp = await client.workload.jobs.wait({ id: "job-1" });
    expect(resp.reached).toBe(true);

    // Every other unary call still gets the default.
    await expect(client.workspace.getVersion({})).rejects.toMatchObject({ code: Code.DeadlineExceeded });
  });
});

function setEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

// One message as an AsyncIterable, without an async generator that has no await.
function oneMessage<T>(value: T): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let sent = false;
      return {
        next(): Promise<IteratorResult<T>> {
          if (sent) {
            return Promise.resolve({ done: true, value: undefined });
          }
          sent = true;
          return Promise.resolve({ done: false, value });
        },
      };
    },
  };
}

// A transport that answers after delayMs and, like connect, cuts a call at its
// timeoutMs; a call without one is never cut.
function delayedTransport(delayMs: number): Transport {
  return {
    unary(method, signal, timeoutMs) {
      return new Promise((resolve, reject) => {
        const init = method.name.startsWith("Wait") ? { reached: true } : {};
        const answer = setTimeout(() => {
          if (cut !== undefined) {
            clearTimeout(cut);
          }
          resolve({
            stream: false,
            service: method.parent,
            method,
            header: new Headers(),
            trailer: new Headers(),
            message: create(method.output, init as never),
          });
        }, delayMs);
        let cut: ReturnType<typeof setTimeout> | undefined;
        if (timeoutMs !== undefined) {
          cut = setTimeout(() => {
            clearTimeout(answer);
            reject(new ConnectError(`the call timed out after ${timeoutMs} ms`, Code.DeadlineExceeded));
          }, timeoutMs);
        }
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(answer);
            if (cut !== undefined) {
              clearTimeout(cut);
            }
            reject(new ConnectError("the call was cancelled", Code.Canceled));
          },
          { once: true },
        );
      });
    },
    stream() {
      return Promise.reject(new Error("delayedTransport has no streams"));
    },
  };
}

interface CapturedCall {
  readonly method: string;
  readonly timeoutMs: number | undefined;
}

// A transport below the client's interceptors: it records the arguments the
// client hands it and answers empty messages.
function captureTransport(): { readonly transport: Transport; readonly calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const transport: Transport = {
    unary(method, _signal, timeoutMs) {
      calls.push({ method: method.name, timeoutMs });
      return Promise.resolve({
        stream: false,
        service: method.parent,
        method,
        header: new Headers(),
        trailer: new Headers(),
        message: create(method.output, {} as never),
      });
    },
    stream(method, _signal, timeoutMs) {
      calls.push({ method: method.name, timeoutMs });
      return Promise.resolve({
        stream: true,
        service: method.parent,
        method,
        header: new Headers(),
        trailer: new Headers(),
        message: oneMessage(create(method.output, {} as never)),
      });
    },
  };
  return { transport, calls };
}

interface Served {
  readonly url: string;
  readonly headers: Array<Record<string, string | string[] | undefined>>;
  close(): Promise<void>;
}

// An HTTP/2 server that answers every Connect unary call with an empty message.
function createHttp2Server(): Http2Server {
  return createServer();
}

async function listen(server: Http2Server): Promise<Served> {
  const headers: Served["headers"] = [];
  server.on("stream", (stream, value) => {
    headers.push(value);
    const reply = stream as ServerHttp2Stream;
    reply.respond({ ":status": 200, "content-type": "application/proto" });
    reply.end(Buffer.alloc(0));
  });
  const sessions: ServerHttp2Session[] = [];
  server.on("session", (session) => {
    sessions.push(session);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server has no port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    headers,
    async close(): Promise<void> {
      for (const session of sessions) {
        session.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
