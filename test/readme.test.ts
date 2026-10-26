import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

interface Block {
  marker: string | undefined;
  content: string;
}

/** Every fenced TypeScript block in the README, with the marker above it. */
function typescriptBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let marker: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const named = /^<!-- (examples\/[\w./-]+\.ts) -->$/.exec(line);
    if (named) {
      marker = named[1];
      continue;
    }
    if (line === "```ts") {
      const content: string[] = [];
      for (index += 1; index < lines.length && lines[index].trim() !== "```"; index += 1) {
        content.push(lines[index]);
      }
      blocks.push({ marker, content: content.join("\n") });
      marker = undefined;
      continue;
    }
    if (line !== "") {
      marker = undefined;
    }
  }
  return blocks;
}

/** A block and its file compare equal without indentation or import lines. */
function normalise(source: string): string[] {
  const lines = source
    .split("\n")
    .filter((line) => !/^\s*import\b/.test(line))
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0].trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  const indent = Math.min(
    ...lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length),
  );
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0));
}

describe("README examples", () => {
  const blocks = typescriptBlocks(readme);

  it("names an example file above every TypeScript block", () => {
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.marker, "a TypeScript block has no example marker").toBeDefined();
    }
  });

  it("keeps every TypeScript block equal to its example file", () => {
    for (const block of blocks) {
      if (block.marker === undefined) {
        expect.fail("a TypeScript block has no example marker");
      }
      const source = readFileSync(new URL(`../${block.marker}`, import.meta.url), "utf8");
      expect(normalise(block.content), block.marker).toEqual(normalise(source));
    }
  });
});
