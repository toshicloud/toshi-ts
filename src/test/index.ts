/**
 * A fake Toshi for tests: an in-memory Workspace API served through
 * `@connectrpc/connect`'s router transport.
 *
 * A test creates a fake, tells it what to answer, and calls the client:
 *
 * ```ts
 * const fake = createFake();
 * fake.job("job-1").stdout("deployed\n").exitCode(0);
 * const toshi = fake.client();
 * ```
 *
 * `createFake` serves every service of `toshi.workspace.v1` from one
 * in-memory transport: no server, no port, nothing to close, and no Node
 * module, so it runs wherever the client runs. `client` returns a
 * `ToshiClient` wired to it, with the token "test-token" and the scope
 * default/production.
 *
 * # What the fake answers
 *
 * The fake holds one workspace and has no clock: every call answers at once
 * with what the test set. It knows the job and the sandbox lifecycle and
 * nothing else.
 *
 * - `job`, `sandbox` and `execute` set what the fake answers: a job's or a
 *   sandbox's state, and the standard output, the standard error and the exit
 *   code of a job or of a command run in a sandbox. A job or a sandbox the
 *   test set no state for is running; a job or a command the test set no exit
 *   code for exits 0.
 * - CreateJob answers the jobs registered with `job`, in the order they were
 *   registered, and then creates job-1, job-2, ... of its own. CreateSandbox
 *   does the same for `sandbox` and sandbox-1, sandbox-2, .... A create whose
 *   request key the fake has already answered returns the same workload.
 * - GetJob, ListJobs, CancelJob, WaitJob and WatchOutput answer from the jobs
 *   that exist; GetSandbox, ListSandboxes, WaitSandbox and WatchSandboxes
 *   from the sandboxes. An id the fake does not hold is NOT_FOUND. The lists
 *   answer every workload the fake holds, in creation order: they do not apply
 *   the request's filters or page size.
 * - WaitJob and WaitSandbox answer at once, reached, with the workload as the
 *   test set it.
 * - WatchOutput streams a job's standard output and standard error from the
 *   offsets the request names, then the job's end.
 * - WatchJobs and WatchSandboxes report each change made after the cursor the
 *   request names: a workload the fake creates, and each state the test sets.
 *   ListJobs and ListSandboxes answer the cursor a watch starts at.
 * - Execute answers the start message with an execution id, the standard
 *   output, the standard error and the exit code the test set for the sandbox.
 *   It does not read standard input.
 *
 * Every other procedure is hook-only. An unhooked procedure the state machine
 * does not cover answers UNIMPLEMENTED, naming the procedure and the `on` call
 * that supplies an answer. A hook replaces the state machine for its method.
 *
 * `calls` returns every call the fake received, in order, with its request and
 * its headers.
 */

export { createFake, testToken } from "./fake.js";
export type { Call, Fake, FakeExecution, FakeJob, FakeOptions, FakeSandbox } from "./fake.js";
