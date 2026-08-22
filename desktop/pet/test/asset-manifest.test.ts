import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const thumb = path.join(here, "..", "assets", "thumb");

describe("pet asset manifest", () => {
  it("ships exactly 91 webm in assets/thumb/", () => {
    expect(existsSync(thumb)).toBe(true);
    const files = readdirSync(thumb).filter((f) => f.endsWith(".webm"));
    expect(files).toHaveLength(91);
  });

  it("matches dsh-pet's assets/thumb/ sorted-name set", () => {
    const local = readdirSync(thumb)
      .filter((f) => f.endsWith(".webm"))
      .sort();
    // dsh path is hard-coded for this monorepo layout; portability is not a goal.
    const dshDir = "/Users/n0mad/code/dsh-pet/dsh-pet/assets/thumb";
    const dsh = readdirSync(dshDir)
      .filter((f) => f.endsWith(".webm"))
      .sort();
    expect(local).toEqual(dsh);
  });
});
