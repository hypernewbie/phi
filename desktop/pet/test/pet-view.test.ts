/**
 * jsdom unit tests for src/pet-view.ts: pure chain helpers (pickNextKind,
 * pick, planMove) + the initPet state machine (ended transitions, the
 * drag-stall fix, drag delta reporting). Deterministic Math.random is
 * injected via opts.rng so the chain picks are exact.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTS,
  CLICKS,
  IDLE,
  MOVES,
  TURN,
  initPet,
  pick,
  pickNextKind,
  planMove,
  randomBetween,
} from "../src/pet-view.js";
import type { TerritoryBounds } from "../src/pet-bridge.js";

function buildDom() {
  const root = document.createElement("div");
  root.id = "pet-root";
  const stage = document.createElement("div");
  stage.id = "pet-stage";
  const videoA = document.createElement("video");
  videoA.id = "pet-video-a";
  videoA.className = "is-front";
  const videoB = document.createElement("video");
  videoB.id = "pet-video-b";
  const hit = document.createElement("div");
  hit.id = "pet-hit";
  stage.append(videoA, videoB, hit);
  root.append(stage);
  document.body.replaceChildren(root);
  return { root, stage, videoA, videoB, hit };
}

function makeBridge() {
  return {
    sendHit: vi.fn(),
    sendMove: vi.fn(),
    sendDragPosition: vi.fn(),
    requestScaleTick: vi.fn(),
    reportStageLayout: vi.fn(),
    onTerritoryBounds: vi.fn(
      (_listener: (bounds: TerritoryBounds) => void) => () => {},
    ),
    onScaleState: vi.fn(
      (_listener: (state: { tick: number; accepted: boolean }) => void) =>
        () => {},
    ),
    onResetPosition: vi.fn((_listener: () => void) => () => {}),
  };
}

function ready(video: HTMLVideoElement): void {
  video.dispatchEvent(new Event("loadeddata"));
}

function mockStageRect(
  stage: HTMLElement,
  rect = { x: 12, y: 34, width: 200, height: 112.5 },
): void {
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
    ...rect,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => ({}),
  } as DOMRect);
}

function mockHitRect(
  hit: HTMLElement,
  rect = { x: 0, y: 0, width: 100, height: 100 },
): void {
  vi.spyOn(hit, "getBoundingClientRect").mockReturnValue({
    ...rect,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => ({}),
  } as DOMRect);
}

function mockDynamicStageRect(stage: HTMLElement, root: HTMLElement): void {
  vi.spyOn(stage, "getBoundingClientRect").mockImplementation(() => {
    const rootTransform = root.style.transform.match(
      /^translate\((-?[\d.]+)px, (-?[\d.]+)px\)$/,
    );
    const stageTransform = stage.style.transform.match(
      /^translateY\((-?[\d.]+)px\)$/,
    );
    const x = Number(rootTransform?.[1] ?? 0);
    const rootY = Number(rootTransform?.[2] ?? 0);
    const y = rootY + Number(stageTransform?.[1] ?? 0);
    const width = Number.parseFloat(root.style.width) || 0;
    const height = Number.parseFloat(root.style.height) || 0;
    return {
      x,
      y,
      width,
      height,
      left: x,
      top: y,
      right: x + width,
      bottom: y + height,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

const fixedRng = (value: number) => () => value;

function setScaleQuery(tick: number): void {
  window.history.replaceState(
    {},
    "",
    `?petScaleTick=${tick}&petScaleMinTick=0&petScaleMaxTick=7&petScaleDefaultTick=2&petScaleMinFactor=0.4&petScaleStepFactor=0.05`,
  );
}

beforeEach(() => {
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 768,
  });
});

describe("pickNextKind (chain distribution thresholds)", () => {
  it("maps roll < 0.3 → IDLE, < 0.4 → TURN, < 0.8 → ACTS, else MOVE", () => {
    expect(pickNextKind(0.0)).toBe("IDLE");
    expect(pickNextKind(0.29)).toBe("IDLE");
    expect(pickNextKind(0.3)).toBe("TURN");
    expect(pickNextKind(0.39)).toBe("TURN");
    expect(pickNextKind(0.4)).toBe("ACTS");
    expect(pickNextKind(0.79)).toBe("ACTS");
    expect(pickNextKind(0.8)).toBe("MOVE");
    expect(pickNextKind(0.99)).toBe("MOVE");
  });
});

describe("pick + randomBetween", () => {
  it("picks the element at rng()*len with an exclude filter", () => {
    const rng = vi.fn().mockReturnValue(0.5);
    expect(pick(["a", "b"], null, rng)).toBe("b"); // floor(0.5*2)=1
    expect(pick(["a", "b", "c"], "b", rng)).toBe("c"); // filtered ['a','c'], floor(0.5*2)=1 → 'c'
  });
  it("randomBetween returns [min,max) via floor(min + rng*(max-min))", () => {
    expect(randomBetween(60, 240, () => 0.0)).toBe(60);
    expect(randomBetween(60, 240, () => 0.999)).toBe(239);
  });

  it("ACTS holds exactly 42 unique act names", () => {
    expect(ACTS.length).toBe(42);
    expect(new Set(ACTS).size).toBe(42);
    // Every act must have a matching webm on disk (the catalog is
    // hardcoded upstream client.js:108-152; drift breaks playback).
    for (const name of ACTS) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});

describe("planMove (bounds check + ratio plan)", () => {
  it("rejects a target left of the safe margin", () => {
    expect(
      planMove({
        cx: 256,
        cy: 200,
        W: 1024,
        H: 768,
        halfW: 256,
        facing: "left",
        turning: false,
        distance: 100,
      }),
    ).toBeNull();
  });
  it("accepts an in-bounds target and plans the ratios", () => {
    const plan = planMove({
      cx: 256,
      cy: 200,
      W: 1024,
      H: 768,
      halfW: 256,
      facing: "right",
      turning: false,
      distance: 100,
    });
    expect(plan?.dir).toBe(1);
    expect(plan?.startRatio).toBe(256 / 1024);
    expect(plan?.targetRatio).toBe(356 / 1024);
  });
  it("inverts the direction when a TURN just ended (facing is about to flip)", () => {
    const plan = planMove({
      cx: 600,
      cy: 200,
      W: 1024,
      H: 768,
      halfW: 256,
      facing: "left",
      turning: true,
      distance: 100,
    });
    // facing left + turning → actual facing right → dir +1
    expect(plan?.dir).toBe(1);
  });
});

describe("initPet state machine", () => {
  it("starts idle, one-shot, facing left", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const pet = initPet({
      ...dom,
      bridge,
      rng: () => 0.5,
      raf: () => 0,
      caf: () => {},
    });
    expect(pet.getState()).toMatchObject({
      anim: IDLE,
      once: true,
      facing: "left",
    });
  });

  it("advances the chain on ended (IDLE → TURN at roll 0.35)", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const pet = initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.35),
      raf: () => 0,
      caf: () => {},
    });
    ready(dom.videoB);
    dom.videoB.dispatchEvent(new Event("ended"));
    expect(pet.getState().anim).toBe(TURN);
  });

  it("flips facing after TURN ends", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const rng = vi.fn().mockReturnValueOnce(0.35).mockReturnValueOnce(0.0);
    const pet = initPet({ ...dom, bridge, rng, raf: () => 0, caf: () => {} });
    ready(dom.videoB);
    dom.videoB.dispatchEvent(new Event("ended")); // → TURN
    ready(dom.videoA);
    dom.videoA.dispatchEvent(new Event("ended")); // TURN ends → flip + next
    expect(pet.getState().facing).toBe("right");
    expect(pet.getState().anim).toBe(IDLE);
  });

  it("returns to idle (buffer) after a click animation ends", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const pet = initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    ready(dom.videoB);
    dom.hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(CLICKS).toContain(pet.getState().anim);
    ready(dom.videoA);
    dom.videoA.dispatchEvent(new Event("ended")); // click ends → IDLE buffer
    expect(pet.getState().anim).toBe(IDLE);
    expect(pet.getState().once).toBe(true);
  });

  it("restores the local stage before reporting a drag delta", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockStageRect(dom.stage);
    let stageTransformAtSend = "";
    bridge.sendMove.mockImplementation(() => {
      stageTransformAtSend = dom.stage.style.transform;
    });
    const pet = initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 100,
        clientY: 100,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 140,
        clientY: 100,
        bubbles: true,
      }),
    );
    expect(dom.stage.style.transform).toBe("none");
    dom.hit.dispatchEvent(
      new MouseEvent("pointerup", {
        clientX: 140,
        clientY: 100,
        screenX: 1140,
        screenY: 110,
        bubbles: true,
      }),
    );
    expect(pet.getState()).toMatchObject({ anim: IDLE, once: true });
    expect(stageTransformAtSend).toMatch(/^translateY\(.+px\)$/);
    expect(bridge.sendMove).toHaveBeenCalledWith(
      expect.objectContaining({
        dx: 40,
        dy: 0,
        screenX: 1140,
        screenY: 110,
        stage: { x: 12, y: 34, width: 200, height: 112.5 },
      }),
    );
  });

  it("subscribes before the first layout report and keeps preview inside returned territory", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let listener:
      | ((bounds: {
          minStageX: number;
          maxStageX: number;
          minStageY: number;
          maxStageY: number;
        }) => void)
      | undefined;
    bridge.onTerritoryBounds.mockImplementation((next) => {
      listener = next;
      return () => {};
    });
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    expect(bridge.onTerritoryBounds.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.reportStageLayout.mock.invocationCallOrder[0],
    );
    listener?.({
      minStageX: 100,
      maxStageX: 110,
      minStageY: 24,
      maxStageY: 24,
    });
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 100,
        clientY: 100,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 600,
        clientY: 500,
        bubbles: true,
      }),
    );
    expect(dom.root.style.transform).toBe("translate(110px, 0px)");
  });

  it("pins preview and automatic positioning to the cell edge for disjoint stale territory", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let listener: ((bounds: TerritoryBounds) => void) | undefined;
    bridge.onTerritoryBounds.mockImplementation((next) => {
      listener = next;
      return () => {};
    });
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    listener?.({
      minStageX: 600,
      maxStageX: 700,
      minStageY: 24,
      maxStageY: 504,
    });
    expect(dom.root.style.transform).toBe("translate(512px, 480px)");
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 100,
        clientY: 100,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 800,
        clientY: 500,
        bubbles: true,
      }),
    );
    expect(dom.root.style.transform).toMatch(/^translate\(512px, \d+px\)$/);
  });

  it("rejects an automatic walking target outside returned territory bounds", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    vi.spyOn(dom.root, "getBoundingClientRect").mockReturnValue({
      x: 400,
      y: 0,
      width: 512,
      height: 288,
      left: 400,
      top: 0,
      right: 912,
      bottom: 288,
      toJSON: () => ({}),
    } as DOMRect);
    let listener: ((bounds: TerritoryBounds) => void) | undefined;
    bridge.onTerritoryBounds.mockImplementation((next) => {
      listener = next;
      return () => {};
    });
    const pet = initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.9),
      raf: () => 0,
      caf: () => {},
    });
    listener?.({ minStageX: 0, maxStageX: 100, minStageY: 0, maxStageY: 100 });
    ready(dom.videoB);
    dom.videoB.dispatchEvent(new Event("ended"));
    expect(ACTS).toContain(pet.getState().anim);
    expect(MOVES).not.toContain(pet.getState().anim);
  });

  it("reports the restored native hit state on pointerup", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockHitRect(dom.hit);
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 10,
        clientY: 10,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 30,
        clientY: 10,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointerup", { clientX: 25, clientY: 25, bubbles: true }),
    );
    expect(bridge.sendHit).toHaveBeenLastCalledWith(true);
  });

  it("cancels a drag without sending a move and restores click-through", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockHitRect(dom.hit);
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    document.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 10, clientY: 10, bubbles: true }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 10,
        clientY: 10,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 30,
        clientY: 10,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(new MouseEvent("pointercancel", { bubbles: true }));
    expect(bridge.sendMove).not.toHaveBeenCalled();
    expect(bridge.sendHit).toHaveBeenLastCalledWith(false);
  });

  it("reports recomputed stage geometry on resize and ignores ended events from an outgoing buffer", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const rect = vi.spyOn(dom.stage, "getBoundingClientRect");
    rect.mockReturnValue({
      x: 12,
      y: 34,
      width: 200,
      height: 112.5,
      left: 12,
      top: 34,
      right: 212,
      bottom: 146.5,
      toJSON: () => ({}),
    } as DOMRect);
    const pet = initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.35),
      raf: () => 0,
      caf: () => {},
    });
    ready(dom.videoB);
    dom.hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    ready(dom.videoA);
    dom.videoB.dispatchEvent(new Event("ended"));
    expect(CLICKS).toContain(pet.getState().anim);
    rect.mockReturnValue({
      x: 20,
      y: 40,
      width: 400,
      height: 225,
      left: 20,
      top: 40,
      right: 420,
      bottom: 265,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800,
    });
    window.dispatchEvent(new Event("resize"));
    expect(dom.root.style.width).toBe("400px");
    expect(bridge.reportStageLayout).toHaveBeenLastCalledWith({
      stage: { x: 20, y: 40, width: 400, height: 225 },
    });
    dom.videoA.dispatchEvent(new Event("ended"));
    expect(pet.getState().anim).toBe(IDLE);
  });

  it("uses all supplied query scale values and falls back when one is invalid", () => {
    window.history.replaceState(
      {},
      "",
      "?petScaleTick=4&petScaleMinTick=1&petScaleMaxTick=5&petScaleDefaultTick=3&petScaleMinFactor=0.3&petScaleStepFactor=0.1",
    );
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800,
    });
    const custom = buildDom();
    initPet({
      ...custom,
      bridge: makeBridge(),
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    expect(custom.root.style.width).toBe("560px");

    window.history.replaceState(
      {},
      "",
      "?petScaleTick=4&petScaleMinTick=bad&petScaleMaxTick=5&petScaleDefaultTick=3&petScaleMinFactor=0.3&petScaleStepFactor=0.1",
    );
    const fallback = buildDom();
    initPet({
      ...fallback,
      bridge: makeBridge(),
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    expect(fallback.root.style.width).toBe("400px");
  });

  it("normalizes wheel thresholds, coalesces requests, and applies approved up-increase direction", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let scaleListener:
      | ((state: { tick: number; accepted: boolean }) => void)
      | undefined;
    bridge.onScaleState.mockImplementation((listener) => {
      scaleListener = listener;
      return () => {};
    });
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    const first = new WheelEvent("wheel", {
      deltaY: -50,
      deltaMode: 0,
      cancelable: true,
    });
    dom.hit.dispatchEvent(first);
    expect(bridge.requestScaleTick).not.toHaveBeenCalled();
    expect(first.defaultPrevented).toBe(true);
    const second = new WheelEvent("wheel", {
      deltaY: -50,
      deltaMode: 0,
      cancelable: true,
    });
    dom.hit.dispatchEvent(second);
    expect(bridge.requestScaleTick).toHaveBeenCalledWith({ tick: 3 });
    const third = new WheelEvent("wheel", {
      deltaY: -100,
      deltaMode: 0,
      cancelable: true,
    });
    dom.hit.dispatchEvent(third);
    expect(bridge.requestScaleTick).toHaveBeenCalledTimes(1);
    scaleListener?.({ tick: 3, accepted: true });
    expect(bridge.requestScaleTick).toHaveBeenCalledWith({ tick: 4 });
  });

  it("decreases scale for a positive DOM wheel delta", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    dom.hit.dispatchEvent(
      new WheelEvent("wheel", { deltaY: 100, deltaMode: 0, cancelable: true }),
    );
    expect(bridge.requestScaleTick).toHaveBeenCalledWith({ tick: 1 });
  });

  it("normalizes line and page wheel deltas into signed CSS-pixel thresholds", () => {
    const lineDom = buildDom();
    const lineBridge = makeBridge();
    initPet({
      ...lineDom,
      bridge: lineBridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    const lineSubthreshold = new WheelEvent("wheel", {
      deltaY: -6,
      deltaMode: 1,
      cancelable: true,
    });
    lineDom.hit.dispatchEvent(lineSubthreshold); // -6 × 16 = -96 CSS px
    expect(lineBridge.requestScaleTick).not.toHaveBeenCalled();
    const lineThreshold = new WheelEvent("wheel", {
      deltaY: -1,
      deltaMode: 1,
      cancelable: true,
    });
    lineDom.hit.dispatchEvent(lineThreshold); // remainder reaches -112 CSS px
    expect(lineBridge.requestScaleTick).toHaveBeenCalledWith({ tick: 3 });

    const pageDom = buildDom();
    const pageBridge = makeBridge();
    initPet({
      ...pageDom,
      bridge: pageBridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    const page = new WheelEvent("wheel", {
      deltaY: -0.14,
      deltaMode: 2,
      cancelable: true,
    });
    pageDom.hit.dispatchEvent(page); // -0.14 × 768 = -107.52 CSS px
    expect(pageBridge.requestScaleTick).toHaveBeenCalledWith({ tick: 3 });
    expect(page.defaultPrevented).toBe(true);
  });

  it("bounds scale requests and prevents default at both scale limits", () => {
    setScaleQuery(7);
    const maxDom = buildDom();
    const maxBridge = makeBridge();
    initPet({
      ...maxDom,
      bridge: maxBridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    const maxWheel = new WheelEvent("wheel", {
      deltaY: -100,
      deltaMode: 0,
      cancelable: true,
    });
    maxDom.hit.dispatchEvent(maxWheel);
    expect(maxWheel.defaultPrevented).toBe(true);
    expect(maxBridge.requestScaleTick).not.toHaveBeenCalled();

    setScaleQuery(0);
    const minDom = buildDom();
    const minBridge = makeBridge();
    initPet({
      ...minDom,
      bridge: minBridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    const minWheel = new WheelEvent("wheel", {
      deltaY: 100,
      deltaMode: 0,
      cancelable: true,
    });
    minDom.hit.dispatchEvent(minWheel);
    expect(minWheel.defaultPrevented).toBe(true);
    expect(minBridge.requestScaleTick).not.toHaveBeenCalled();
  });

  it("adopts a rejected returned tick and clears queued wheel intent", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let scaleListener:
      | ((state: { tick: number; accepted: boolean }) => void)
      | undefined;
    bridge.onScaleState.mockImplementation((listener) => {
      scaleListener = listener;
      return () => {};
    });
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    const initialReports = bridge.reportStageLayout.mock.calls.length;
    dom.hit.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, cancelable: true }),
    );
    expect(bridge.requestScaleTick).toHaveBeenCalledWith({ tick: 3 });

    scaleListener?.({ tick: 1, accepted: false });

    expect(dom.root.style.width).toBe("460px");
    expect(bridge.reportStageLayout).toHaveBeenCalledTimes(initialReports + 1);
    dom.hit.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, deltaMode: 0, cancelable: true }),
    );
    expect(bridge.requestScaleTick).toHaveBeenLastCalledWith({ tick: 2 });
  });

  it("ignores wheel input while a drag is active", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const pet = initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 100,
        clientY: 100,
        bubbles: true,
      }),
    );
    const wheel = new WheelEvent("wheel", {
      deltaY: -100,
      deltaMode: 0,
      cancelable: true,
    });
    dom.hit.dispatchEvent(wheel);
    expect(bridge.requestScaleTick).not.toHaveBeenCalled();
    expect(wheel.defaultPrevented).toBe(false);
    dom.hit.dispatchEvent(new MouseEvent("pointercancel", { bubbles: true }));
    pet.destroy();
  });

  it("preserves the stage bottom-center anchor across an accepted scale state", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800,
    });
    const dom = buildDom();
    const bridge = makeBridge();
    let scaleListener:
      | ((state: { tick: number; accepted: boolean }) => void)
      | undefined;
    bridge.onScaleState.mockImplementation((listener) => {
      scaleListener = listener;
      return () => {};
    });
    mockDynamicStageRect(dom.stage, dom.root);
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    const before = bridge.reportStageLayout.mock.calls[0][0].stage as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    scaleListener?.({ tick: 3, accepted: true });
    const after = bridge.reportStageLayout.mock.calls.at(-1)?.[0].stage as {
      x: number;
      y: number;
      width: number;
      height: number;
    };

    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2);
    expect(after.y + after.height).toBeCloseTo(before.y + before.height);
    expect(dom.root.style.width).toBe("440px");
  });

  it("reports reset layout once and removes every renderer listener on destroy", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let resetListener: (() => void) | undefined;
    const removeTerritory = vi.fn();
    const removeScale = vi.fn();
    const removeReset = vi.fn();
    bridge.onTerritoryBounds.mockImplementation(() => removeTerritory);
    bridge.onScaleState.mockImplementation(() => removeScale);
    bridge.onResetPosition.mockImplementation((listener) => {
      resetListener = listener;
      return removeReset;
    });
    const pet = initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 0,
      caf: () => {},
    });
    resetListener?.();
    expect(bridge.reportStageLayout).toHaveBeenLastCalledWith({
      stage: expect.any(Object),
      resetPosition: true,
    });
    pet.destroy();
    expect(removeTerritory).toHaveBeenCalledTimes(1);
    expect(removeScale).toHaveBeenCalledTimes(1);
    expect(removeReset).toHaveBeenCalledTimes(1);
  });
});

describe("initPet held drag reporting", () => {
  it("measures the anchor after removing the foot pad and coalesces the latest frame", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const frames: FrameRequestCallback[] = [];
    const transforms: string[] = [];
    vi.spyOn(dom.stage, "getBoundingClientRect").mockImplementation(() => {
      transforms.push(dom.stage.style.transform);
      const y = dom.stage.style.transform === "none" ? 34 : 80;
      return {
        x: 12,
        y,
        width: 200,
        height: 112.5,
        left: 12,
        top: y,
        right: 212,
        bottom: y + 112.5,
        toJSON: () => ({}),
      } as DOMRect;
    });
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: (cb) => (frames.push(cb), frames.length),
      caf: () => {},
    });
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 20,
        clientY: 40,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 40,
        clientY: 40,
        screenX: 120,
        screenY: 220,
        bubbles: true,
      }),
    );
    expect(transforms.at(-1)).toBe("none");
    expect(frames).toHaveLength(1);
    frames[0](0);
    expect(bridge.sendDragPosition).toHaveBeenCalledWith({
      phase: "move",
      screenX: 120,
      screenY: 220,
      anchorX: 18,
      anchorY: 6,
      stage: { x: 12, y: 34, width: 200, height: 112.5 },
    });
  });

  it("flushes the exact pointer-up position before held release", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockStageRect(dom.stage);
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 1,
      caf: () => {},
    });
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 20,
        clientY: 40,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointerup", {
        clientX: 35,
        clientY: 40,
        screenX: 130,
        screenY: 230,
        bubbles: true,
      }),
    );
    expect(bridge.sendDragPosition).toHaveBeenLastCalledWith({
      phase: "move",
      screenX: 130,
      screenY: 230,
      anchorX: 18,
      anchorY: 6,
      stage: { x: 12, y: 34, width: 200, height: 112.5 },
    });
    expect(bridge.sendDragPosition.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.sendMove.mock.invocationCallOrder[0],
    );
    expect(bridge.sendMove).toHaveBeenLastCalledWith(
      expect.objectContaining({ heldDrag: true, screenX: 130, screenY: 230 }),
    );
  });

  it("defers territory bounds until held release", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockStageRect(dom.stage);
    let listener: ((bounds: TerritoryBounds) => void) | undefined;
    bridge.onTerritoryBounds.mockImplementation((next) => {
      listener = next;
      return () => {};
    });
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 1,
      caf: () => {},
    });
    const initial = dom.root.style.transform;
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 20,
        clientY: 40,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
        bubbles: true,
      }),
    );
    listener?.({
      minStageX: 100,
      maxStageX: 110,
      minStageY: 24,
      maxStageY: 24,
    });
    listener?.({
      minStageX: 300,
      maxStageX: 310,
      minStageY: 24,
      maxStageY: 24,
    });
    expect(dom.root.style.transform).toBe(initial);
    dom.hit.dispatchEvent(
      new MouseEvent("pointerup", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
        bubbles: true,
      }),
    );
    expect(dom.root.style.transform).toBe("translate(310px, 0px)");
  });

  it("defers scale state until held release", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockStageRect(dom.stage);
    let listener:
      | ((state: { tick: number; accepted: boolean }) => void)
      | undefined;
    bridge.onScaleState.mockImplementation((next) => {
      listener = next;
      return () => {};
    });
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 1,
      caf: () => {},
    });
    const initialWidth = dom.root.style.width;
    const layouts = bridge.reportStageLayout.mock.calls.length;
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 20,
        clientY: 40,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
        bubbles: true,
      }),
    );
    listener?.({ tick: 3, accepted: true });
    listener?.({ tick: 4, accepted: true });
    expect(dom.root.style.width).toBe(initialWidth);
    expect(bridge.reportStageLayout.mock.calls).toHaveLength(layouts);
    dom.hit.dispatchEvent(
      new MouseEvent("pointerup", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
        bubbles: true,
      }),
    );
    expect(dom.root.style.width).toBe("614px");
  });

  it("defers tray reset until held release reports its completion", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockStageRect(dom.stage);
    let listener: (() => void) | undefined;
    bridge.onResetPosition.mockImplementation((next) => {
      listener = next;
      return () => {};
    });
    initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: () => 1,
      caf: () => {},
    });
    const layouts = bridge.reportStageLayout.mock.calls.length;
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 20,
        clientY: 40,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
        bubbles: true,
      }),
    );
    listener?.();
    expect(bridge.reportStageLayout.mock.calls).toHaveLength(layouts);
    dom.hit.dispatchEvent(
      new MouseEvent("pointerup", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
        bubbles: true,
      }),
    );
    expect(bridge.reportStageLayout).toHaveBeenLastCalledWith({
      stage: expect.any(Object),
      resetPosition: true,
    });
    expect(bridge.sendMove.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.reportStageLayout.mock.invocationCallOrder.at(-1)!,
    );
  });

  it("defers synchronous inbound updates until terminal IPC returns", () => {
    for (const terminal of ["release", "cancel"] as const) {
      const dom = buildDom();
      const bridge = makeBridge();
      mockStageRect(dom.stage);
      let territoryListener: ((bounds: TerritoryBounds) => void) | undefined;
      let scaleListener:
        | ((state: { tick: number; accepted: boolean }) => void)
        | undefined;
      let resetListener: (() => void) | undefined;
      bridge.onTerritoryBounds.mockImplementation((listener) => {
        territoryListener = listener;
        return () => {};
      });
      bridge.onScaleState.mockImplementation((listener) => {
        scaleListener = listener;
        return () => {};
      });
      bridge.onResetPosition.mockImplementation((listener) => {
        resetListener = listener;
        return () => {};
      });
      initPet({
        ...dom,
        bridge,
        rng: fixedRng(0.5),
        raf: () => 1,
        caf: () => {},
      });
      const layouts = bridge.reportStageLayout.mock.calls.length;
      const width = dom.root.style.width;
      const transform = dom.root.style.transform;
      const sendInbound = (): void => {
        territoryListener?.({
          minStageX: 100,
          maxStageX: 110,
          minStageY: 24,
          maxStageY: 24,
        });
        scaleListener?.({ tick: 4, accepted: true });
        resetListener?.();
        expect(dom.root.style.width).toBe(width);
        expect(dom.root.style.transform).toBe(transform);
        expect(bridge.reportStageLayout).toHaveBeenCalledTimes(layouts);
      };
      if (terminal === "release")
        bridge.sendMove.mockImplementation(sendInbound);
      else
        bridge.sendDragPosition.mockImplementation((position) => {
          if (position.phase === "cancel") sendInbound();
        });
      dom.hit.dispatchEvent(
        new MouseEvent("pointerdown", {
          clientX: 20,
          clientY: 40,
          bubbles: true,
        }),
      );
      dom.hit.dispatchEvent(
        new MouseEvent("pointermove", {
          clientX: 30,
          clientY: 40,
          screenX: 100,
          screenY: 200,
          bubbles: true,
        }),
      );
      if (terminal === "release") {
        dom.hit.dispatchEvent(
          new MouseEvent("pointerup", {
            clientX: 30,
            clientY: 40,
            screenX: 100,
            screenY: 200,
            bubbles: true,
          }),
        );
      } else {
        dom.hit.dispatchEvent(
          new MouseEvent("pointercancel", { bubbles: true }),
        );
      }
      const deferredReports =
        bridge.reportStageLayout.mock.calls.slice(layouts);
      expect(dom.root.style.width).toBe("614px");
      expect(dom.root.style.transform).toBe("translate(110px, 0px)");
      expect(deferredReports).toHaveLength(2);
      expect(
        deferredReports.filter(([payload]) => payload.resetPosition === true),
      ).toHaveLength(1);
      expect(
        deferredReports.filter(([payload]) => payload.resetPosition !== true),
      ).toHaveLength(1);
    }
  });

  it("cancels queued work, sends restored-stage cancel, and defers resize reporting", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const caf = vi.fn();
    mockStageRect(dom.stage);
    initPet({ ...dom, bridge, rng: fixedRng(0.5), raf: () => 7, caf });
    const layouts = bridge.reportStageLayout.mock.calls.length;
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 20,
        clientY: 40,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
        bubbles: true,
      }),
    );
    window.dispatchEvent(new Event("resize"));
    expect(bridge.reportStageLayout.mock.calls).toHaveLength(layouts);
    dom.hit.dispatchEvent(new MouseEvent("pointercancel", { bubbles: true }));
    expect(caf).toHaveBeenCalledWith(7);
    expect(bridge.sendDragPosition).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "cancel",
        stage: { x: 12, y: 34, width: 200, height: 112.5 },
      }),
    );
    expect(bridge.sendMove).not.toHaveBeenCalled();
    expect(bridge.reportStageLayout.mock.calls.length).toBe(layouts + 1);
  });

  it.each(["pointerup", "pointercancel"] as const)(
    "reports one deferred resize after %s",
    (terminal) => {
      const dom = buildDom();
      const bridge = makeBridge();
      mockStageRect(dom.stage);
      initPet({
        ...dom,
        bridge,
        rng: fixedRng(0.5),
        raf: () => 1,
        caf: () => {},
      });
      const layouts = bridge.reportStageLayout.mock.calls.length;
      dom.hit.dispatchEvent(
        new MouseEvent("pointerdown", {
          clientX: 20,
          clientY: 40,
          bubbles: true,
        }),
      );
      dom.hit.dispatchEvent(
        new MouseEvent("pointermove", {
          clientX: 30,
          clientY: 40,
          screenX: 100,
          screenY: 200,
          bubbles: true,
        }),
      );
      window.dispatchEvent(new Event("resize"));
      expect(bridge.reportStageLayout).toHaveBeenCalledTimes(layouts);
      dom.hit.dispatchEvent(
        terminal === "pointerup"
          ? new MouseEvent("pointerup", {
              clientX: 30,
              clientY: 40,
              screenX: 100,
              screenY: 200,
              bubbles: true,
            })
          : new MouseEvent("pointercancel", { bubbles: true }),
      );
      expect(bridge.reportStageLayout).toHaveBeenCalledTimes(layouts + 1);
    },
  );

  it("does not preview through the clamped root and cancels queued drag IPC on destroy", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const frames: FrameRequestCallback[] = [];
    const caf = vi.fn();
    mockStageRect(dom.stage);
    const pet = initPet({
      ...dom,
      bridge,
      rng: fixedRng(0.5),
      raf: (cb) => (frames.push(cb), 9),
      caf,
    });
    const rootTransform = dom.root.style.transform;
    dom.hit.dispatchEvent(
      new MouseEvent("pointerdown", {
        clientX: 20,
        clientY: 40,
        bubbles: true,
      }),
    );
    dom.hit.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
        bubbles: true,
      }),
    );
    expect(dom.root.style.transform).toBe(rootTransform);
    pet.destroy();
    expect(caf).toHaveBeenCalledWith(9);
    frames[0](0);
    expect(bridge.sendDragPosition).not.toHaveBeenCalled();
  });
});
