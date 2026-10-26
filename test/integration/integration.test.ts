/**
 * The TypeScript layer against a real `toshi serve` from the binary that
 * TOSHI_INTEGRATION_BIN names. Without it the suite skips with a notice; when
 * TOSHI_INTEGRATION_EXPECT_COMMIT is set, the binary must report that commit.
 *
 * The flow copies integration/integration_test.go of toshi-go: a throwaway
 * CA, two free loopback ports, `dev github serve` as the fake GitHub API, an
 * installation webhook that makes the workspace, and an operator token.
 */
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { connect as netConnect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Code, ConnectError } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createToshiClient } from "../../src/client.js";
import type { OutputWatch, ToshiClient } from "../../src/client.js";
import { StreamLostError } from "../../src/errors.js";
import { EventType, JobState } from "../../src/gen/toshi/workspace/v1/workspace_pb.js";
import type { Job } from "../../src/gen/toshi/workspace/v1/workspace_pb.js";
import type { WatchJobsResponse } from "../../src/gen/toshi/workspace/v1/workloads_pb.js";

const INSTALLATION_ID = "4242";
const ACCOUNT = "acme";
const PROJECT = "default";
const ENVIRONMENT = "production";
const SUITE_LABEL = "sdk-integration";
const CA_COMMON_NAME = "sdk integration CA";

const STARTUP_TIMEOUT_MS = 240_000;
const CASE_TIMEOUT_MS = 90_000;
const WATCH_TIMEOUT_MS = 20_000;
const OUTPUT_WAIT_MS = 3_000;
const LOG_TAIL_BYTES = 8_000;

const skipped = process.env.TOSHI_INTEGRATION_BIN === undefined;
if (skipped) {
  process.stdout.write(
    "skipped: TOSHI_INTEGRATION_BIN is not set: it names the toshi binary this suite runs against\n",
  );
}

/** What the started control plane gives the cases. */
interface Harness {
  readonly client: ToshiClient;
}

/** The two workloads the write cases share, in creation order. */
const state = {
  firstId: "",
  secondId: "",
};

let running: Harness | undefined;
let failed = false;
let workDir: string | undefined;
let startupLogsPrinted = false;
const logFiles: string[] = [];
const children: { readonly child: ChildProcess; readonly logPath: string }[] = [];

describe.skipIf(skipped)("toshi serve integration", () => {
  beforeAll(async () => {
    const bin = binaryPath();
    const dir = await mkdtemp(join(tmpdir(), "toshi-ts-integration-"));
    workDir = dir;
    const fakeLog = join(dir, "fake.log");
    const serveLog = join(dir, "serve.log");
    logFiles.push(fakeLog, serveLog);

    try {
      // Before anything: the served commit.
      const printed = await runTool(bin, ["version"]);
      const commit = commitLine(printed);
      if (commit === "") {
        throw new Error("toshi version printed no commit line");
      }
      const want = process.env.TOSHI_INTEGRATION_EXPECT_COMMIT ?? "";
      if (want !== "" && want !== commit) {
        throw new Error(`served Toshi commit ${commit}, want ${want}`);
      }
      pass("version", `serving Toshi commit ${commit}`);

      const tls = await mintTls(dir);
      const appKeyPath = join(dir, "app.pem");
      const appKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
      await writeFile(appKeyPath, pem("RSA PRIVATE KEY", pkcs1Der(appKeys.privateKey)), {
        mode: 0o600,
      });
      const webhookPath = await writeSecretFile(dir, "webhook.secret");
      const operatorPath = await writeSecretFile(dir, "operator.token");
      const localKeyPath = await writeSecretFile(dir, "secrets.key");

      const servePort = await freePort();
      const fakePort = await freePort();
      const configPath = await writeConfig({
        dir,
        servePort,
        fakePort,
        certPath: tls.certPath,
        keyPath: tls.keyPath,
        appKeyPath,
        webhookPath,
        operatorPath,
        localKeyPath,
      });

      startChild(
        bin,
        [
          "dev",
          "github",
          "serve",
          "--i-know-this-is-fake",
          "--listen",
          `127.0.0.1:${String(fakePort)}`,
          "--installation",
          `${INSTALLATION_ID}:${ACCOUNT}`,
        ],
        fakeLog,
      );
      await waitPort(fakePort, 20_000);

      startChild(bin, ["serve", "--config", configPath], serveLog);

      const baseUrl = `https://127.0.0.1:${String(servePort)}`;
      await waitReady(servePort, tls.caPem, 60_000);

      const operatorEnv = {
        TOSHI_SERVER: baseUrl,
        TOSHI_CA_FILE: tls.caPath,
        TOSHI_TOKEN_FILE: operatorPath,
      };

      // A workspace through the documented dev GitHub flow.
      await runTool(
        bin,
        [
          "dev",
          "github",
          "send",
          "--i-know-this-is-fake",
          "--url",
          `${baseUrl}/webhooks/github`,
          "--ca-file",
          tls.caPath,
          "--secret-file",
          webhookPath,
          "--installation",
          INSTALLATION_ID,
          "--repository",
          `${ACCOUNT}/app`,
          "--event",
          "installation",
          "--action",
          "created",
        ],
        {},
      );
      await waitTenant(bin, operatorEnv, INSTALLATION_ID, 30_000);

      // A project-wide token, so the shared secret set is reachable too.
      const token = (
        await runTool(
          bin,
          [
            "token",
            "create",
            "--workspace",
            INSTALLATION_ID,
            "--name",
            "sdk-integration",
            "--project",
            PROJECT,
          ],
          operatorEnv,
        )
      ).trim();
      if (token === "") {
        throw new Error("token create printed no token");
      }

      running = { client: newClient(servePort, tls.caPem, token) };
    } catch (err) {
      // A failed startup leaves no harness; its logs still say why.
      failed = true;
      await printLogs(logFiles);
      startupLogsPrinted = true;
      await stopChildren();
      throw err;
    }
  }, STARTUP_TIMEOUT_MS);

  beforeEach((context) => {
    context.onTestFailed(() => {
      failed = true;
    });
  });

  afterAll(async () => {
    // A failed startup leaves no harness, so its logs are printed too.
    if ((failed || running === undefined) && !startupLogsPrinted) {
      await printLogs(logFiles);
    }
    await stopChildren();
    if (workDir !== undefined) {
      await rm(workDir, { recursive: true, force: true });
    }
  }, CASE_TIMEOUT_MS);

  it(
    "lists the workspace's projects and environments",
    async () => {
      const response = await harness().client.project.listProjects({});
      const project = response.projects.find((candidate) => candidate.name === PROJECT);
      if (project === undefined) {
        throw new Error(`projects do not hold ${PROJECT}`);
      }
      expect(project.environments.map((environment) => environment.name)).toContain(ENVIRONMENT);
      pass("listProjects", `${PROJECT}/${ENVIRONMENT} is there`);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "creates a workload with an explicit request key, idempotently",
    async () => {
      const client = harness().client;
      const first = await createJob(client, "sdk-fixed-key");
      expect(first.labels.suite).toBe(SUITE_LABEL);
      expect(first.id).not.toBe("");

      const again = await createJob(client, "sdk-fixed-key");
      expect(again.id).toBe(first.id);

      // No key: the client's interceptor fills one, so this is a second write.
      const second = await createJob(client, "");
      expect(second.id).not.toBe(first.id);
      expect(second.labels.suite).toBe(SUITE_LABEL);

      state.firstId = first.id;
      state.secondId = second.id;
      pass(
        "createJob",
        `the same request key returned ${first.id} twice, an unfilled one made ${second.id}`,
      );
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "gets the created workload",
    async () => {
      const response = await harness().client.workload.jobs.get({ id: state.firstId });
      const job = response.job;
      if (job === undefined) {
        throw new Error("GetJob returned no job");
      }
      expect(job.id).toBe(state.firstId);
      expect(job.labels.suite).toBe(SUITE_LABEL);
      pass("getJob", `${job.id} carries suite=${SUITE_LABEL}`);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "pages through ListJobs",
    async () => {
      const client = harness().client;
      const seen: string[] = [];
      let pageToken = "";
      let pages = 0;
      do {
        const page = await client.workload.jobs.list({
          labels: { suite: SUITE_LABEL },
          pageSize: 1,
          pageToken,
        });
        for (const job of page.jobs) {
          seen.push(job.id);
        }
        pageToken = page.nextPageToken;
        pages += 1;
        if (pages > 20) {
          throw new Error("ListJobs kept handing out page tokens");
        }
      } while (pageToken !== "");
      expect(pages).toBeGreaterThan(1);
      expect(seen).toEqual(expect.arrayContaining([state.firstId, state.secondId]));
      pass("listJobs", `${String(pages)} pages of one held ${JSON.stringify(seen)}`);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "waits for the job state the pin reaches",
    async () => {
      const client = harness().client;
      // The pin has no host with a free slot, so the job stays QUEUED.
      const got = await client.workload.jobs.get({ id: state.firstId });
      expect(got.job?.status?.state).toBe(JobState.QUEUED);

      // The helper returns as soon as the state is one it waits for.
      const reached = await client.workload.jobs.wait({
        id: state.firstId,
        states: [JobState.QUEUED],
        timeout: { seconds: 1n },
      });
      expect(reached.reached).toBe(true);
      expect(reached.job?.status?.state).toBe(JobState.QUEUED);

      // ENDED needs a runner, and this control plane has none: the server
      // answers reached=false after the bound, and the helper asks again.
      const started = Date.now();
      const controller = new AbortController();
      const pending = client.workload.jobs.wait(
        { id: state.firstId, states: [JobState.ENDED], timeout: { seconds: 1n } },
        { signal: controller.signal },
      );
      await delay(1_500);
      let settled = false;
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // A runner-less pin never reaches ENDED, so the wait is still asking.
      expect(settled).toBe(false);
      controller.abort(new Error("stop waiting"));
      await expect(pending).rejects.toBeDefined();
      const elapsed = Date.now() - started;
      pass(
        "waitJob",
        `reaches QUEUED at once; ENDED is not reached at this pin (no runner), so the wait still asked after ${String(elapsed)} ms`,
      );
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "watches jobs and advances its cursor",
    async () => {
      const client = harness().client;
      const watch = await client.workload.jobs.watch({});
      const snapshot = watch.snapshot ?? [];
      expect(idsOf(snapshot)).toEqual(expect.arrayContaining([state.firstId, state.secondId]));
      const before = watch.cursor;
      expect(before).not.toBe("");

      try {
        await client.workload.jobs.update({
          id: state.secondId,
          job: { labels: { suite: SUITE_LABEL, stage: "watch" } },
          updateMask: { paths: ["labels"] },
        });

        const seen = await untilSeen(
          watch,
          () => {
            watch.close();
          },
          (message: WatchJobsResponse) =>
            message.job?.id === state.secondId && message.job.labels.stage === "watch",
        );
        expect(seen).toBe(true);
        expect(watch.cursor).not.toBe("");
        expect(watch.cursor).not.toBe(before);
        pass(
          "watchJobs",
          `${String(snapshot.length)} in the snapshot, then stage=watch on ${state.secondId} moved the cursor`,
        );
      } finally {
        watch.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "resumes watchEvents from the cursor ListJobs exposes",
    async () => {
      const client = harness().client;
      const listed = await client.workload.jobs.list({});
      expect(listed.jobs.length).toBeGreaterThan(0);
      const start = listed.cursor;
      expect(start).not.toBe("");

      const watch = await client.workload.watchEvents({ cursor: start });
      try {
        await client.workload.jobs.update({
          id: state.firstId,
          job: { labels: { suite: SUITE_LABEL, stage: "events" } },
          updateMask: { paths: ["labels"] },
        });
        const seen = await untilSeen(
          watch,
          () => {
            watch.close();
          },
          (message) => {
            const event = message.event;
            if (event?.workloadId === state.firstId && event.type === EventType.WORKLOAD_CREATED) {
              throw new Error("the watch started again from the oldest event");
            }
            return event?.workloadId === state.firstId && event.type === EventType.WORKLOAD_UPDATED;
          },
        );
        expect(seen).toBe(true);
        expect(watch.cursor).not.toBe(start);
        pass(
          "watchEvents",
          `resumed from the list cursor ${start} and saw only the label change on ${state.firstId}`,
        );
      } finally {
        watch.close();
      }
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "watches the output of a job",
    async () => {
      const watch = await harness().client.workload.jobs.watchOutput({ id: state.firstId });
      const { output, failure, ended, timedOut } = await drainOutput(
        watch,
        () => {
          watch.close();
        },
        OUTPUT_WAIT_MS,
      );
      if (failure !== undefined) {
        throw asError(failure);
      }
      // The pin queues the job ("no host with a free slot") and keeps the
      // stream open: no bytes and no end message, because nothing runs it.
      expect(output.length).toBe(0);
      expect(ended).toBe(false);
      expect(timedOut).toBe(true);
      pass(
        "watchOutput",
        `the pin streams only a running job's output: ${state.firstId} stays queued, so the watch stayed open with no bytes and no end for ${String(OUTPUT_WAIT_MS)} ms`,
      );
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "executes a command in a sandbox",
    async () => {
      const client = harness().client;
      let failure: unknown;
      let output = "";
      try {
        const sandbox = await client.workload.sandboxes.create({
          spec: { size: "toshi-linux-2x" },
          labels: { suite: SUITE_LABEL },
        });
        const sandboxId = sandbox.sandbox?.id ?? "";
        if (sandboxId === "") {
          throw new Error("CreateSandbox returned no sandbox");
        }
        const execution = await client.workload.sandboxes.execute({
          sandboxId,
          command: { argv: ["true"] },
        });
        const chunks: Uint8Array[] = [];
        for await (const chunk of execution) {
          chunks.push(chunk.data);
        }
        await execution.wait();
        output = new TextDecoder().decode(concat(chunks));
      } catch (err) {
        failure = err;
      }

      if (failure === undefined) {
        throw new Error(`the pin ran the command (output ${JSON.stringify(output)}); it has no runner and must refuse`);
      }
      if (!(failure instanceof ConnectError)) {
        throw asError(failure);
      }
      // The pin refuses to execute in a sandbox that is not running, and this
      // control plane runs none; toshi-go asserts the same code.
      expect(failure.code).toBe(Code.FailedPrecondition);
      expect(failure).not.toBeInstanceOf(StreamLostError);
      pass(
        "execute",
        `the pin answers FAILED_PRECONDITION (${failure.message}) and not a lost stream`,
      );
    },
    CASE_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Helpers, all below the cases.
// ---------------------------------------------------------------------------

function harness(): Harness {
  if (running === undefined) {
    throw new Error("the integration harness did not start");
  }
  return running;
}

function binaryPath(): string {
  const bin = process.env.TOSHI_INTEGRATION_BIN;
  if (bin === undefined) {
    throw new Error("TOSHI_INTEGRATION_BIN is not set");
  }
  return resolve(bin);
}

/** The `commit: ` line of `toshi version`, or "". */
function commitLine(printed: string): string {
  for (const line of printed.split("\n")) {
    if (line.startsWith("commit: ")) {
      return line.slice("commit: ".length).trim();
    }
  }
  return "";
}

/** A case's PASS line, written past vitest's console capture so the log keeps it. */
function pass(caseName: string, detail: string): void {
  process.stdout.write(`PASS ${caseName}: ${detail}\n`);
}

/** Any caught value as something a test may throw. */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function idsOf(jobs: readonly Job[]): string[] {
  return jobs.map((job) => job.id);
}

function newClient(port: number, ca: string, token: string): ToshiClient {
  return createToshiClient({
    transport: (interceptors) =>
      createConnectTransport({
        baseUrl: `https://127.0.0.1:${String(port)}`,
        httpVersion: "2",
        interceptors,
        nodeOptions: { ca },
      }),
    token,
    project: PROJECT,
    environment: ENVIRONMENT,
  });
}

async function createJob(client: ToshiClient, requestKey: string): Promise<Job> {
  const response = await client.workload.jobs.create({
    labels: { suite: SUITE_LABEL },
    spec: { command: { argv: ["true"] } },
    requestKey,
  });
  const job = response.job;
  if (job === undefined) {
    throw new Error("CreateJob returned no job");
  }
  return job;
}

/**
 * Iterates until visit returns true or the stream is closed after ms; the
 * close callback ends the watch so a pin that never answers cannot hang the
 * case past CASE_TIMEOUT_MS.
 */
async function untilSeen<T>(
  watch: AsyncIterable<T>,
  close: () => void,
  visit: (item: T) => boolean,
): Promise<boolean> {
  const timer = setTimeout(close, WATCH_TIMEOUT_MS);
  try {
    for await (const item of watch) {
      if (visit(item)) {
        return true;
      }
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Drains an output watch: the bytes, what ended it, and whether it timed out. */
async function drainOutput(
  watch: OutputWatch,
  close: () => void,
  waitMs: number,
): Promise<{
  readonly output: Uint8Array;
  readonly failure: unknown;
  readonly ended: boolean;
  readonly timedOut: boolean;
}> {
  let timedOut = false;
  let ended = false;
  const timer = setTimeout(() => {
    timedOut = true;
    close();
  }, waitMs);
  const chunks: Uint8Array[] = [];
  let failure: unknown;
  try {
    for await (const response of watch) {
      if (response.message.case === "stdout" || response.message.case === "stderr") {
        chunks.push(response.message.value);
      }
      if (response.message.case === "end") {
        ended = true;
        break;
      }
    }
  } catch (err) {
    failure = err;
  } finally {
    clearTimeout(timer);
    close();
  }
  return { output: concat(chunks), failure, ended, timedOut };
}

/** Runs the binary once and returns its standard output; failures name the call. */
function runTool(bin: string, args: readonly string[], extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      bin,
      [...args],
      { env: childEnv(extraEnv), timeout: 30_000, maxBuffer: 8 << 20 },
      (error, stdout) => {
        if (error !== null) {
          reject(new Error(`toshi ${args.slice(0, 2).join(" ")} failed: ${error.message}`));
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.startsWith("TOSHI_")) {
      continue;
    }
    env[name] = value;
  }
  return { ...env, ...extra };
}

/** Starts a child in the background, its output going to one log file. */
function startChild(bin: string, args: readonly string[], logPath: string): void {
  const fd = openSync(logPath, "w");
  const child = spawn(bin, [...args], { stdio: ["ignore", fd, fd], env: childEnv({}) });
  closeSync(fd);
  if (child.pid === undefined) {
    throw new Error(`toshi ${args[0] ?? ""} did not start`);
  }
  children.push({ child, logPath });
}

async function stopChildren(): Promise<void> {
  for (const entry of children) {
    await stopChild(entry.child);
  }
}

function stopChild(child: ChildProcess): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveStop();
      return;
    }
    child.once("exit", () => {
      resolveStop();
    });
    child.kill("SIGKILL");
  });
}

async function printLogs(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      const body = await readFile(path, "utf8");
      const tail = body.length <= LOG_TAIL_BYTES ? body : body.slice(body.length - LOG_TAIL_BYTES);
      process.stdout.write(`${path} (tail):\n${tail}\n`);
    } catch {
      // The log may not exist when startup failed before the spawn.
    }
  }
}

async function waitTenant(
  bin: string,
  env: Record<string, string>,
  tenant: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const listed = await tenantsJson(bin, env);
    last = listed;
    if (tenantIds(listed).includes(tenant)) {
      return;
    }
    await delay(100);
  }
  throw new Error(`tenant ${tenant} did not appear: ${last}`);
}

async function tenantsJson(bin: string, env: Record<string, string>): Promise<string> {
  try {
    return await runTool(bin, ["workspace", "list", "--json"], env);
  } catch {
    return "";
  }
}

function tenantIds(listed: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || !("tenants" in parsed)) {
    return [];
  }
  const tenants = (parsed as { tenants?: unknown }).tenants;
  if (!Array.isArray(tenants)) {
    return [];
  }
  const ids: string[] = [];
  for (const entry of tenants as unknown[]) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string") {
      ids.push(id);
    }
  }
  return ids;
}

/** A loopback port nothing is listening on, picked at runtime. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("no loopback port was assigned"));
        return;
      }
      const port = address.port;
      server.close(() => {
        resolvePort(port);
      });
    });
  });
}

function connectOnce(port: number): Promise<void> {
  return new Promise((resolveConnect, reject) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveConnect();
    });
    socket.once("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

async function waitPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await connectOnce(port);
      return;
    } catch {
      await delay(50);
    }
  }
  throw new Error(`127.0.0.1:${String(port)} did not start`);
}

function readyz(port: number, ca: string): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const req = httpsRequest(
      { host: "127.0.0.1", port, path: "/readyz", method: "GET", ca, timeout: 2_000 },
      (res) => {
        res.resume();
        resolveStatus(res.statusCode ?? 0);
      },
    );
    req.once("timeout", () => {
      req.destroy(new Error("readyz timed out"));
    });
    req.once("error", reject);
    req.end();
  });
}

async function waitReady(port: number, ca: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const status = await readyz(port, ca);
      if (status === 200) {
        return;
      }
      last = `status ${String(status)}`;
    } catch (err) {
      last = err instanceof Error ? err.message : "error";
    }
    await delay(100);
  }
  throw new Error(`https://127.0.0.1:${String(port)}/readyz did not become ready: ${last}`);
}

// --- the throwaway PKI -----------------------------------------------------

interface TlsFiles {
  readonly caPath: string;
  readonly caPem: string;
  readonly certPath: string;
  readonly keyPath: string;
}

/** Mints a CA and a leaf for localhost and 127.0.0.1 in dir. */
async function mintTls(dir: string): Promise<TlsFiles> {
  const caKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const caDer = certificate({
    serial: 1,
    commonName: CA_COMMON_NAME,
    issuer: CA_COMMON_NAME,
    subjectKey: caKeys.publicKey,
    issuerKey: caKeys.privateKey,
    isCa: true,
    serverAuth: false,
    keyUsage: { bits: Uint8Array.of(0x86), unused: 1 },
    dnsNames: [],
    ipAddresses: [],
  });
  const leafKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const leafDer = certificate({
    serial: 2,
    commonName: "localhost",
    issuer: CA_COMMON_NAME,
    subjectKey: leafKeys.publicKey,
    issuerKey: caKeys.privateKey,
    isCa: false,
    serverAuth: true,
    keyUsage: { bits: Uint8Array.of(0x80), unused: 7 },
    dnsNames: ["localhost"],
    ipAddresses: ["127.0.0.1"],
  });

  const caPath = join(dir, "ca.pem");
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  const caPem = pem("CERTIFICATE", caDer);
  await writeFile(caPath, caPem, { mode: 0o644 });
  await writeFile(certPath, pem("CERTIFICATE", leafDer), { mode: 0o644 });
  await writeFile(keyPath, pem("PRIVATE KEY", pkcs8Der(leafKeys.privateKey)), { mode: 0o600 });
  return { caPath, caPem, certPath, keyPath };
}

interface CertificateInput {
  readonly serial: number;
  readonly commonName: string;
  readonly issuer: string;
  readonly subjectKey: KeyObject;
  readonly issuerKey: KeyObject;
  readonly isCa: boolean;
  readonly serverAuth: boolean;
  readonly keyUsage: { readonly bits: Uint8Array; readonly unused: number };
  readonly dnsNames: readonly string[];
  readonly ipAddresses: readonly string[];
}

/** A DER X.509 v3 certificate, signed by issuerKey (node:crypto, ECDSA P-256). */
function certificate(input: CertificateInput): Uint8Array {
  const now = Date.now();
  const algorithm = seq(oid(OID_ECDSA_SHA256));
  const extensions: Uint8Array[] = [
    extension(
      OID_BASIC_CONSTRAINTS,
      true,
      input.isCa ? seq(Uint8Array.of(0x01, 0x01, 0xff)) : seq(),
    ),
    extension(OID_KEY_USAGE, true, bitString(input.keyUsage.bits, input.keyUsage.unused)),
  ];
  if (input.serverAuth) {
    extensions.push(extension(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH))));
  }
  if (input.dnsNames.length > 0 || input.ipAddresses.length > 0) {
    const names: Uint8Array[] = [];
    for (const name of input.dnsNames) {
      names.push(tlv(0x82, new TextEncoder().encode(name)));
    }
    for (const address of input.ipAddresses) {
      names.push(tlv(0x87, ipv4Bytes(address)));
    }
    extensions.push(extension(OID_SUBJECT_ALT_NAME, false, seq(...names)));
  }

  const tbs = seq(
    tlv(0xa0, integer(2)),
    integer(input.serial),
    algorithm,
    name(input.issuer),
    seq(utcTime(now - 3_600_000), utcTime(now + 86_400_000)),
    name(input.commonName),
    spkiDer(input.subjectKey),
    tlv(0xa3, seq(...extensions)),
  );
  const signature = sign("sha256", tbs, input.issuerKey);
  return seq(tbs, algorithm, bitString(new Uint8Array(signature), 0));
}

const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SUBJECT_ALT_NAME = "2.5.29.17";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const OID_COMMON_NAME = "2.5.4.3";

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [oid(id)];
  if (critical) {
    parts.push(Uint8Array.of(0x01, 0x01, 0xff));
  }
  parts.push(octetString(value));
  return seq(...parts);
}

function name(commonName: string): Uint8Array {
  return seq(setOf(seq(oid(OID_COMMON_NAME), tlv(0x0c, new TextEncoder().encode(commonName)))));
}

function ipv4Bytes(address: string): Uint8Array {
  const parts = address.split(".");
  if (parts.length !== 4) {
    throw new Error(`not an IPv4 address: ${address}`);
  }
  return Uint8Array.from(parts.map((part) => Number.parseInt(part, 10)));
}

// Minimal DER encoding: every helper returns tag, length and content.
function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(tag), derLength(content.length), content]);
}

function seq(...parts: readonly Uint8Array[]): Uint8Array {
  return tlv(0x30, concat(parts));
}

function setOf(...parts: readonly Uint8Array[]): Uint8Array {
  return tlv(0x31, concat(parts));
}

function octetString(content: Uint8Array): Uint8Array {
  return tlv(0x04, content);
}

function bitString(bits: Uint8Array, unused: number): Uint8Array {
  return tlv(0x03, concat([Uint8Array.of(unused), bits]));
}

function integer(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`not a positive integer: ${String(value)}`);
  }
  const bytes: number[] = [];
  let rest = value;
  do {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  } while (rest > 0);
  if ((bytes[0] & 0x80) !== 0) {
    bytes.unshift(0);
  }
  return tlv(0x02, Uint8Array.from(bytes));
}

function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length < 2) {
    throw new Error(`not an OID: ${dotted}`);
  }
  const body: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    let rest = part;
    do {
      chunk.unshift(rest & 0x7f);
      rest = Math.floor(rest / 128);
    } while (rest > 0);
    for (let index = 0; index < chunk.length - 1; index += 1) {
      chunk[index] |= 0x80;
    }
    body.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(body));
}

function utcTime(milliseconds: number): Uint8Array {
  const iso = new Date(milliseconds).toISOString();
  const text =
    iso.slice(2, 4) +
    iso.slice(5, 7) +
    iso.slice(8, 10) +
    iso.slice(11, 13) +
    iso.slice(14, 16) +
    iso.slice(17, 19) +
    "Z";
  return tlv(0x17, new TextEncoder().encode(text));
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) {
    return Uint8Array.of(length);
  }
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function spkiDer(key: KeyObject): Uint8Array {
  return new Uint8Array(key.export({ type: "spki", format: "der" }));
}

function pkcs8Der(key: KeyObject): Uint8Array {
  return new Uint8Array(key.export({ type: "pkcs8", format: "der" }));
}

function pkcs1Der(key: KeyObject): Uint8Array {
  return new Uint8Array(key.export({ type: "pkcs1", format: "der" }));
}

function pem(label: string, der: Uint8Array): string {
  const base64 = Buffer.from(der).toString("base64");
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// --- the control plane's files ---------------------------------------------

/** Writes n random bytes as base64 on one line, as the Go test does. */
async function writeSecretFile(dir: string, name: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
  return path;
}

interface ConfigInput {
  readonly dir: string;
  readonly servePort: number;
  readonly fakePort: number;
  readonly certPath: string;
  readonly keyPath: string;
  readonly appKeyPath: string;
  readonly webhookPath: string;
  readonly operatorPath: string;
  readonly localKeyPath: string;
}

/** Writes the control plane's configuration; the fields follow toshi-go's template. */
async function writeConfig(input: ConfigInput): Promise<string> {
  const dataDir = join(input.dir, "data");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const config = [
    `listen = "127.0.0.1:${String(input.servePort)}"`,
    `data_dir = ${tomlString(dataDir)}`,
    'log_level = "debug"',
    "",
    `tls_cert_file = ${tomlString(input.certPath)}`,
    `tls_key_file = ${tomlString(input.keyPath)}`,
    "",
    "[store]",
    'driver = "sqlite"',
    "",
    "[operator]",
    `token_file = ${tomlString(input.operatorPath)}`,
    "",
    "[secrets]",
    `local_key_file = ${tomlString(input.localKeyPath)}`,
    "",
    "[github]",
    "app_id = 1",
    `base_url = "http://127.0.0.1:${String(input.fakePort)}"`,
    `private_key_file = ${tomlString(input.appKeyPath)}`,
    `webhook_secret_file = ${tomlString(input.webhookPath)}`,
    "",
  ].join("\n");
  const path = join(input.dir, "toshi.toml");
  await writeFile(path, config, { mode: 0o600 });
  return path;
}

/** A TOML literal string: no escapes, so a path keeps its backslashes. */
function tomlString(value: string): string {
  if (value.includes("'")) {
    throw new Error(`cannot quote in TOML: ${value}`);
  }
  return `'${value}'`;
}
