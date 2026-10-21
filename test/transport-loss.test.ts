import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { constants, createServer } from "node:http2";
import type { ServerHttp2Session, ServerHttp2Stream } from "node:http2";
import { describe, expect, it } from "vitest";

import { createToshiClient } from "../src/client.js";
import type { ToshiClient } from "../src/client.js";
import { ListProjectsResponseSchema } from "../src/gen/toshi/workspace/v1/projects_pb.js";
import {
  WatchWorkloadsRequestSchema,
  WatchWorkloadsResponseSchema,
} from "../src/gen/toshi/workspace/v1/workspace_pb.js";
import { isStreamLoss } from "../src/retry.js";

const watchPath = "/toshi.workspace.v1.WorkspaceService/WatchWorkloads";
const projectsPath = "/toshi.workspace.v1.ProjectService/ListProjects";

// Connect envelopes: one flag byte, a uint32 BE length, then the message bytes.
// 0x02 marks the EndStreamResponse (protocol-connect/end-stream.js endStreamFlag).
const messageFlag = 0;
const endStreamFlag = 0x02;

interface ServerRequest {
  readonly path: string;
  readonly stream: ServerHttp2Stream;
  body: Buffer;
}

type StreamHandler = (request: ServerRequest) => void;

interface TestServer {
  readonly baseUrl: string;
  readonly requests: ServerRequest[];
  close(): Promise<void>;
}

// A cleartext HTTP/2 server that speaks the raw Connect protocol: it records
// every stream it sees and hands the request body to the handler for its path.
async function startServer(handlers: Readonly<Record<string, StreamHandler>>): Promise<TestServer> {
  const requests: ServerRequest[] = [];
  const sessions = new Set<ServerHttp2Session>();
  const server = createServer();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.on("error", () => {
    // A reset stream or an aborted session is the point of some tests.
  });
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {
      // RST_STREAM leaves an error on this side too; the client is what matters.
    });
    const rawPath = headers[":path"];
    const path = typeof rawPath === "string" ? rawPath : "";
    const request: ServerRequest = { path, stream, body: Buffer.alloc(0) };
    requests.push(request);
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      request.body = Buffer.concat(chunks);
      const handler = handlers[path];
      if (handler === undefined) {
        respondUnary(stream, new Uint8Array(), 404);
        return;
      }
      handler(request);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server did not bind a port");
  }
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const session of sessions) {
          session.destroy();
        }
      }),
  };
}

function toshiClient(baseUrl: string): ToshiClient {
  return createToshiClient({
    transport: (interceptors) => createConnectTransport({ baseUrl, httpVersion: "2", interceptors }),
    retry: { maxAttempts: 4, initialBackoffMs: 5, maxBackoffMs: 20 },
  });
}

function envelope(flags: number, payload: Uint8Array): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, Buffer.from(payload)]);
}

function watchMessage(cursor: string): Buffer {
  const message = create(WatchWorkloadsResponseSchema, { cursor });
  return envelope(messageFlag, toBinary(WatchWorkloadsResponseSchema, message));
}

function endStream(error?: { readonly code: string; readonly message: string }): Buffer {
  const body = error === undefined ? {} : { error };
  return envelope(endStreamFlag, new TextEncoder().encode(JSON.stringify(body)));
}

// The single WatchWorkloadsRequest message the client sends, out of its first envelope.
function decodeWatchCursor(body: Buffer): string {
  if (body.byteLength < 5) {
    throw new Error("the watch request sent no envelope");
  }
  const length = body.readUInt32BE(1);
  return fromBinary(WatchWorkloadsRequestSchema, body.subarray(5, 5 + length)).cursor;
}

function respondStream(stream: ServerHttp2Stream): void {
  stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
}

function respondUnary(stream: ServerHttp2Stream, body: Uint8Array, status = 200): void {
  stream.respond({ ":status": status, "content-type": "application/proto" });
  stream.end(Buffer.from(body));
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve: () => {
      settle?.();
    },
  };
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) {
      throw new Error("condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function value<T>(result: IteratorResult<T>): T | undefined {
  return result.done === true ? undefined : result.value;
}

// A watch stream that sends one message and then waits; the server holds it open.
function holdOpen(stream: ServerHttp2Stream, cursor: string): void {
  respondStream(stream);
  stream.write(watchMessage(cursor));
}

describe("over a real HTTP/2 Connect transport", () => {
  it("resumes a workload watch after the server resets the stream mid-way", async () => {
    const cursors: string[] = [];
    const reset = deferred();
    const server = await startServer({
      [watchPath]: (request) => {
        cursors.push(decodeWatchCursor(request.body));
        if (cursors.length === 1) {
          respondStream(request.stream);
          request.stream.write(watchMessage("c1"), () => {
            // Reset once the client is waiting for the next message.
            void reset.promise.then(() => {
              request.stream.close(constants.NGHTTP2_INTERNAL_ERROR);
            });
          });
          return;
        }
        holdOpen(request.stream, "c2");
      },
    });
    const client = toshiClient(server.baseUrl);
    const watch = await client.watchWorkloads({ cursor: "c0" });
    const reader = watch[Symbol.asyncIterator]();
    try {
      const first = await reader.next();
      expect(value(first)?.cursor).toBe("c1");
      const second = reader.next();
      reset.resolve();
      await until(() => cursors.length === 2);
      expect(value(await second)?.cursor).toBe("c2");
      expect(cursors).toEqual(["c0", "c1"]);
      expect(server.requests).toHaveLength(2);
    } finally {
      watch.close();
      await server.close();
    }
  });

  it("resumes a workload watch after a stream ends without its EndStreamResponse", async () => {
    const cursors: string[] = [];
    const server = await startServer({
      [watchPath]: (request) => {
        cursors.push(decodeWatchCursor(request.body));
        if (cursors.length === 1) {
          respondStream(request.stream);
          request.stream.end(watchMessage("c1"));
          return;
        }
        holdOpen(request.stream, "c2");
      },
    });
    const client = toshiClient(server.baseUrl);
    const watch = await client.watchWorkloads({ cursor: "c0" });
    const reader = watch[Symbol.asyncIterator]();
    try {
      const first = await reader.next();
      expect(value(first)?.cursor).toBe("c1");
      const second = await reader.next();
      expect(value(second)?.cursor).toBe("c2");
      expect(cursors).toEqual(["c0", "c1"]);
      expect(server.requests).toHaveLength(2);
    } finally {
      watch.close();
      await server.close();
    }
  });

  it("retries a unary read whose response is reset", async () => {
    let calls = 0;
    const server = await startServer({
      [projectsPath]: (request) => {
        calls += 1;
        if (calls === 1) {
          // A dying connection gives the retried ECONNRESET.
          request.stream.respond({ ":status": 200, "content-type": "application/proto" });
          setTimeout(() => request.stream.session?.socket?.resetAndDestroy(), 5);
          return;
        }
        const response = create(ListProjectsResponseSchema, { projects: [{ name: "alpha" }] });
        respondUnary(request.stream, toBinary(ListProjectsResponseSchema, response));
      },
    });
    const client = toshiClient(server.baseUrl);
    try {
      const response = await client.projects.listProjects({});
      expect(calls).toBe(2);
      expect(server.requests).toHaveLength(2);
      expect(response.projects.map((project) => project.name)).toEqual(["alpha"]);
    } finally {
      await server.close();
    }
  });

  it("retries a unary read whose stream is reset with REFUSED_STREAM", async () => {
    let calls = 0;
    const server = await startServer({
      [projectsPath]: (request) => {
        calls += 1;
        if (calls === 1) {
          request.stream.close(constants.NGHTTP2_REFUSED_STREAM);
          return;
        }
        const response = create(ListProjectsResponseSchema, { projects: [{ name: "alpha" }] });
        respondUnary(request.stream, toBinary(ListProjectsResponseSchema, response));
      },
    });
    const client = toshiClient(server.baseUrl);
    try {
      const response = await client.projects.listProjects({});
      expect(calls).toBe(2);
      expect(response.projects.map((project) => project.name)).toEqual(["alpha"]);
    } finally {
      await server.close();
    }
  });

  it("does not retry a unary read whose stream is reset with INTERNAL_ERROR", async () => {
    let calls = 0;
    const server = await startServer({
      [projectsPath]: (request) => {
        calls += 1;
        request.stream.close(constants.NGHTTP2_INTERNAL_ERROR);
      },
    });
    const client = toshiClient(server.baseUrl);
    try {
      await expect(client.projects.listProjects({})).rejects.toMatchObject({ code: Code.Internal });
      expect(calls).toBe(1);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("matches the missing-EndStreamResponse error exactly and passes a server Aborted error through", async () => {
    const missing = await startServer({
      [watchPath]: (request) => {
        respondStream(request.stream);
        request.stream.end(watchMessage("c1"));
      },
    });
    const client = toshiClient(missing.baseUrl);
    const seen: string[] = [];
    let thrown: unknown;
    try {
      for await (const message of client.workspace.watchWorkloads(
        create(WatchWorkloadsRequestSchema, { cursor: "c0" }),
      )) {
        seen.push(message.cursor);
      }
    } catch (err) {
      thrown = err;
    }
    await missing.close();
    expect(seen).toEqual(["c1"]);
    expect(thrown).toBeInstanceOf(ConnectError);
    if (!(thrown instanceof ConnectError)) {
      throw new Error("the stream did not fail with a ConnectError");
    }
    expect(thrown.code).toBe(Code.InvalidArgument);
    expect(thrown.rawMessage).toBe("protocol error: missing EndStreamResponse");
    expect(isStreamLoss(thrown)).toBe(true);
    expect(isStreamLoss(new ConnectError("stop", Code.Aborted))).toBe(false);

    const aborted = await startServer({
      [watchPath]: (request) => {
        respondStream(request.stream);
        request.stream.end(endStream({ code: "aborted", message: "stop" }));
      },
    });
    const watch = await toshiClient(aborted.baseUrl).watchWorkloads({ cursor: "c0" });
    try {
      await expect(watch[Symbol.asyncIterator]().next()).rejects.toMatchObject({
        code: Code.Aborted,
        rawMessage: "stop",
      });
      expect(aborted.requests).toHaveLength(1);
    } finally {
      watch.close();
      await aborted.close();
    }
  });
});
