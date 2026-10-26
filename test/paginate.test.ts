import { describe, expect, it } from "vitest";

import type { CallOptions } from "../src/index.js";
import { paginate } from "../src/index.js";

/** A list request: the page token plus what the call filters by. */
interface Req {
  pageToken?: string;
  filter?: string;
}

/** A list response: the token of the page after it, and its items. */
interface Page {
  nextPageToken: string;
  names: string[];
}

/** A page-at-a-time list call over pages, recording what each request asked. */
function pager(pages: readonly Page[], failOn?: number) {
  const sent: Array<{ page: Req; token: string; opts?: CallOptions }> = [];
  const call = (page: Req, opts?: CallOptions): Promise<Page> => {
    sent.push({ page, token: page.pageToken ?? "", opts });
    if (sent.length === failOn) {
      return Promise.reject(new Error("list failed"));
    }
    const response = pages[sent.length - 1];
    return response === undefined ? Promise.reject(new Error("no page")) : Promise.resolve(response);
  };
  const tokens = (): string[] => sent.map((s) => s.token);
  return { call, sent, tokens };
}

/** Every item of an iterable, in order. */
async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const names: string[] = [];
  for await (const name of iterable) {
    names.push(name);
  }
  return names;
}

const pages: readonly Page[] = [
  { nextPageToken: "t1", names: ["a", "b"] },
  { nextPageToken: "t2", names: ["c"] },
  { nextPageToken: "", names: ["d"] },
];

describe("paginate", () => {
  it("reads every page, sending each response's next page token", async () => {
    const { call, sent, tokens } = pager(pages);
    const opts: CallOptions = { timeoutMs: 1000 };
    const names = await collect(paginate<Req, Page, string>({}, call, (resp) => resp.names, opts));
    expect(names).toEqual(["a", "b", "c", "d"]);
    expect(tokens()).toEqual(["", "t1", "t2"]);
    expect(sent.map((s) => s.opts)).toEqual([opts, opts, opts]);
  });

  it("resumes from the page token the caller set and leaves the request alone", async () => {
    const { call, sent, tokens } = pager([{ nextPageToken: "", names: ["z"] }]);
    const req: Req = { pageToken: "t9", filter: "running" };
    expect(await collect(paginate<Req, Page, string>(req, call, (resp) => resp.names))).toEqual(["z"]);
    expect(tokens()).toEqual(["t9"]);
    expect(sent[0].page).not.toBe(req);
    expect(req).toEqual({ pageToken: "t9", filter: "running" });
  });

  it("throws a failing page once and ends", async () => {
    const { call, tokens } = pager(pages, 2);
    const iterator = paginate<Req, Page, string>({}, call, (resp) => resp.names)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "a" });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "b" });
    await expect(iterator.next()).rejects.toThrow("list failed");
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(tokens()).toEqual(["", "t1"]);
  });

  it("sends no further page after the loop breaks", async () => {
    const { call, tokens } = pager(pages);
    for await (const name of paginate<Req, Page, string>({}, call, (resp) => resp.names)) {
      expect(name).toBe("a");
      break;
    }
    expect(tokens()).toEqual([""]);
  });
});
