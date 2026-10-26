import type { BigIntStats } from "node:fs";
import { readFileSync, statSync } from "node:fs";
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
  /**
   * A file holding the token, trimmed; an empty file is an error. It is read
   * again before a request when its modification time or size changed.
   */
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
 * the token from `tokenSource`, `token`, `tokenFile`, TOSHI_TOKEN or
 * TOSHI_TOKEN_FILE.
 *
 * The User-Agent is "toshi-ts/<version> (node/<node version>)", with
 * `userAgent` in front when it is set. Connect exports no version constant, so
 * its name is not part of the string.
 */
export function createToshiClient(options: NodeToshiOptions = {}): ToshiClient {
  const custom = options.transport;
  const resolved = resolveToken(options, custom !== undefined);
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

  return createRootClient({
    ...options,
    transport,
    token: resolved.token,
    tokenSource: resolved.tokenSource,
  });
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

// The token to use: a source for the root client, or the fixed token it sends.
interface ResolvedToken {
  readonly token?: string;
  readonly tokenSource?: (signal: AbortSignal | undefined) => string | Promise<string>;
}

// resolveToken picks the token by the documented precedence: the source, the
// option, the option's file, TOSHI_TOKEN, then TOSHI_TOKEN_FILE
// (client.go:154-169). A token file is read here, so a missing or empty one
// fails createToshiClient; the source reads it again when it changes. With a
// transport of the caller's and no token anywhere, it returns nothing instead
// of refusing.
function resolveToken(options: NodeToshiOptions, optional: boolean): ResolvedToken {
  if (options.tokenSource !== undefined) {
    return { tokenSource: options.tokenSource };
  }
  const token = options.token?.trim() ?? "";
  if (token !== "") {
    return { token };
  }
  if (options.tokenFile !== undefined && options.tokenFile !== "") {
    return { tokenSource: fileTokenSource(options.tokenFile) };
  }
  const fromEnv = env("TOSHI_TOKEN")?.trim() ?? "";
  if (fromEnv !== "") {
    return { token: fromEnv };
  }
  const envFile = env("TOSHI_TOKEN_FILE");
  if (envFile !== undefined) {
    return { tokenSource: fileTokenSource(envFile) };
  }
  if (optional) {
    return {};
  }
  throw new Error(
    "toshi: no token: use the tokenSource, token or tokenFile option, or set TOSHI_TOKEN or TOSHI_TOKEN_FILE",
  );
}

// fileTokenSource returns a source over a token file whose first read happens
// now, so a missing or empty file still fails createToshiClient.
function fileTokenSource(path: string): (signal: AbortSignal | undefined) => string {
  const file = new TokenFile(path);
  return () => file.read();
}

// TokenFile is a token file read again when its modification time or size
// changed since the last read (client.go:203-249).
class TokenFile {
  readonly #path: string;
  #token = "";
  #modTimeNs = 0n;
  #size = -1n;

  constructor(path: string) {
    this.#path = path;
    this.read();
  }

  // read returns the file's token, reading the file again when it changed. It
  // stats before reading, so a change made in between is read next time. After
  // a failure the next call reads the file again.
  read(): string {
    let stats: BigIntStats;
    try {
      stats = statSync(this.#path, { bigint: true });
    } catch (err) {
      this.#size = -1n;
      throw new Error(`toshi: read token file ${this.#path}: ${message(err)}`, { cause: err });
    }
    if (stats.mtimeNs === this.#modTimeNs && stats.size === this.#size) {
      return this.#token;
    }
    try {
      this.#token = readTokenFile(this.#path);
    } catch (err) {
      this.#size = -1n;
      throw err;
    }
    this.#modTimeNs = stats.mtimeNs;
    this.#size = stats.size;
    return this.#token;
  }
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
