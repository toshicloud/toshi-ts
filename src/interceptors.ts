import { ScalarType } from "@bufbuild/protobuf";
import type { DescField, DescMessage, Message } from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
import {
  backoffDelay,
  isTransportLoss,
  newRequestKey,
  procedurePath,
  retryClassFor,
  sleep,
} from "./retry.js";
import type { RetrySetting } from "./retry.js";

// A request message seen as a mutable record: protobuf-es v2 messages are plain
// objects with one property per field, keyed by localName.
type MutableMessage = Record<string, unknown>;

/** Sends `Authorization: Bearer <token>` on every call and stream; never Toshi-Tenant (intercept.go:13-36). */
export function authInterceptor(token: string): Interceptor {
  if (token === "") {
    return (next) => next;
  }
  return (next) => async (req) => {
    req.header.set("Authorization", `Bearer ${token}`);
    return next(req);
  };
}

/** Fills an empty project and environment from the options; caller values win (intercept.go:38-129). */
export function scopeInterceptor(project: string, environment: string): Interceptor {
  if (project === "" && environment === "") {
    return (next) => next;
  }
  return (next) => async (req) => {
    const desc = req.method.input;
    if (req.stream) {
      return next({ ...req, message: fillStream(req.message, desc, project, environment) });
    }
    fillScope(req.message, desc, project, environment);
    return next(req);
  };
}

/** Puts a request key on keyed procedures and on Execute's start (retry.go:110-116, 202-231). */
export function keyInterceptor(): Interceptor {
  return (next) => async (req) => {
    const desc = req.method.input;
    if (req.stream) {
      // Only Execute is bidirectional; its start is the one stream message that
      // carries a request key (execute.go, intercept.go:81-94).
      if (req.method.methodKind !== "bidi_streaming") {
        return next(req);
      }
      return next({ ...req, message: fillStreamKey(req.message, desc) });
    }
    if (retryClassFor(procedurePath(req.service, req.method)) === "keyed") {
      fillRequestKey(req.message, desc);
    }
    return next(req);
  };
}

/** Retries a unary read or keyed write after a transport loss, with full jitter (retry.go:98-186). */
export function retryInterceptor(retry: RetrySetting): Interceptor {
  if (retry === false) {
    return (next) => next;
  }
  const policy = retry;
  return (next) => async (req) => {
    // Streams are never retried here; the watches reconnect on their own (retry.go:135-141).
    if (req.stream || retryClassFor(procedurePath(req.service, req.method)) === "none") {
      return next(req);
    }
    // The same request object, with its key, is sent again (retry.go:118-130).
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await next(req);
      } catch (err) {
        if (attempt + 1 >= policy.maxAttempts || !isTransportLoss(err)) {
          throw err;
        }
        await sleep(backoffDelay(policy, attempt), req.signal);
      }
    }
  };
}

function fillStream(
  messages: AsyncIterable<Message>,
  desc: DescMessage,
  project: string,
  environment: string,
): AsyncIterable<Message> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const message of messages) {
        fillScope(message, desc, project, environment);
        yield message;
      }
    },
  };
}

function fillStreamKey(messages: AsyncIterable<Message>, desc: DescMessage): AsyncIterable<Message> {
  return {
    async *[Symbol.asyncIterator]() {
      for await (const message of messages) {
        fillRequestKey(message, desc);
        yield message;
      }
    },
  };
}

// Fills an empty project and, unless the message selects a shared set, an empty
// environment (intercept.go:102-123).
function fillScope(msg: MutableMessage, desc: DescMessage, project: string, environment: string): void {
  if (project !== "") {
    const field = stringField(desc, "project");
    if (field !== undefined) {
      fillIfEmpty(msg, field, project);
    }
  }
  if (environment !== "" && !isShared(msg, desc)) {
    const field = stringField(desc, "environment");
    if (field !== undefined) {
      fillIfEmpty(msg, field, environment);
    }
  }
  for (const child of activeOneofMessages(msg, desc)) {
    fillScope(child.message, child.desc, project, environment);
  }
}

// Sets request_key on msg, or on the start message a bidi Execute request
// carries (retry.go:202-216).
function fillRequestKey(msg: MutableMessage, desc: DescMessage): void {
  const field = stringField(desc, "request_key");
  if (field !== undefined) {
    const current = msg[field.localName];
    if (current === "" || current === undefined) {
      msg[field.localName] = newRequestKey();
    }
    return;
  }
  for (const child of activeOneofMessages(msg, desc)) {
    fillRequestKey(child.message, child.desc);
  }
}

interface ChildMessage {
  readonly message: MutableMessage;
  readonly desc: DescMessage;
}

// The active message-typed oneof values of msg; ExecuteRequest's start is one.
function* activeOneofMessages(msg: MutableMessage, desc: DescMessage): Generator<ChildMessage> {
  for (const field of desc.fields) {
    if (field.fieldKind !== "message" || field.oneof === undefined) {
      continue;
    }
    const group = msg[field.oneof.localName];
    if (typeof group !== "object" || group === null) {
      continue;
    }
    const oneof = group as { case?: unknown; value?: unknown };
    if (oneof.case !== field.localName || typeof oneof.value !== "object" || oneof.value === null) {
      continue;
    }
    yield { message: oneof.value as MutableMessage, desc: field.message };
  }
}

// A singular string field by its proto name, e.g. "request_key".
function stringField(desc: DescMessage, name: string): DescField | undefined {
  return desc.fields.find(
    (field) => field.name === name && field.fieldKind === "scalar" && field.scalar === ScalarType.STRING,
  );
}

// An unset proto3 string reads as "", so both it and an explicit "" are empty.
function fillIfEmpty(msg: MutableMessage, field: DescField, value: string): void {
  const current = msg[field.localName];
  if (current === "" || current === undefined) {
    msg[field.localName] = value;
  }
}

// Whether msg selects a shared secret set (intercept.go:125-129).
function isShared(msg: MutableMessage, desc: DescMessage): boolean {
  const field = desc.fields.find((candidate) => candidate.name === "shared");
  return (
    field !== undefined &&
    field.fieldKind === "scalar" &&
    field.scalar === ScalarType.BOOL &&
    msg[field.localName] === true
  );
}
