import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PET_CONFIG } from "../src/pet-config.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const referenced = new Set<string>([
  ...PET_CONFIG.animations.idle,
  ...PET_CONFIG.animations.turn,
  ...PET_CONFIG.animations.drag,
  ...PET_CONFIG.animations.clicks,
  ...PET_CONFIG.animations.moves,
  ...PET_CONFIG.animations.categories.flatMap((c) => c.actions),
]);

describe("pet config manifest", () => {
  it("references exactly the shipped webm set (name coverage)", () => {
    const thumb = path.join(here, "..", "assets", "thumb");
    const files = readdirSync(thumb)
      .filter((f) => f.endsWith(".webm"))
      .map((f) => f.replace(/\.webm$/, ""))
      .sort();
    expect(files).toHaveLength(91);
    expect([...referenced].sort()).toEqual(files);
  });

  it("keeps dsh's weight math and click pool", () => {
    const catSum = PET_CONFIG.animations.categories.reduce(
      (s, c) => s + c.weight,
      0,
    );
    expect(catSum).toBe(80);
    expect(PET_CONFIG.animationWeights).toEqual({ idle: 10, turn: 5, move: 5 });
    expect(PET_CONFIG.animations.clicks).toHaveLength(5);
    expect(
      PET_CONFIG.animations.categories
        .filter((c) => c.noMirror)
        .map((c) => c.id),
    ).toEqual(["文字"]);
  });
});
