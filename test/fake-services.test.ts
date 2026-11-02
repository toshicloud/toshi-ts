import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiPackage, apiServices } from "../src/test/procedures.js";

// docs/testing.md names the services the fake serves and the ones it does not,
// between these markers. The lists are this test's: when they drift from the
// code, the failure shows the section to paste.
const begin = "<!-- fake services: begin -->";
const end = "<!-- fake services: end -->";

/** Every service of the Workspace API, as the generated code declares it. */
function generatedServices(): string[] {
  const dir = new URL(`../src/gen/${apiPackage.replaceAll(".", "/")}/`, import.meta.url);
  const declared = new RegExp(`@generated from service ${apiPackage.replaceAll(".", "\\.")}\\.(\\w+)$`, "gm");
  const names = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith("_pb.ts"))) {
    for (const match of readFileSync(new URL(file, dir), "utf8").matchAll(declared)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
}

function section(served: readonly string[], unserved: readonly string[]): string {
  const list = (names: readonly string[]) => names.map((name) => `- \`${name}\``).join("\n");
  return [
    begin,
    `The fake serves these services of \`${apiPackage}\`:`,
    "",
    list(served),
    "",
    "It does not serve these: a call to one of their methods answers",
    "`UNIMPLEMENTED`, and `fake.on` throws for their methods.",
    "",
    list(unserved),
    end,
  ].join("\n");
}

describe("the services the fake serves", () => {
  it("are the ones docs/testing.md lists", () => {
    const all = generatedServices();
    const served = apiServices.map((service) => service.name).sort();
    expect(served.filter((name) => !all.includes(name)), "served but not generated").toEqual([]);
    const expected = section(
      served,
      all.filter((name) => !served.includes(name)),
    );
    const page = readFileSync(new URL("../docs/testing.md", import.meta.url), "utf8");
    const from = page.indexOf(begin);
    const to = page.indexOf(end);
    expect(from, "docs/testing.md has no fake services section").toBeGreaterThanOrEqual(0);
    expect(page.slice(from, to + end.length)).toBe(expected);
  });
});
