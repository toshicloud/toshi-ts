import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiPackage, apiServices } from "../src/test/procedures.js";

// docs/testing.md names the services the fake serves between these markers.
// The list is this test's: when it drifts from the code, the failure shows
// the section to paste.
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

function section(served: readonly string[]): string {
  return [
    begin,
    `The fake serves every service of \`${apiPackage}\`:`,
    "",
    ...served.map((name) => `- \`${name}\``),
    "",
    "A method the fake has no built-in answer for answers `UNIMPLEMENTED`",
    "until a test hooks it with `fake.on`.",
    end,
  ].join("\n");
}

describe("the services the fake serves", () => {
  it("are every service the generated code declares, and the ones docs/testing.md lists", () => {
    const served = apiServices.map((service) => service.name).sort();
    expect(served).toEqual(generatedServices());
    const page = readFileSync(new URL("../docs/testing.md", import.meta.url), "utf8");
    const from = page.indexOf(begin);
    const to = page.indexOf(end);
    expect(from, "docs/testing.md has no fake services section").toBeGreaterThanOrEqual(0);
    expect(page.slice(from, to + end.length)).toBe(section(served));
  });
});
