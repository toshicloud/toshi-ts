import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { createAsyncIterable } from "@connectrpc/connect/protocol";
import type { Client } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import type { OutputChunk } from "../src/client.js";
import { ExitError, StreamLostError } from "../src/errors.js";
import { executeCommand } from "../src/execute.js";
import { WorkloadService } from "../src/gen/toshi/workspace/v1/workloads_pb.js";
import {
  ExecuteResponseSchema,
  ExecuteStartSchema,
  type ExecuteRequest,
  type ExecuteResponse,
  type ExecuteStart,
} from "../src/gen/toshi/workspace/v1/workspace_pb.js";

const BROWSER_MESSAGE =
  'toshi: Execute needs a Node transport over HTTP/2 (@connectrpc/connect-node with httpVersion "2"); a browser cannot open a bidirectional stream';

function start(requestKey = "key-1"): ExecuteStart {
  return create(ExecuteStartSchema, { sandboxId: "wl-1", requestKey });
}

/** A client whose Execute handler is the given stream. */
function clientWith(
  execute: (requests: AsyncIterable<ExecuteRequest>) => AsyncIterable<ExecuteResponse>,
): Client<typeof WorkloadService> {
  const transport = createRouterTransport((router) => {
    router.service(WorkloadService, { execute });
  });
  return createClient(WorkloadService, transport);
}

/** The start message a handler was given, failing when it was not one. */
function readStart(result: IteratorResult<ExecuteRequest>): ExecuteStart {
  if (result.done === true || result.value.message.case !== "start") {
    throw new Error("the handler did not receive the start message");
  }
  return result.value.message.value;
}

/** Waits for the handler's first message; fails the stream when it is not a start. */
async function firstMessage(requests: AsyncIterable<ExecuteRequest>): Promise<ExecuteStart> {
  return readStart(await requests[Symbol.asyncIterator]().next());
}

/** A handler that reads the start and then refuses the stream without yielding. */
function refusing(cause: Error): (requests: AsyncIterable<ExecuteRequest>) => AsyncIterable<ExecuteResponse> {
  return (requests) => ({
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        await firstMessage(requests);
        throw cause;
      },
    }),
  });
}

function startedResponse(executionId: string): ExecuteResponse {
  return create(ExecuteResponseSchema, {
    message: { case: "started", value: { executionId } },
  });
}

function outputResponse(stream: "stdout" | "stderr", text: string): ExecuteResponse {
  return create(ExecuteResponseSchema, {
    message: { case: stream, value: new TextEncoder().encode(text) },
  });
}

function exitResponse(exit: { exitCode?: number; cancelled?: boolean }): ExecuteResponse {
  return create(ExecuteResponseSchema, { message: { case: "exit", value: exit } });
}

/** The rejection reason of a promise that must not resolve. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

function chunkOf(result: IteratorResult<OutputChunk>): OutputChunk {
  if (result.done === true) {
    throw new Error("expected an output chunk");
  }
  return result.value;
}

function textOf(chunk: OutputChunk): string {
  return new TextDecoder().decode(chunk.data);
}

describe("executeCommand", () => {
  it("rejects in a browser before it touches the transport", async () => {
    let calls = 0;
    const client = clientWith(() => {
      calls += 1;
      return createAsyncIterable([exitResponse({ exitCode: 0 })]);
    });
    const original = globalThis.process;
    try {
      Object.defineProperty(globalThis, "process", {
        value: undefined,
        configurable: true,
        writable: true,
      });
      await expect(executeCommand(client, start())).rejects.toThrow(BROWSER_MESSAGE);
    } finally {
      Object.defineProperty(globalThis, "process", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
    expect(calls).toBe(0);
  });

  it("rejects a call without a start message", async () => {
    const client = clientWith(() => {
      throw new Error("the transport must not be called");
    });
    await expect(executeCommand(client, undefined)).rejects.toThrow(
      "toshi: Execute needs a start message",
    );
  });

  it("rejects when the first answer is not started", async () => {
    const client = clientWith(async function* (requests) {
      await firstMessage(requests);
      yield outputResponse("stdout", "early");
    });
    await expect(executeCommand(client, start())).rejects.toThrow(
      "toshi: the Execute stream did not answer with a started message",
    );
  });

  it("returns the server's ConnectError when it answers before started", async () => {
    const client = clientWith(refusing(new ConnectError("workload is not running", Code.FailedPrecondition)));
    const error = await rejection(executeCommand(client, start()));
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).code).toBe(Code.FailedPrecondition);
    expect((error as ConnectError).rawMessage).toBe("workload is not running");
  });

  it("wraps a transport loss before started with the request key", async () => {
    const client = clientWith(refusing(new ConnectError("connection reset", Code.Unavailable)));
    const error = await rejection(executeCommand(client, start("key-before")));
    expect(error).toBeInstanceOf(StreamLostError);
    expect((error as StreamLostError).executionId).toBe("");
    expect((error as StreamLostError).requestKey).toBe("key-before");
    expect((error as StreamLostError).cause).toBeInstanceOf(ConnectError);
    expect(((error as StreamLostError).cause as ConnectError).code).toBe(Code.Unavailable);
  });

  it("wraps a transport loss after started with the execution and the cause", async () => {
    const client = clientWith(async function* (requests) {
      await firstMessage(requests);
      yield startedResponse("exec-1");
      throw new ConnectError("connection reset", Code.Unavailable);
    });
    const process = await executeCommand(client, start("key-after"));
    const error = await rejection(process.wait());
    expect(error).toBeInstanceOf(StreamLostError);
    expect((error as StreamLostError).executionId).toBe("exec-1");
    expect((error as StreamLostError).requestKey).toBe("key-after");
    expect((error as StreamLostError).cause).toBeInstanceOf(ConnectError);
    expect(((error as StreamLostError).cause as ConnectError).code).toBe(Code.Unavailable);
    expect((error as StreamLostError).message).toContain(
      "toshi: execution exec-1 stream lost (request key key-after): ",
    );
  });

  it("resolves for exit status 0", async () => {
    const client = clientWith(async function* (requests) {
      await firstMessage(requests);
      yield startedResponse("exec-1");
      yield outputResponse("stdout", "out");
      yield outputResponse("stderr", "err");
      yield exitResponse({ exitCode: 0 });
    });
    const process = await executeCommand(client, start());
    const chunks: OutputChunk[] = [];
    for await (const chunk of process) {
      chunks.push(chunk);
    }
    await expect(process.wait()).resolves.toBeUndefined();
    expect(chunks.map(textOf)).toEqual(["out", "err"]);
  });

  it("rejects a non-zero exit with its status", async () => {
    const client = clientWith(async function* (requests) {
      await firstMessage(requests);
      yield startedResponse("exec-1");
      yield exitResponse({ exitCode: 7 });
    });
    const process = await executeCommand(client, start());
    const error = await rejection(process.wait());
    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).message).toBe("toshi: execution exec-1 exited with status 7");
    expect((error as ExitError).exit.exitCode).toBe(7);
  });

  it("rejects a cancelled exit", async () => {
    const client = clientWith(async function* (requests) {
      await firstMessage(requests);
      yield startedResponse("exec-1");
      yield exitResponse({ cancelled: true });
    });
    const process = await executeCommand(client, start());
    const error = await rejection(process.wait());
    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).message).toBe("toshi: execution exec-1 was cancelled");
  });

  it("rejects an exit without a status", async () => {
    const client = clientWith(async function* (requests) {
      await firstMessage(requests);
      yield startedResponse("exec-1");
      yield exitResponse({});
    });
    const process = await executeCommand(client, start());
    const error = await rejection(process.wait());
    expect(error).toBeInstanceOf(ExitError);
    expect((error as ExitError).message).toBe("toshi: execution exec-1 ended without an exit status");
  });

  it("wait() does not take output from an active reader", async () => {
    const client = clientWith(async function* (requests) {
      await firstMessage(requests);
      yield startedResponse("exec-1");
      yield outputResponse("stdout", "one");
      yield outputResponse("stdout", "two");
      yield exitResponse({ exitCode: 0 });
    });
    const process = await executeCommand(client, start());
    const iterator = process[Symbol.asyncIterator]();
    expect(textOf(chunkOf(await iterator.next()))).toBe("one");
    const waiting = process.wait();
    expect(textOf(chunkOf(await iterator.next()))).toBe("two");
    expect((await iterator.next()).done).toBe(true);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("wait() drains the output when nothing reads it", async () => {
    const client = clientWith(async function* (requests) {
      await firstMessage(requests);
      yield startedResponse("exec-1");
      yield outputResponse("stdout", "out");
      yield outputResponse("stderr", "err");
      yield exitResponse({ exitCode: 0 });
    });
    const process = await executeCommand(client, start());
    await expect(process.wait()).resolves.toBeUndefined();
    expect(process.wait()).toBe(process.wait());
  });

  it("throws when a second reader asks for the output", async () => {
    const client = clientWith(async function* (requests) {
      await firstMessage(requests);
      yield startedResponse("exec-1");
      yield exitResponse({ exitCode: 0 });
    });
    const process = await executeCommand(client, start());
    const iterator = process[Symbol.asyncIterator]();
    expect(() => process[Symbol.asyncIterator]()).toThrow(
      "toshi: this process already has an output reader",
    );
    await iterator.return?.(undefined);
    await rejection(process.wait());
  });

  it("aborts the stream when the reader breaks early", async () => {
    const client = clientWith(async function* (requests) {
      await firstMessage(requests);
      yield startedResponse("exec-1");
      yield outputResponse("stdout", "one");
      yield outputResponse("stdout", "two");
      yield exitResponse({ exitCode: 0 });
    });
    const process = await executeCommand(client, start());
    const iterator = process[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.(undefined);
    const error = await rejection(process.wait());
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).code).toBe(Code.Canceled);
  });

  it("rejects a write blocked by backpressure when the call is aborted", async () => {
    let release: (() => void) | undefined;
    const client = clientWith(async function* (requests) {
      await firstMessage(requests);
      yield startedResponse("exec-1");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const controller = new AbortController();
    const process = await executeCommand(client, start(), { signal: controller.signal });
    // The handler never reads stdin, so the frames queue up behind the writer.
    const pending = process.write(new Uint8Array(200_000));
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const error = await rejection(pending);
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).code).toBe(Code.Canceled);
    await rejection(process.wait());
    release?.();
  });

  it("starts nothing when the signal is already aborted", async () => {
    let calls = 0;
    const client = clientWith(async function* (requests) {
      calls += 1;
      await firstMessage(requests);
      yield startedResponse("exec-1");
    });
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(executeCommand(client, start(), { signal: controller.signal }));
    expect(error).toBeInstanceOf(ConnectError);
    expect((error as ConnectError).code).toBe(Code.Canceled);
    expect(calls).toBe(0);
  });

  it("refuses a write while another is pending and holds no second buffer", async () => {
    let release: (() => void) | undefined;
    const client = clientWith(async function* (requests) {
      await firstMessage(requests);
      yield startedResponse("exec-1");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const controller = new AbortController();
    const process = await executeCommand(client, start(), { signal: controller.signal });
    // The handler never reads stdin: the first write stays pending.
    const first = process.write(new Uint8Array(200_000));
    const second = await rejection(process.write("more"));
    expect((second as Error).message).toBe("toshi: a write is still pending; await it before writing again");
    controller.abort();
    await rejection(first);
    await rejection(process.wait());
    release?.();
  });

  it("refuses a write after closeStdin, also while the close waits on an earlier write", async () => {
    const stdin: string[] = [];
    let closed = false;
    const client = clientWith(async function* (requests) {
      const iterator = requests[Symbol.asyncIterator]();
      readStart(await iterator.next());
      yield startedResponse("exec-1");
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          return;
        }
        const message = next.value.message;
        if (message.case === "stdin") {
          stdin.push(new TextDecoder().decode(message.value));
        }
        if (message.case === "closeStdin") {
          closed = true;
          break;
        }
      }
      // The command keeps running and never reads stdin again.
      yield exitResponse({ exitCode: 0 });
    });
    const process = await executeCommand(client, start());
    const waiting = process.wait();
    const accepted = process.write("before");
    const closing = process.closeStdin();
    const queued = await rejection(process.write("during"));
    expect((queued as Error).message).toBe("toshi: standard input is closed");
    await accepted;
    await closing;
    const after = await rejection(process.write("after"));
    expect((after as Error).message).toBe("toshi: standard input is closed");
    await waiting;
    expect(stdin).toEqual(["before"]);
    expect(closed).toBe(true);
  });

  it("encodes a long string frame by frame without splitting a character", async () => {
    const frames: Uint8Array[] = [];
    const client = clientWith(async function* (requests) {
      const iterator = requests[Symbol.asyncIterator]();
      readStart(await iterator.next());
      yield startedResponse("exec-1");
      for (;;) {
        const next = await iterator.next();
        if (next.done === true || next.value.message.case === "closeStdin") {
          break;
        }
        if (next.value.message.case === "stdin") {
          frames.push(next.value.message.value);
        }
      }
      yield exitResponse({ exitCode: 0 });
    });
    const process = await executeCommand(client, start());
    const waiting = process.wait();
    // Four-byte characters after one ASCII byte, so a 64 KiB frame boundary
    // falls inside one.
    const text = "a" + "\u{1F600}".repeat(40_000);
    await process.write(text);
    await process.closeStdin();
    await waiting;
    expect(frames.length).toBeGreaterThan(1);
    for (const frame of frames) {
      expect(frame.length).toBeLessThanOrEqual(64 << 10);
      // Every frame decodes on its own: no character is split across two.
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(frame)).not.toThrow();
    }
    expect(new TextDecoder().decode(concatFrames(frames))).toBe(text);
  });

  it("splits a large write into 64 KiB frames in order", async () => {
    const frames: Uint8Array[] = [];
    const client = clientWith(async function* (requests) {
      const iterator = requests[Symbol.asyncIterator]();
      readStart(await iterator.next());
      yield startedResponse("exec-1");
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          break;
        }
        const message = next.value.message;
        if (message.case === "stdin") {
          frames.push(message.value);
        }
        if (message.case === "closeStdin") {
          break;
        }
      }
      yield exitResponse({ exitCode: 0 });
    });
    const process = await executeCommand(client, start());
    const waiting = process.wait();
    const payload = new Uint8Array(150 * 1024);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = i % 251;
    }
    await process.write(payload);
    await process.closeStdin();
    await waiting;
    expect(frames.map((frame) => frame.length)).toEqual([65536, 65536, 22528]);
    const joined = new Uint8Array(payload.length);
    let offset = 0;
    for (const frame of frames) {
      joined.set(frame, offset);
      offset += frame.length;
    }
    expect(joined).toEqual(payload);
  });

  it("sends close_stdin once after the earlier writes", async () => {
    const seen: string[] = [];
    const client = clientWith(async function* (requests) {
      const iterator = requests[Symbol.asyncIterator]();
      readStart(await iterator.next());
      yield startedResponse("exec-1");
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) {
          break;
        }
        const message = next.value.message;
        if (message.case === "stdin") {
          seen.push(`stdin:${new TextDecoder().decode(message.value)}`);
        }
        if (message.case === "closeStdin") {
          seen.push("close");
          break;
        }
      }
      yield exitResponse({ exitCode: 0 });
    });
    const process = await executeCommand(client, start());
    const waiting = process.wait();
    await process.write("hello");
    await process.closeStdin();
    await process.closeStdin();
    await waiting;
    expect(seen).toEqual(["stdin:hello", "close"]);
  });
});

function concatFrames(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.reduce((n, frame) => n + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}
