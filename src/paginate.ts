import type { CallOptions } from "./client.js";

/** A List request: it may name the page to read first. */
export interface PageRequest {
  /** From an earlier response's nextPageToken; empty for the first page. */
  pageToken?: string | undefined;
}

/** A List response: it names the page after it. */
export interface PageResponse {
  /** Empty on the last page. */
  readonly nextPageToken: string;
}

/**
 * Yields every item of a page-at-a-time list call, one page after another.
 *
 * `call` is a service client's list method, and `items` picks a response's
 * items:
 *
 * ```ts
 * for await (const project of paginate(
 *   {},
 *   (req, opts) => toshi.project.listProjects(req, opts),
 *   (resp) => resp.projects,
 * )) {
 *   console.log(project.name);
 * }
 * ```
 *
 * `paginate` sends a copy of `req`, so the caller's request keeps its fields
 * and a `pageToken` it set resumes from that page. It reads each response's
 * `nextPageToken` and sends it as the next request's `pageToken`. The
 * iteration ends after a page whose `nextPageToken` is empty, when the loop
 * breaks, or after an error, which the `for await` throws once and then ends.
 * `opts` goes to every page, so `timeoutMs` bounds each page and not the
 * whole iteration.
 */
export async function* paginate<Req extends PageRequest, Resp extends PageResponse, Item>(
  req: Req,
  call: (req: Req, opts?: CallOptions) => Promise<Resp>,
  items: (resp: Resp) => readonly Item[],
  opts?: CallOptions,
): AsyncGenerator<Item, void, undefined> {
  const page: Req = { ...req };
  for (;;) {
    const resp = await call(page, opts);
    for (const item of items(resp)) {
      yield item;
    }
    if (!resp.nextPageToken) {
      return;
    }
    page.pageToken = resp.nextPageToken;
  }
}
