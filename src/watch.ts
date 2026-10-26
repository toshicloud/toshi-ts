import { clone, create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";

import type { CallOptions, EventWatch, JobWatch, SandboxWatch, ServiceWatch } from "./client.js";
import {
  ListJobsRequestSchema,
  ListSandboxesRequestSchema,
  ListServicesRequestSchema,
  WatchJobsRequestSchema,
  WatchSandboxesRequestSchema,
  WatchServicesRequestSchema,
} from "./gen/toshi/workspace/v1/workloads_pb.js";
import type {
  ListJobsRequest,
  ListSandboxesRequest,
  ListServicesRequest,
  WatchJobsRequest,
  WatchJobsResponse,
  WatchSandboxesRequest,
  WatchSandboxesResponse,
  WatchServicesRequest,
  WatchServicesResponse,
  WorkloadService,
} from "./gen/toshi/workspace/v1/workloads_pb.js";
import {
  ListEventsRequestSchema,
  WatchEventsRequestSchema,
  WatchEventsResponseSchema,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import type {
  Event,
  Job,
  ListEventsRequest,
  Sandbox,
  Service,
  WatchEventsRequest,
  WatchEventsResponse,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import type { RetrySetting } from "./retry.js";
import { READER_TAKEN, WatchState, createReader, reconnect, streamEnded } from "./stream.js";
import { timeoutError } from "./timeout.js";

/** The shared shape of the three typed watches: a request, a pre-list and a stream. */
interface WatchWire<WResp, Item> {
  /** The watch request as handed to the server; its cursor follows the watch. */
  readonly request: { cursor: string; keepalive: boolean };
  /** The list the watch starts from, read to its last page. */
  readonly list: (signal: AbortSignal) => Promise<{ items: Item[]; cursor: string }>;
  readonly watch: (signal: AbortSignal) => AsyncIterable<WResp>;
  readonly cursor: (message: WResp) => string;
  /** A keepalive's position; undefined when the message is not a keepalive. */
  readonly keepalive: (message: WResp) => { readonly cursor: string } | undefined;
}

/** The watch a caller iterates; the concrete watches below differ only in their types. */
interface IterableWatch<WResp, Item> extends AsyncIterable<WResp> {
  readonly cursor: string;
  readonly snapshot: Item[] | undefined;
  close(): void;
}

/** Starts a job watch; with an empty cursor it lists the jobs first. */
export function openJobWatch(
  service: Client<typeof WorkloadService>,
  retry: RetrySetting,
  req: WatchJobsRequest,
  opts?: CallOptions,
): Promise<JobWatch> {
  const request = clone(WatchJobsRequestSchema, req);
  return openWatch<WatchJobsResponse, Job>(
    {
      request,
      list: async (signal) => {
        const list: ListJobsRequest = create(ListJobsRequestSchema, {
          project: request.project,
          environment: request.environment,
        });
        const items: Job[] = [];
        for (;;) {
          const page = await service.listJobs(list, { signal });
          items.push(...page.jobs);
          if (page.nextPageToken === "") {
            return { items, cursor: page.cursor };
          }
          list.pageToken = page.nextPageToken;
        }
      },
      watch: (signal) => service.watchJobs(request, { signal }),
      cursor: (message) => message.cursor,
      keepalive: (message) => message.keepalive,
    },
    retry,
    opts,
  );
}

/** Starts a sandbox watch; with an empty cursor it lists the sandboxes first. */
export function openSandboxWatch(
  service: Client<typeof WorkloadService>,
  retry: RetrySetting,
  req: WatchSandboxesRequest,
  opts?: CallOptions,
): Promise<SandboxWatch> {
  const request = clone(WatchSandboxesRequestSchema, req);
  return openWatch<WatchSandboxesResponse, Sandbox>(
    {
      request,
      list: async (signal) => {
        const list: ListSandboxesRequest = create(ListSandboxesRequestSchema, {
          project: request.project,
          environment: request.environment,
        });
        const items: Sandbox[] = [];
        for (;;) {
          const page = await service.listSandboxes(list, { signal });
          items.push(...page.sandboxes);
          if (page.nextPageToken === "") {
            return { items, cursor: page.cursor };
          }
          list.pageToken = page.nextPageToken;
        }
      },
      watch: (signal) => service.watchSandboxes(request, { signal }),
      cursor: (message) => message.cursor,
      keepalive: (message) => message.keepalive,
    },
    retry,
    opts,
  );
}

/** Starts a service watch; with an empty cursor it lists the services first. */
export function openServiceWatch(
  service: Client<typeof WorkloadService>,
  retry: RetrySetting,
  req: WatchServicesRequest,
  opts?: CallOptions,
): Promise<ServiceWatch> {
  const request = clone(WatchServicesRequestSchema, req);
  return openWatch<WatchServicesResponse, Service>(
    {
      request,
      list: async (signal) => {
        const list: ListServicesRequest = create(ListServicesRequestSchema, {
          project: request.project,
          environment: request.environment,
        });
        const items: Service[] = [];
        for (;;) {
          const page = await service.listServices(list, { signal });
          items.push(...page.services);
          if (page.nextPageToken === "") {
            return { items, cursor: page.cursor };
          }
          list.pageToken = page.nextPageToken;
        }
      },
      watch: (signal) => service.watchServices(request, { signal }),
      cursor: (message) => message.cursor,
      keepalive: (message) => message.keepalive,
    },
    retry,
    opts,
  );
}

async function openWatch<WResp, Item>(
  wire: WatchWire<WResp, Item>,
  retry: RetrySetting,
  opts?: CallOptions,
): Promise<IterableWatch<WResp, Item>> {
  const state = new WatchState(wire.request.cursor, opts?.signal, opts?.timeoutMs);
  let snapshot: Item[] | undefined;
  if (wire.request.cursor === "") {
    try {
      const listed = await wire.list(state.signal);
      snapshot = listed.items;
      state.cursor = listed.cursor;
    } catch (err) {
      state.close();
      if (state.timedOut) {
        throw timeoutError(state.timeoutMs as number);
      }
      throw err;
    }
  }
  wire.request.cursor = state.cursor;
  wire.request.keepalive = true;

  let reader: AsyncIterableIterator<WResp> | undefined;
  return {
    get cursor(): string {
      return state.cursor;
    },
    get snapshot(): Item[] | undefined {
      return snapshot;
    },
    close(): void {
      state.close();
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<WResp> {
      if (reader !== undefined) {
        throw new Error(READER_TAKEN);
      }
      reader = createReader(
        () => runWatch(wire, retry, state),
        () => state.close(),
      );
      return reader;
    },
  };
}

async function* runWatch<WResp, Item>(
  wire: WatchWire<WResp, Item>,
  retry: RetrySetting,
  state: WatchState,
): AsyncGenerator<WResp, void, undefined> {
  let attempt = 0;
  try {
    for (;;) {
      if (state.closed) {
        return;
      }
      let cause: unknown;
      try {
        wire.request.cursor = state.cursor;
        for await (const message of wire.watch(state.signal)) {
          state.markOpen();
          attempt = 0;
          const keepalive = wire.keepalive(message);
          if (keepalive !== undefined) {
            if (keepalive.cursor !== "") {
              state.cursor = keepalive.cursor;
            }
            continue;
          }
          const cursor = wire.cursor(message);
          if (cursor !== "") {
            state.cursor = cursor;
          }
          yield message;
        }
        if (state.closed) {
          return;
        }
        cause = streamEnded;
      } catch (err) {
        if (state.closed) {
          return;
        }
        if (state.timedOut) {
          throw timeoutError(state.timeoutMs as number);
        }
        cause = err;
      }
      attempt = await reconnect(retry, attempt, cause, state);
    }
  } catch (err) {
    if (state.closed) {
      return;
    }
    throw err;
  }
}

/**
 * Starts an event watch; with an empty cursor it pages the event log as the
 * caller iterates. Every message it yields is the stream's response.
 */
export function openEventWatch(
  service: Client<typeof WorkloadService>,
  retry: RetrySetting,
  req: WatchEventsRequest,
  opts?: CallOptions,
): Promise<EventWatch> {
  const state = new WatchState(req.cursor, opts?.signal, opts?.timeoutMs);
  const request = clone(WatchEventsRequestSchema, req);
  request.keepalive = true;
  const list = create(ListEventsRequestSchema, {
    project: req.project,
    environment: req.environment,
    workloadId: req.workloadId,
  });
  const listing = req.cursor === "";

  let reader: AsyncIterableIterator<WatchEventsResponse> | undefined;
  const watch: EventWatch = {
    get cursor(): string {
      return state.cursor;
    },
    close(): void {
      state.close();
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<WatchEventsResponse> {
      if (reader !== undefined) {
        throw new Error(READER_TAKEN);
      }
      reader = createReader(
        () => runEvents(service, retry, request, list, listing, state),
        () => state.close(),
      );
      return reader;
    },
  };
  return Promise.resolve(watch);
}

async function* runEvents(
  service: Client<typeof WorkloadService>,
  retry: RetrySetting,
  request: WatchEventsRequest,
  list: ListEventsRequest,
  listingAtStart: boolean,
  state: WatchState,
): AsyncGenerator<WatchEventsResponse, void, undefined> {
  let attempt = 0;
  let page: Event[] = [];
  let pageIndex = 0;
  let listing = listingAtStart;
  // Resume is the position the next stream opens at, separate from the cursor
  // the caller sees, which only moves on events handed out and keepalives read.
  let resume = state.cursor;
  try {
    for (;;) {
      if (state.closed) {
        return;
      }
      let cause: unknown;
      try {
        if (listing) {
          if (pageIndex < page.length) {
            const event = page[pageIndex];
            pageIndex += 1;
            attempt = 0;
            if (event.cursor !== "") {
              state.cursor = event.cursor;
              resume = event.cursor;
            }
            state.markOpen();
            yield create(WatchEventsResponseSchema, { event });
            continue;
          }
          const listed = await service.listEvents(list, { signal: state.signal });
          page = listed.events;
          pageIndex = 0;
          if (listed.cursor !== "") {
            list.pageToken = listed.cursor;
          }
          if (page.length > 0) {
            continue;
          }
          if (listed.cursor !== "") {
            resume = listed.cursor;
          }
          listing = false;
          continue;
        }

        request.cursor = resume;
        for await (const message of service.watchEvents(request, { signal: state.signal })) {
          state.markOpen();
          attempt = 0;
          const keepalive = message.keepalive;
          if (keepalive !== undefined) {
            if (keepalive.cursor !== "") {
              state.cursor = keepalive.cursor;
              resume = keepalive.cursor;
            }
            continue;
          }
          const event = message.event;
          if (event === undefined) {
            continue;
          }
          if (event.cursor !== "") {
            state.cursor = event.cursor;
            resume = event.cursor;
          }
          yield message;
        }
        if (state.closed) {
          return;
        }
        cause = streamEnded;
      } catch (err) {
        if (state.closed) {
          return;
        }
        if (state.timedOut) {
          throw timeoutError(state.timeoutMs as number);
        }
        cause = err;
      }
      attempt = await reconnect(retry, attempt, cause, state);
    }
  } catch (err) {
    if (state.closed) {
      return;
    }
    throw err;
  }
}
