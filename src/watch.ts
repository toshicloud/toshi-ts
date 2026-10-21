import { clone, create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";

import type { CallOptions, EventWatch, WorkloadWatch } from "./client.js";
import {
  ListEventsRequestSchema,
  ListWorkloadsRequestSchema,
  WatchEventsRequestSchema,
  WatchWorkloadsRequestSchema,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import type {
  Event,
  ListEventsRequest,
  ListWorkloadsRequest,
  WatchEventsRequest,
  WatchWorkloadsRequest,
  WatchWorkloadsResponse,
  Workload,
  WorkspaceService,
} from "./gen/toshi/workspace/v1/workspace_pb.js";
import type { RetrySetting } from "./retry.js";
import { READER_TAKEN, WatchState, createReader, reconnect, streamEnded } from "./stream.js";


/** Starts a workload watch; with an empty cursor it lists the workloads first (watch.go:40-84). */
export async function openWorkloadWatch(
  workspace: Client<typeof WorkspaceService>,
  retry: RetrySetting,
  req: WatchWorkloadsRequest,
  opts?: CallOptions,
): Promise<WorkloadWatch> {
  const state = new WatchState(req.cursor, opts?.signal);
  let snapshot: Workload[] | undefined;
  if (req.cursor === "") {
    try {
      const listed = await listWorkloads(workspace, req, state);
      snapshot = listed.workloads;
      state.cursor = listed.cursor;
    } catch (err) {
      state.close();
      throw err;
    }
  }

  const request = clone(WatchWorkloadsRequestSchema, req);
  request.cursor = state.cursor;
  request.keepalive = true;

  let reader: AsyncIterableIterator<WatchWorkloadsResponse> | undefined;
  return {
    get cursor(): string {
      return state.cursor;
    },
    get snapshot(): Workload[] | undefined {
      return snapshot;
    },
    close(): void {
      state.close();
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<WatchWorkloadsResponse> {
      if (reader !== undefined) {
        throw new Error(READER_TAKEN);
      }
      reader = createReader(
        () => runWorkloads(workspace, retry, request, state),
        () => state.close(),
      );
      return reader;
    },
  };
}

/** Starts an event watch; with an empty cursor it pages ListEvents as the caller iterates (watch.go:261-283). */
export function openEventWatch(
  workspace: Client<typeof WorkspaceService>,
  retry: RetrySetting,
  req: WatchEventsRequest,
  opts?: CallOptions,
): Promise<EventWatch> {
  const state = new WatchState(req.cursor, opts?.signal);
  const request = clone(WatchEventsRequestSchema, req);
  request.keepalive = true;
  const list = createListEventsRequest(req);
  const listing = req.cursor === "";

  let reader: AsyncIterableIterator<Event> | undefined;
  const watch: EventWatch = {
    get cursor(): string {
      return state.cursor;
    },
    close(): void {
      state.close();
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<Event> {
      if (reader !== undefined) {
        throw new Error(READER_TAKEN);
      }
      reader = createReader(
        () => runEvents(workspace, retry, request, list, listing, state),
        () => state.close(),
      );
      return reader;
    },
  };
  return Promise.resolve(watch);
}

// watch.go:65-84: every page of the list returns the event log's position.
async function listWorkloads(
  workspace: Client<typeof WorkspaceService>,
  req: WatchWorkloadsRequest,
  state: WatchState,
): Promise<{ workloads: Workload[]; cursor: string }> {
  const list = createListWorkloadsRequest(req);
  const workloads: Workload[] = [];
  for (;;) {
    const page = await workspace.listWorkloads(list, { signal: state.signal });
    workloads.push(...page.workloads);
    if (page.nextPageToken === "") {
      return { workloads, cursor: page.cursor };
    }
    list.pageToken = page.nextPageToken;
  }
}

function createListWorkloadsRequest(req: WatchWorkloadsRequest): ListWorkloadsRequest {
  return create(ListWorkloadsRequestSchema, {
    project: req.project,
    environment: req.environment,
    kinds: req.kinds,
  });
}

function createListEventsRequest(req: WatchEventsRequest): ListEventsRequest {
  return create(ListEventsRequestSchema, {
    project: req.project,
    environment: req.environment,
    workloadId: req.workloadId,
  });
}

async function* runWorkloads(
  workspace: Client<typeof WorkspaceService>,
  retry: RetrySetting,
  request: WatchWorkloadsRequest,
  state: WatchState,
): AsyncGenerator<WatchWorkloadsResponse, void, undefined> {
  let attempt = 0;
  try {
    for (;;) {
      if (state.closed) {
        return;
      }
      let cause: unknown;
      try {
        request.cursor = state.cursor;
        const stream = workspace.watchWorkloads(request, { signal: state.signal });
        for await (const msg of stream) {
          attempt = 0;
          if (msg.keepalive !== undefined) {
            if (msg.keepalive.cursor !== "") {
              state.cursor = msg.keepalive.cursor;
            }
            continue;
          }
          if (msg.cursor !== "") {
            state.cursor = msg.cursor;
          }
          yield msg;
        }
        if (state.closed) {
          return;
        }
        cause = streamEnded;
      } catch (err) {
        if (state.closed) {
          return;
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

async function* runEvents(
  workspace: Client<typeof WorkspaceService>,
  retry: RetrySetting,
  request: WatchEventsRequest,
  list: ListEventsRequest,
  listingAtStart: boolean,
  state: WatchState,
): AsyncGenerator<Event, void, undefined> {
  let attempt = 0;
  let page: Event[] = [];
  let pageIndex = 0;
  let listing = listingAtStart;
  // watch.go:305-317: resume is the position the next stream opens at, separate
  // from the cursor the caller sees, which only moves on events handed out and
  // keepalives consumed.
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
            yield event;
            continue;
          }
          const listed = await workspace.listEvents(list, { signal: state.signal });
          page = listed.events;
          pageIndex = 0;
          if (listed.cursor !== "") {
            list.cursor = listed.cursor;
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
        const stream = workspace.watchEvents(request, { signal: state.signal });
        for await (const msg of stream) {
          attempt = 0;
          const keepalive = msg.keepalive;
          if (keepalive !== undefined) {
            if (keepalive.cursor !== "") {
              state.cursor = keepalive.cursor;
              resume = keepalive.cursor;
            }
            continue;
          }
          const event = msg.event;
          if (event === undefined) {
            continue;
          }
          if (event.cursor !== "") {
            state.cursor = event.cursor;
            resume = event.cursor;
          }
          yield event;
        }
        if (state.closed) {
          return;
        }
        cause = streamEnded;
      } catch (err) {
        if (state.closed) {
          return;
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

