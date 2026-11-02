import { ConnectError } from "@connectrpc/connect";
import type { Interceptor } from "@connectrpc/connect";

import { procedurePath } from "./retry.js";

/** Receives the warning a deprecated call gets, once per call per process. */
export type DeprecationWarn = (message: string) => void;

// The calls already warned about in this process, by procedure path.
const warned = new Set<string>();

/**
 * Warns once per process about a call the server marks deprecated: an answer
 * with a `Deprecation` header (RFC 9745, `@<unix seconds>`) or a `Sunset`
 * header (RFC 8594, an HTTP-date), on success or error. The warning names the
 * call, the dates the headers give and the `Link` with `rel="deprecation"`.
 * An answer without either header changes nothing.
 */
export function deprecationInterceptor(warn: DeprecationWarn = defaultWarn): Interceptor {
  return (next) => async (req) => {
    const procedure = procedurePath(req.service, req.method);
    try {
      const res = await next(req);
      notice(procedure, res.header, warn);
      return res;
    } catch (err) {
      if (err instanceof ConnectError) {
        notice(procedure, err.metadata, warn);
      }
      throw err;
    }
  };
}

function defaultWarn(message: string): void {
  console.warn(message);
}

function notice(procedure: string, header: Headers, warn: DeprecationWarn): void {
  const deprecation = header.get("Deprecation");
  const sunset = header.get("Sunset");
  if (deprecation === null && sunset === null) {
    return;
  }
  if (warned.has(procedure)) {
    return;
  }
  warned.add(procedure);
  warn(deprecationMessage(procedure, deprecation, sunset, header.get("Link")));
}

/** The warning for procedure, from the values of its Deprecation, Sunset and Link headers. */
export function deprecationMessage(
  procedure: string,
  deprecation: string | null,
  sunset: string | null,
  link: string | null,
): string {
  let message = `toshi: ${procedure} is deprecated`;
  const since = deprecation === null ? undefined : deprecationDate(deprecation);
  if (since !== undefined) {
    message += ` since ${day(since)}`;
  }
  const until = sunset === null ? undefined : sunsetDate(sunset);
  if (until !== undefined) {
    message += ` and is removed after ${day(until)}`;
  }
  const docs = link === null ? undefined : deprecationLink(link);
  if (docs !== undefined) {
    message += `; see ${docs}`;
  }
  return message;
}

// RFC 9745's value is a structured-field date: "@" and unix seconds.
function deprecationDate(value: string): Date | undefined {
  const match = /^@(-?\d{1,15})$/.exec(value.trim());
  return match === null ? undefined : new Date(Number(match[1]) * 1000);
}

// RFC 8594's value is an HTTP-date.
function sunsetDate(value: string): Date | undefined {
  const millis = Date.parse(value.trim());
  return Number.isNaN(millis) ? undefined : new Date(millis);
}

// The target of the first link whose rel includes "deprecation".
function deprecationLink(value: string): string | undefined {
  for (const match of value.matchAll(/<([^>]*)>([^,<]*)/g)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(match[2] ?? "");
    const names = (rel?.[1] ?? rel?.[2] ?? "").toLowerCase().split(/\s+/);
    if (names.includes("deprecation")) {
      return match[1];
    }
  }
  return undefined;
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

