import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";

import type { CallOptions, JobRun, OutputChunk, OutputWatch } from "./client.js";
import { JobExitError } from "./errors.js";
import { OutputEndSchema, WatchOutputRequestSchema } from "./gen/toshi/workspace/v1/workspace_pb.js";
import type {
  Job,
  Output,
  OutputEnd,
  WatchOutputResponse,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import { EndReason } from "./gen/toshi/workspace/v1/workspace_pb.js";
import type { CreateJobRequest, WorkloadService } from "./gen/toshi/workspace/v1/workloads_pb.js";
import { openOutputWatch } from "./output.js";
import type { RetrySetting } from "./retry.js";

/**
 * Starts a job and follows its output, as `toshi run` does: CreateJob, then
 * WatchOutput from the first byte. A job whose create answered its output
 * (wait_for_end was set) is returned finished.
 */
export async function runJob(
  service: Client<typeof WorkloadService>,
  retry: RetrySetting,
  req: CreateJobRequest,
  opts?: CallOptions,
): Promise<JobRun> {
  const created = await service.createJob(req, opts);
  const job = created.job;
  if (job === undefined) {
    throw new Error("toshi: CreateJob answered no job");
  }
  if (created.output !== undefined) {
    return new FinishedRun(job, created.output);
  }
  const watch = await openOutputWatch(
    service,
    retry,
    create(WatchOutputRequestSchema, {
      project: req.project,
      environment: req.environment,
      id: job.id,
    }),
    opts,
  );
  return new LiveRun(job, watch);
}

/** A run whose create answered the job's output instead of a live stream. */
class FinishedRun implements JobRun {
  readonly job: Job;
  private readonly output: Output;
  private queue: OutputChunk[] | undefined;

  constructor(job: Job, output: Output) {
    this.job = job;
    this.output = output;
  }

  [Symbol.asyncIterator](): AsyncIterator<OutputChunk> {
    this.queue ??= chunksOf(this.output);
    const queue = this.queue;
    return {
      next: () => {
        const chunk = queue.shift();
        return Promise.resolve(
          chunk === undefined ? { done: true, value: undefined } : { done: false, value: chunk },
        );
      },
    };
  }

  wait(): Promise<void> {
    const end = create(OutputEndSchema, {
      exitCode: this.job.status?.exitCode,
      cancelled: this.job.status?.endReason === EndReason.CANCELLED,
      truncated: this.output.truncated,
    });
    if (end.exitCode === 0) {
      return Promise.resolve();
    }
    return Promise.reject(new JobExitError(this.job.id, end));
  }
}

/** A run whose output the server streams while the job runs. */
class LiveRun implements JobRun {
  readonly job: Job;
  private readonly watch: OutputWatch;
  private readonly responses: AsyncIterator<WatchOutputResponse>;
  private readonly queue: OutputChunk[] = [];
  private end: OutputEnd | undefined;
  private failure: Error | undefined;
  private readerOwned = false;
  private waitPromise: Promise<void> | undefined;

  constructor(job: Job, watch: OutputWatch) {
    this.job = job;
    this.watch = watch;
    this.responses = watch[Symbol.asyncIterator]();
  }

  [Symbol.asyncIterator](): AsyncIterator<OutputChunk> {
    if (this.readerOwned) {
      throw new Error("toshi: this run already has an output reader");
    }
    this.readerOwned = true;
    return {
      next: () => this.pull(),
      // A break ends only this reader: the job keeps running.
      return: () => {
        this.watch.close();
        return Promise.resolve({ done: true, value: undefined });
      },
    };
  }

  wait(): Promise<void> {
    this.waitPromise ??= this.awaitOutcome();
    return this.waitPromise;
  }

  private async awaitOutcome(): Promise<void> {
    if (!this.readerOwned) {
      // No reader owns the output: take it and drain it, so wait() never stalls.
      this.readerOwned = true;
      try {
        for (;;) {
          const result = await this.pull();
          if (result.done === true) {
            break;
          }
        }
      } catch {
        // pull() recorded the outcome; it is reported below.
      }
    }
    for (;;) {
      if (this.failure !== undefined) {
        throw this.failure;
      }
      if (this.end !== undefined) {
        if (this.end.exitCode === 0 && !this.end.cancelled) {
          return;
        }
        throw new JobExitError(this.job.id, this.end);
      }
      await this.readOne();
    }
  }

  private async pull(): Promise<IteratorResult<OutputChunk>> {
    for (;;) {
      const chunk = this.queue.shift();
      if (chunk !== undefined) {
        return { done: false, value: chunk };
      }
      if (this.failure !== undefined) {
        throw this.failure;
      }
      if (this.end !== undefined) {
        return { done: true, value: undefined };
      }
      await this.readOne();
    }
  }

  private async readOne(): Promise<void> {
    let result: IteratorResult<WatchOutputResponse>;
    try {
      result = await this.responses.next();
    } catch (err) {
      this.failure = err instanceof Error ? err : new Error(String(err));
      return;
    }
    if (result.done === true) {
      this.failure = new Error("toshi: the output stream ended without its end message");
      return;
    }
    const message = result.value.message;
    switch (message.case) {
      case "stdout":
        this.queue.push({ stream: "stdout", data: message.value });
        return;
      case "stderr":
        this.queue.push({ stream: "stderr", data: message.value });
        return;
      case "end":
        this.end = message.value;
        // The watch has nothing left to send; release the RPC.
        this.watch.close();
        return;
      default:
        return;
    }
  }
}

function chunksOf(output: Output): OutputChunk[] {
  const chunks: OutputChunk[] = [];
  if (output.stdout.length > 0) {
    chunks.push({ stream: "stdout", data: output.stdout });
  }
  if (output.stderr.length > 0) {
    chunks.push({ stream: "stderr", data: output.stderr });
  }
  return chunks;
}
