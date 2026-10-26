import { readFileSync } from "node:fs";
import { versions } from "node:process";
import { rootCertificates } from "node:tls";

import type { Interceptor, Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

import { createToshiClient as createRootClient } from "../client.js";
import type { ToshiClient, ToshiOptions } from "../client.js";
import { VERSION } from "../version.js";

/** Options for the Node entry: the root options, a built transport, and env defaults. */
export interface NodeToshiOptions extends Omit<ToshiOptions, "transport"> {
  /** A transport of your own; without one, connect-node over HTTP/2 to `server` is built. */
  transport?: (interceptors: Interceptor[]) => Transport;
  /** The control plane's base URL; defaults to TOSHI_SERVER. */
  server?: string;
  /** A file holding the token; its contents are trimmed, and an empty file is an error. */
  tokenFile?: string;
  /** A PEM bundle trusted besides Node's built-in roots; defaults to TOSHI_CA_FILE. */
  caFile?: string;
  /** Put in front of the User-Agent, for example "myapp/1.2"; empty adds nothing. */
  userAgent?: string;
  /** Run before the client's scope, key, retry and auth interceptors, in this order. */
  interceptors?: Interceptor[];
  /** Bounds each unary call except the Wait calls, which their request's timeout bounds; streams ignore it. */
  defaultTimeoutMs?: number;
}

/**
 * Creates a Node client. Without a transport of its own it builds one with
 * connect-node over HTTP/2, takes the server from `server` or TOSHI_SERVER and
 * the token from `token`, `tokenFile`, TOSHI_TOKEN or TOSHI_TOKEN_FILE.
 *
 * The User-Agent is "toshi-ts/<version> (node/<node version>)", with
 * `userAgent` in front when it is set. Connect exports no version constant, so
 * its name is not part of the string.
 */
export function createToshiClient(options: NodeToshiOptions = {}): ToshiClient {
  const custom = options.transport;
  const token = resolveToken(options.token, options.tokenFile, custom !== undefined);
  const agent = userAgent(options.userAgent ?? "");
  const outer = (interceptors: Interceptor[]): Interceptor[] => [
    ...(options.interceptors ?? []),
    userAgentInterceptor(agent),
    ...interceptors,
  ];

  let transport = custom;
  if (transport === undefined) {
    const server = resolveServer(options.server);
    const caFile = resolveCAFile(options.caFile);
    const ca = caFile === undefined ? undefined : caBundle(caFile);
    transport = (interceptors) =>
      createConnectTransport({
        baseUrl: server,
        httpVersion: "2",
        interceptors: outer(interceptors),
        ...(ca === undefined ? {} : { nodeOptions: { ca } }),
      });
  } else {
    const transportOfCaller = transport;
    transport = (interceptors) => transportOfCaller(outer(interceptors));
  }

  return createRootClient({ ...options, transport, token });
}

/** The User-Agent every Node request carries, with product in front when set. */
export function userAgent(product: string): string {
  const base = `toshi-ts/${VERSION} (node/${versions.node})`;
  return product === "" ? base : `${product} ${base}`;
}

function userAgentInterceptor(agent: string): Interceptor {
  return (next) => async (req) => {
    const header = new Headers(req.header);
    header.set("User-Agent", agent);
    return next({ ...req, header });
  };
}

function resolveServer(given: string | undefined): string {
  const server = given !== undefined && given !== "" ? given : env("TOSHI_SERVER");
  if (server === undefined) {
    throw new Error("toshi: no server: use the server option or set TOSHI_SERVER");
  }
  return server;
}

// resolveToken picks the token by the documented precedence: the option, the
// option's file, TOSHI_TOKEN, then TOSHI_TOKEN_FILE (client.go:154-169). With a
// transport of the caller's it returns undefined instead of refusing.
function resolveToken(
  given: string | undefined,
  tokenFile: string | undefined,
  optional: boolean,
): string | undefined {
  const token = given?.trim() ?? "";
  if (token !== "") {
    return token;
  }
  if (tokenFile !== undefined && tokenFile !== "") {
    return readTokenFile(tokenFile);
  }
  const fromEnv = env("TOSHI_TOKEN")?.trim() ?? "";
  if (fromEnv !== "") {
    return fromEnv;
  }
  const envFile = env("TOSHI_TOKEN_FILE");
  if (envFile !== undefined) {
    return readTokenFile(envFile);
  }
  if (optional) {
    return undefined;
  }
  throw new Error(
    "toshi: no token: use the token or tokenFile option, or set TOSHI_TOKEN or TOSHI_TOKEN_FILE",
  );
}

function resolveCAFile(given: string | undefined): string | undefined {
  if (given !== undefined && given !== "") {
    return given;
  }
  return env("TOSHI_CA_FILE");
}

function readTokenFile(path: string): string {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`toshi: read token file ${path}: ${message(err)}`, { cause: err });
  }
  const token = contents.trim();
  if (token === "") {
    throw new Error(`toshi: token file ${path} is empty`);
  }
  return token;
}

// The bundle is trusted besides the built-in roots, as the Go client trusts the
// system pool besides the file (client.go:206-237).
function caBundle(path: string): string[] {
  try {
    return [...rootCertificates, readFileSync(path, "utf8")];
  } catch (err) {
    throw new Error(`toshi: read CA file ${path}: ${message(err)}`, { cause: err });
  }
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
