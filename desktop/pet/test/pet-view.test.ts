import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PetConfig } from "../src/pet-bridge.js";
import {
  ACTS,
  CLICKS,
  DRAG,
  STATIC,
  initPet,
  pick,
  pickNext,
  pickWeightedCategory,
} from "../src/pet-view.js";

function buildDom() {
  const root = document.createElement("div");
  root.id = "pet-root";
  const stage = document.createElement("div");
  stage.id = "pet-stage";
  const staticImg = document.createElement("img");
  staticImg.id = "pet-static";
  const videoA = document.createElement("video");
  videoA.id = "pet-video-a";
  videoA.className = "is-front";
  const videoB = document.createElement("video");
  videoB.id = "pet-video-b";
  const hit = document.createElement("div");
  hit.id = "pet-hit";
  stage.append(staticImg, videoA, videoB, hit);
  root.append(stage);
  document.body.replaceChildren(root);
  return { root, stage, staticImg, videoA, videoB, hit };
}

function makeBridge() {
  return {
    sendDragPosition: vi.fn(),
    requestZoomPercent: vi.fn(),
    reportStageLayout: vi.fn(),
    setMousePassthrough: vi.fn(),
    reportHitTestResult: vi.fn(),
    onHitTestRequest: vi.fn(
      (_listener: (request: unknown) => void) => () => {},
    ),
    onZoomState: vi.fn(
      (_listener: (state: { percent: number; accepted: boolean }) => void) =>
        () => {},
    ),
    onIdleDwellState: vi.fn(
      (_listener: (state: { dwellSeconds: number }) => void) => () => {},
    ),
  };
}

function initTestPet(options: Parameters<typeof initPet>[0]) {
  // The injected sampler still needs a decoded static layer for mapping tests;
  // production eligibility is covered separately with real intrinsic media data.
  defineImageDimensions(options.staticImg, 192, 108);
  return initPet({ alphaSampler: () => true, ...options });
}

function mockStageRect(stage: HTMLElement): void {
  vi.spyOn(stage, "getBoundingClientRect").mockImplementation(() => {
    const width = Number.parseFloat(stage.style.width) || 0;
    const height = Number.parseFloat(stage.style.height) || 0;
    return {
      x: 0,
      y: 0,
      width,
      height,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

function defineImageDimensions(
  image: HTMLImageElement,
  width: number,
  height: number,
): void {
  Object.defineProperty(image, "naturalWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(image, "naturalHeight", {
    configurable: true,
    value: height,
  });
}

function defineVideoDimensions(
  video: HTMLVideoElement,
  width: number,
  height: number,
): void {
  Object.defineProperty(video, "videoWidth", {
    configurable: true,
    value: width,
  });
  Object.defineProperty(video, "videoHeight", {
    configurable: true,
    value: height,
  });
  Object.defineProperty(video, "readyState", {
    configurable: true,
    value: HTMLMediaElement.HAVE_CURRENT_DATA,
  });
}

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setZoomQuery(percent: number): void {
  window.history.replaceState(
    {},
    "",
    `?petZoomPercent=${percent}&petZoomMinPercent=50&petZoomMaxPercent=300&petZoomDefaultPercent=100&petZoomStepPercent=25&petBaseVisualWidth=192`,
  );
}

function pointer(
  type: string,
  values: Partial<MouseEventInit> = {},
): MouseEvent {
  return new MouseEvent(type, { bubbles: true, ...values });
}

beforeEach(() => {
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("pet media catalog", () => {
  it("ships every hard-coded animation and static asset", () => {
    const thumb = path.resolve(import.meta.dirname, "../assets/thumb");
    for (const name of [...ACTS(), ...CLICKS(), DRAG]) {
      expect(existsSync(path.join(thumb, `${name}.webm`))).toBe(true);
    }
    expect(existsSync(path.join(thumb, "maid-static.png"))).toBe(true);
    expect(STATIC).toBe("STATIC");
  });
});

describe("stationary animation chain", () => {
  it("retains the act catalog and excludes the current animation when requested", () => {
    expect(ACTS()).toHaveLength(81);
    expect(new Set(ACTS()).size).toBe(81);
    const rng = vi.fn().mockReturnValue(0.5);
    expect(pick(["a", "b"], null, rng)).toBe("b");
    expect(pick(["a", "b", "c"], "b", rng)).toBe("c");
  });

  it("does not rearm the current static timer and uses updated dwell only for the next static", () => {
    vi.useFakeTimers();
    window.history.replaceState({}, "", "?petIdleDwellSeconds=10");
    const dom = buildDom();
    mockStageRect(dom.stage);
    const bridge = makeBridge();
    let dwellListener: ((state: { dwellSeconds: number }) => void) | undefined;
    bridge.onIdleDwellState.mockImplementation((listener) => {
      dwellListener = listener;
      return () => {};
    });
    const pet = initTestPet({
      ...dom,
      bridge,
      rng: () => 0,
      raf: () => 0,
      caf: () => {},
    });
    expect(pet.getState().anim).toBe(STATIC);
    expect(dom.staticImg.classList.contains("is-front")).toBe(true);
    dwellListener?.({ dwellSeconds: 60 });
    vi.advanceTimersByTime(9_999);
    expect(pet.getState().anim).toBe(STATIC);
    vi.advanceTimersByTime(1);
    expect(pet.getState().once).toBe(true);
    expect(ACTS()).toContain(pet.getState().anim);
    // First act goes to videoB (initial front=0, el=videoB).
    dom.videoB.dispatchEvent(new Event("loadeddata"));
    dom.videoB.dispatchEvent(new Event("ended"));
    expect(pet.getState().anim).toBe(STATIC);
    expect(dom.staticImg.classList.contains("is-front")).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(pet.getState().anim).toBe(STATIC);
    vi.advanceTimersByTime(1);
    expect(ACTS()).toContain(pet.getState().anim);
    expect(ACTS()).toContain(pet.getState().anim);
    // Second act goes to videoA (front=1 after first onReady).
    dom.videoA.dispatchEvent(new Event("loadeddata"));
    dom.videoA.dispatchEvent(new Event("ended"));
    pet.destroy();
  });

  it("returns to STATIC when an act video load fails", () => {
    vi.useFakeTimers();
    const dom = buildDom();
    mockStageRect(dom.stage);
    const pet = initTestPet({
      ...dom,
      bridge: makeBridge(),
      rng: () => 0,
      raf: () => 0,
      caf: () => {},
    });
    vi.advanceTimersByTime(10);
    dom.videoB.dispatchEvent(new Event("error"));
    expect(pet.getState().anim).toBe(STATIC);
    expect(dom.staticImg.classList.contains("is-front")).toBe(true);
    pet.destroy();
  });

  it("returns to STATIC when an act video play is rejected", async () => {
    vi.useFakeTimers();
    const dom = buildDom();
    mockStageRect(dom.stage);
    const bridge = makeBridge();
    vi.spyOn(dom.videoB, "play").mockRejectedValueOnce(new Error("blocked"));
    const pet = initTestPet({
      ...dom,
      bridge,
      rng: () => 0,
      raf: () => 0,
      caf: () => {},
    });
    vi.advanceTimersByTime(10);
    dom.videoB.dispatchEvent(new Event("loadeddata"));
    await Promise.resolve();
    await Promise.resolve();
    expect(pet.getState().anim).toBe(STATIC);
    expect(dom.staticImg.classList.contains("is-front")).toBe(true);
    pet.destroy();
  });

  it("ignores stale static callbacks after a generation replacement", () => {
    vi.useFakeTimers();
    const dom = buildDom();
    mockStageRect(dom.stage);
    const pet = initTestPet({
      ...dom,
      bridge: makeBridge(),
      rng: () => 0,
      raf: () => 0,
      caf: () => {},
    });
    dom.hit.dispatchEvent(pointer("click"));
    const replaced = pet.getState().anim;
    dom.videoB.dispatchEvent(new Event("loadeddata"));
    dom.videoB.dispatchEvent(new Event("error"));
    expect(pet.getState().anim).toBe(replaced);
    dom.videoA.dispatchEvent(new Event("loadeddata"));
    expect(pet.getState().anim).toBe(replaced);
    expect(dom.videoA.play).toHaveBeenCalledTimes(1);
    pet.destroy();
  });

  it("starts in STATIC with the image visible", () => {
    const dom = buildDom();
    mockStageRect(dom.stage);
    const pet = initTestPet({ ...dom, bridge: makeBridge(), rng: () => 0.5 });
    expect(pet.getState().anim).toBe(STATIC);
    expect(pet.getState().once).toBe(false);
    expect(dom.staticImg.classList.contains("is-front")).toBe(true);
    expect(dom.videoA.classList.contains("is-front")).toBe(false);
    expect(dom.videoB.classList.contains("is-front")).toBe(false);
    expect(dom.videoA.play).not.toHaveBeenCalled();
    expect(dom.videoB.play).not.toHaveBeenCalled();
    pet.destroy();
  });

  it("sets the static image src to ../assets/thumb/maid-static.png", () => {
    const dom = buildDom();
    mockStageRect(dom.stage);
    initTestPet({ ...dom, bridge: makeBridge(), rng: () => 0.5 });
    expect(dom.staticImg.src).toMatch(/maid-static\.png$/);
  });

  it("transitions STATIC to ACTS to STATIC on the dwell cycle", () => {
    vi.useFakeTimers();
    const dom = buildDom();
    mockStageRect(dom.stage);
    const pet = initTestPet({
      ...dom,
      bridge: makeBridge(),
      rng: () => 0,
      raf: () => 0,
      caf: () => {},
    });
    vi.advanceTimersByTime(10_000);
    expect(ACTS()).toContain(pet.getState().anim);
    expect(pet.getState().once).toBe(true);
    // The static image still shows until loadeddata fires onReady (which
    // removes .is-front from staticImg). Dispatch loadeddata first, then
    // assert the cross-fade has happened.
    dom.videoB.dispatchEvent(new Event("loadeddata"));
    expect(dom.staticImg.classList.contains("is-front")).toBe(false);
    dom.videoB.dispatchEvent(new Event("ended"));
    expect(pet.getState().anim).toBe(STATIC);
    expect(pet.getState().once).toBe(false);
    expect(dom.staticImg.classList.contains("is-front")).toBe(true);
    pet.destroy();
  });

  it("returns to STATIC after a click reaction ends", () => {
    const dom = buildDom();
    mockStageRect(dom.stage);
    const pet = initTestPet({
      ...dom,
      bridge: makeBridge(),
      rng: () => 0.5,
      raf: () => 0,
      caf: () => {},
    });
    dom.hit.dispatchEvent(pointer("click"));
    expect(ACTS()).not.toContain(pet.getState().anim);
    dom.videoB.dispatchEvent(new Event("loadeddata"));
    dom.videoB.dispatchEvent(new Event("ended"));
    expect(pet.getState().anim).toBe(STATIC);
    expect(dom.staticImg.classList.contains("is-front")).toBe(true);
    pet.destroy();
  });

  it("returns to STATIC after a drag ends", () => {
    const dom = buildDom();
    mockStageRect(dom.stage);
    const pet = initTestPet({
      ...dom,
      bridge: makeBridge(),
      rng: () => 0.5,
      raf: () => 1,
      caf: vi.fn(),
    });
    dom.hit.dispatchEvent(pointer("pointerdown", { clientX: 20, clientY: 40 }));
    dom.hit.dispatchEvent(
      pointer("pointermove", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
      }),
    );
    dom.hit.dispatchEvent(
      pointer("pointerup", {
        clientX: 35,
        clientY: 45,
        screenX: 130,
        screenY: 230,
      }),
    );
    expect(pet.getState().anim).toBe(STATIC);
    expect(dom.staticImg.classList.contains("is-front")).toBe(true);
    pet.destroy();
  });

  it("does not auto-flip facing across the cycle", () => {
    vi.useFakeTimers();
    const dom = buildDom();
    mockStageRect(dom.stage);
    const pet = initTestPet({
      ...dom,
      bridge: makeBridge(),
      rng: () => 0,
      raf: () => 0,
      caf: () => {},
    });
    expect(pet.getState().facing).toBe("left");
    vi.advanceTimersByTime(10);
    dom.videoB.dispatchEvent(new Event("loadeddata"));
    dom.videoB.dispatchEvent(new Event("ended"));
    expect(pet.getState().facing).toBe("left");
    vi.advanceTimersByTime(10);
    dom.videoA.dispatchEvent(new Event("loadeddata"));
    dom.videoA.dispatchEvent(new Event("ended"));
    expect(pet.getState().facing).toBe("left");
    pet.destroy();
  });

  it("does not arm a second act while one is already playing", () => {
    vi.useFakeTimers();
    const dom = buildDom();
    mockStageRect(dom.stage);
    const pet = initTestPet({
      ...dom,
      bridge: makeBridge(),
      rng: () => 0,
      raf: () => 0,
      caf: () => {},
    });
    dom.hit.dispatchEvent(pointer("click"));
    dom.videoB.dispatchEvent(new Event("loadeddata"));
    vi.advanceTimersByTime(10);
    // The static timer was cleared when the click triggered switchTo. If
    // a second act had been armed, dispatching loadeddata on videoA would
    // call videoA.play. Assert no such second-act ready event arrives.
    dom.videoA.dispatchEvent(new Event("loadeddata"));
    expect(dom.videoA.classList.contains("is-front")).toBe(false);
    pet.destroy();
  });

  it("verify-mode logs pet-verify-ok on static image load", () => {
    const dom = buildDom();
    mockStageRect(dom.stage);
    window.history.replaceState({}, "", "/?verify=1");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const pet = initTestPet({
      ...dom,
      bridge: makeBridge(),
      rng: () => 0.5,
      raf: () => 0,
      caf: () => {},
    });
    dom.staticImg.dispatchEvent(new Event("load"));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/^pet-verify-ok /);
    dom.staticImg.dispatchEvent(new Event("load"));
    expect(log).toHaveBeenCalledTimes(1);
    pet.destroy();
    log.mockRestore();
  });
});

describe("viewport layout and alpha-aware input", () => {
  it("reports exact fixed-base dimensions with viewport-aligned transforms", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockStageRect(dom.stage);
    const pet = initTestPet({ ...dom, bridge, rng: () => 0.5 });
    expect(dom.root.style.width).toBe("192px");
    expect(dom.root.style.height).toBe("108px");
    expect(dom.stage.style.width).toBe("192px");
    expect(dom.stage.style.height).toBe("108px");
    expect(dom.root.style.transform).toBe("none");
    expect(dom.stage.style.transform).toBe("none");
    expect(dom.hit.style.inset).toBe("0px");
    expect(bridge.reportStageLayout).toHaveBeenLastCalledWith({
      stage: { x: 0, y: 0, width: 192, height: 108 },
    });
    expect(bridge.setMousePassthrough).not.toHaveBeenCalled();
    pet.destroy();
  });

  it("uses the supplied zoom baseline without legacy window geometry", () => {
    setZoomQuery(200);
    const dom = buildDom();
    mockStageRect(dom.stage);
    const bridge = makeBridge();
    initTestPet({ ...dom, bridge, rng: () => 0.5 });
    expect(dom.root.style.width).toBe("384px");
    expect(dom.root.style.height).toBe("216px");
    expect(bridge.reportStageLayout).toHaveBeenLastCalledWith({
      stage: { x: 0, y: 0, width: 384, height: 216 },
    });
  });

  it("reports a viewport resize without writing an in-window position", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockStageRect(dom.stage);
    const pet = initTestPet({ ...dom, bridge, rng: () => 0.5 });
    const reports = bridge.reportStageLayout.mock.calls.length;
    window.dispatchEvent(new Event("resize"));
    expect(bridge.reportStageLayout).toHaveBeenCalledTimes(reports + 1);
    expect(dom.root.style.transform).toBe("none");
    expect(dom.stage.style.transform).toBe("none");
    pet.destroy();
  });
});

describe("full-stage drag reporting", () => {
  it("coalesces held moves to one latest payload per animation frame", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const frames: FrameRequestCallback[] = [];
    mockStageRect(dom.stage);
    initTestPet({
      ...dom,
      bridge,
      rng: () => 0.5,
      raf: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      caf: () => {},
    });
    dom.hit.dispatchEvent(pointer("pointerdown", { clientX: 20, clientY: 40 }));
    dom.hit.dispatchEvent(
      pointer("pointermove", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
      }),
    );
    dom.hit.dispatchEvent(
      pointer("pointermove", {
        clientX: 40,
        clientY: 50,
        screenX: 120,
        screenY: 220,
      }),
    );
    expect(frames).toHaveLength(1);
    frames[0](0);
    expect(bridge.sendDragPosition).toHaveBeenCalledWith({
      phase: "move",
      screenX: 120,
      screenY: 220,
      anchorX: 30,
      anchorY: 40,
      stage: { x: 0, y: 0, width: 192, height: 108 },
    });
  });

  it("flushes the final move before exactly one end payload", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockStageRect(dom.stage);
    const pet = initTestPet({
      ...dom,
      bridge,
      rng: () => 0.5,
      raf: () => 1,
      caf: vi.fn(),
    });
    dom.hit.dispatchEvent(pointer("pointerdown", { clientX: 20, clientY: 40 }));
    dom.hit.dispatchEvent(
      pointer("pointermove", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
      }),
    );
    dom.hit.dispatchEvent(
      pointer("pointerup", {
        clientX: 35,
        clientY: 45,
        screenX: 130,
        screenY: 230,
      }),
    );
    expect(bridge.sendDragPosition).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ phase: "move", screenX: 130, screenY: 230 }),
    );
    expect(bridge.sendDragPosition).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ phase: "end", screenX: 130, screenY: 230 }),
    );
    expect(bridge.sendDragPosition).toHaveBeenCalledTimes(2);
    expect(bridge.sendDragPosition.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.sendDragPosition.mock.invocationCallOrder[1],
    );
    expect(pet.getState().dragging).toBe(false);
    pet.destroy();
  });

  it("sends cancel only and leaves native origin restoration to main", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const caf = vi.fn();
    mockStageRect(dom.stage);
    const pet = initTestPet({
      ...dom,
      bridge,
      rng: () => 0.5,
      raf: () => 7,
      caf,
    });
    dom.hit.dispatchEvent(pointer("pointerdown", { clientX: 20, clientY: 40 }));
    dom.hit.dispatchEvent(
      pointer("pointermove", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
      }),
    );
    dom.hit.dispatchEvent(pointer("pointercancel"));
    expect(caf).toHaveBeenCalledWith(7);
    expect(bridge.sendDragPosition).toHaveBeenCalledTimes(1);
    expect(bridge.sendDragPosition).toHaveBeenLastCalledWith({
      phase: "cancel",
      screenX: 0,
      screenY: 0,
      anchorX: 30,
      anchorY: 40,
      stage: { x: 0, y: 0, width: 192, height: 108 },
    });
    expect(pet.getState().dragging).toBe(false);
    pet.destroy();
  });

  it("does not react to a transparent initial click or drag", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockStageRect(dom.stage);
    const pet = initPet({
      ...dom,
      bridge,
      alphaSampler: () => false,
      rng: () => 0.5,
      raf: () => 0,
      caf: () => {},
    });
    dom.hit.dispatchEvent(pointer("pointerdown", { clientX: 20, clientY: 40 }));
    dom.hit.dispatchEvent(pointer("click", { clientX: 20, clientY: 40 }));
    expect(pet.getState().anim).toBe(STATIC);
    expect(bridge.sendDragPosition).not.toHaveBeenCalled();
    expect(bridge.setMousePassthrough).not.toHaveBeenCalled();
    pet.destroy();
  });

  it("keeps a visible-origin click owned through a transparent release", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let visible = true;
    mockStageRect(dom.stage);
    const pet = initPet({
      ...dom,
      bridge,
      alphaSampler: () => visible,
      rng: () => 0.5,
    });
    dom.hit.dispatchEvent(pointer("pointerdown", { clientX: 20, clientY: 40 }));
    visible = false;
    dom.hit.dispatchEvent(pointer("pointerup", { clientX: 35, clientY: 45 }));
    dom.hit.dispatchEvent(pointer("click", { clientX: 35, clientY: 45 }));
    expect(pet.getState().anim).not.toBe(STATIC);
    expect(bridge.setMousePassthrough).toHaveBeenCalledWith(true);
    pet.destroy();
  });

  it("retains a visible-origin drag across transparent pixels and re-arms passthrough", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let visible = true;
    mockStageRect(dom.stage);
    const pet = initPet({
      ...dom,
      bridge,
      alphaSampler: () => visible,
      rng: () => 0.5,
      raf: () => 0,
      caf: () => {},
    });
    dom.hit.dispatchEvent(pointer("pointerdown", { clientX: 20, clientY: 40 }));
    dom.hit.dispatchEvent(
      pointer("pointermove", {
        clientX: 30,
        clientY: 40,
        screenX: 100,
        screenY: 200,
      }),
    );
    visible = false;
    dom.hit.dispatchEvent(
      pointer("pointerup", {
        clientX: 35,
        clientY: 45,
        screenX: 130,
        screenY: 230,
      }),
    );
    expect(bridge.sendDragPosition).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "end" }),
    );
    expect(bridge.setMousePassthrough).toHaveBeenCalledWith(true);
    expect(pet.getState().dragging).toBe(false);
    pet.destroy();
  });

  it("updates passthrough from forwarded mouse movement only when visibility changes", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let visible = false;
    mockStageRect(dom.stage);
    const pet = initPet({
      ...dom,
      bridge,
      alphaSampler: () => visible,
      rng: () => 0.5,
    });
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 20, clientY: 40 }),
    );
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 21, clientY: 41 }),
    );
    visible = true;
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 22, clientY: 42 }),
    );
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 23, clientY: 43 }),
    );
    expect(bridge.setMousePassthrough).toHaveBeenCalledTimes(1);
    expect(bridge.setMousePassthrough).toHaveBeenCalledWith(false);
    pet.destroy();
  });

  it("answers a deferred hit-test request after media readiness", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let hitRequest: ((request: unknown) => void) | undefined;
    bridge.onHitTestRequest.mockImplementation((listener) => {
      hitRequest = listener;
      return () => {};
    });
    let visible: boolean | null = null;
    mockStageRect(dom.stage);
    const pet = initPet({
      ...dom,
      bridge,
      alphaSampler: () => visible,
      rng: () => 0.5,
    });
    hitRequest?.({
      requestId: 7,
      screenX: 20,
      screenY: 30,
      window: { x: 0, y: 0, width: 192, height: 108 },
    });
    expect(bridge.reportHitTestResult).not.toHaveBeenCalled();
    visible = true;
    dom.staticImg.dispatchEvent(new Event("load"));
    expect(bridge.reportHitTestResult).toHaveBeenCalledWith({
      requestId: 7,
      visible: true,
    });
    pet.destroy();
  });

  it("maps negative-display DIP coordinates through zoom and rejects letterbox space", () => {
    setZoomQuery(200);
    const dom = buildDom();
    const bridge = makeBridge();
    const samples: Array<{
      point: { x: number; y: number };
      layers: readonly {
        element: Element;
        intrinsicX: number;
        intrinsicY: number;
      }[];
    }> = [];
    let hitRequest: ((request: unknown) => void) | undefined;
    bridge.onHitTestRequest.mockImplementation((listener) => {
      hitRequest = listener;
      return () => {};
    });
    mockStageRect(dom.stage);
    defineImageDimensions(dom.staticImg, 600, 360);
    vi.spyOn(dom.staticImg, "getBoundingClientRect").mockReturnValue(
      rect(0, 0, 300, 216),
    );
    const alphaSampler = vi.fn(
      (
        point: { x: number; y: number },
        layers: readonly {
          element: Element;
          intrinsicX: number;
          intrinsicY: number;
        }[],
      ) => {
        samples.push({ point, layers });
        return layers.some((layer) => layer.element === dom.staticImg);
      },
    );
    const pet = initPet({ ...dom, bridge, alphaSampler, rng: () => 0.5 });

    hitRequest?.({
      requestId: 1,
      screenX: 0,
      screenY: -150,
      window: { x: -100, y: -200, width: 384, height: 216 },
    });
    const mapped = samples[0];
    const staticLayer = mapped?.layers.find(
      (layer) => layer.element === dom.staticImg,
    );
    expect(mapped?.point).toEqual({ x: 100, y: 50 });
    expect(staticLayer?.intrinsicX).toBeCloseTo(200);
    expect(staticLayer?.intrinsicY).toBeCloseTo(64);
    expect(bridge.reportHitTestResult).toHaveBeenLastCalledWith({
      requestId: 1,
      visible: true,
    });

    alphaSampler.mockClear();
    hitRequest?.({
      requestId: 2,
      screenX: 0,
      screenY: -190,
      window: { x: -100, y: -200, width: 384, height: 216 },
    });
    expect(alphaSampler).toHaveBeenCalledWith(
      { x: 100, y: 10 },
      expect.not.arrayContaining([
        expect.objectContaining({ element: dom.staticImg }),
      ]),
    );
    expect(bridge.reportHitTestResult).toHaveBeenLastCalledWith({
      requestId: 2,
      visible: false,
    });

    alphaSampler.mockClear();
    hitRequest?.({
      requestId: 3,
      screenX: 0,
      screenY: -150,
      window: { x: Number.POSITIVE_INFINITY, y: -200, width: 384, height: 216 },
    });
    expect(alphaSampler).not.toHaveBeenCalled();
    expect(bridge.reportHitTestResult).toHaveBeenLastCalledWith({
      requestId: 3,
      visible: false,
    });
    pet.destroy();
  });

  it("treats alpha noise as transparent and applies CSS opacity to the hit threshold", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let hitRequest: ((request: unknown) => void) | undefined;
    bridge.onHitTestRequest.mockImplementation((listener) => {
      hitRequest = listener;
      return () => {};
    });
    mockStageRect(dom.stage);
    defineImageDimensions(dom.staticImg, 640, 360);
    dom.staticImg.style.opacity = "1";
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          opacity: (element as HTMLElement).style.opacity || "1",
        }) as CSSStyleDeclaration,
    );
    const alphaValues = [1, 17, 17];
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: Uint8ClampedArray.from([0, 0, 0, alphaValues.shift() ?? 0]),
      })),
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context,
    );
    const pet = initPet({ ...dom, bridge, rng: () => 0.5 });

    hitRequest?.({
      requestId: 1,
      screenX: 96,
      screenY: 54,
      window: { x: 0, y: 0, width: 192, height: 108 },
    });
    expect(bridge.reportHitTestResult).toHaveBeenLastCalledWith({
      requestId: 1,
      visible: false,
    });

    hitRequest?.({
      requestId: 2,
      screenX: 96,
      screenY: 54,
      window: { x: 0, y: 0, width: 192, height: 108 },
    });
    expect(bridge.reportHitTestResult).toHaveBeenLastCalledWith({
      requestId: 2,
      visible: true,
    });

    dom.staticImg.style.opacity = "0.5";
    hitRequest?.({
      requestId: 3,
      screenX: 96,
      screenY: 54,
      window: { x: 0, y: 0, width: 192, height: 108 },
    });
    expect(bridge.reportHitTestResult).toHaveBeenLastCalledWith({
      requestId: 3,
      visible: false,
    });
    pet.destroy();
  });

  it("composites decoded media alpha with effective cross-fade opacity", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let hitRequest: ((request: unknown) => void) | undefined;
    bridge.onHitTestRequest.mockImplementation((listener) => {
      hitRequest = listener;
      return () => {};
    });
    mockStageRect(dom.stage);
    defineImageDimensions(dom.staticImg, 640, 360);
    defineVideoDimensions(dom.videoA, 640, 360);
    defineVideoDimensions(dom.videoB, 640, 360);
    dom.staticImg.style.opacity = "0.25";
    dom.videoA.style.opacity = "0.5";
    dom.videoB.style.opacity = "0.5";
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          opacity: (element as HTMLElement).style.opacity || "1",
        }) as CSSStyleDeclaration,
    );
    const alphaValues = [0, 128, 0];
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({
        data: Uint8ClampedArray.from([0, 0, 0, alphaValues.shift() ?? 0]),
      })),
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context,
    );
    const pet = initPet({ ...dom, bridge, rng: () => 0.5 });

    hitRequest?.({
      requestId: 1,
      screenX: 96,
      screenY: 54,
      window: { x: 0, y: 0, width: 192, height: 108 },
    });
    expect(bridge.reportHitTestResult).toHaveBeenLastCalledWith({
      requestId: 1,
      visible: true,
    });

    alphaValues.push(0, 0, 0);
    hitRequest?.({
      requestId: 2,
      screenX: 96,
      screenY: 54,
      window: { x: 0, y: 0, width: 192, height: 108 },
    });
    expect(bridge.reportHitTestResult).toHaveBeenLastCalledWith({
      requestId: 2,
      visible: false,
    });
    expect(context.drawImage).toHaveBeenCalled();
    pet.destroy();
  });

  it("resamples video frames and ignores stale callbacks after transition and destroy", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let visible = true;
    let frameCallback: (() => void) | undefined;
    mockStageRect(dom.stage);
    Object.defineProperty(dom.videoB, "requestVideoFrameCallback", {
      configurable: true,
      value: vi.fn((callback: () => void) => {
        frameCallback = callback;
        return 1;
      }),
    });
    const pet = initPet({
      ...dom,
      bridge,
      alphaSampler: () => visible,
      rng: () => 0,
    });
    window.dispatchEvent(
      new MouseEvent("mousemove", { clientX: 20, clientY: 40 }),
    );
    dom.hit.dispatchEvent(pointer("click", { clientX: 20, clientY: 40 }));
    defineVideoDimensions(dom.videoB, 640, 360);
    dom.videoB.dispatchEvent(new Event("loadeddata"));
    expect(frameCallback).toBeDefined();

    visible = false;
    frameCallback?.();
    expect(bridge.setMousePassthrough).toHaveBeenLastCalledWith(true);

    const callsAfterFrame = bridge.setMousePassthrough.mock.calls.length;
    dom.videoB.dispatchEvent(new Event("ended"));
    const callsAfterTransition = bridge.setMousePassthrough.mock.calls.length;
    expect(callsAfterTransition).toBeGreaterThanOrEqual(callsAfterFrame);
    frameCallback?.();
    expect(bridge.setMousePassthrough.mock.calls.length).toBe(
      callsAfterTransition,
    );
    pet.destroy();
    frameCallback?.();
    expect(bridge.setMousePassthrough.mock.calls.length).toBe(
      callsAfterTransition,
    );
  });
});

describe("zoom and cleanup", () => {
  it("resizes layout without capturing a DOM bottom-center coordinate", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let zoomListener:
      | ((state: { percent: number; accepted: boolean }) => void)
      | undefined;
    bridge.onZoomState.mockImplementation((listener) => {
      zoomListener = listener;
      return () => {};
    });
    mockStageRect(dom.stage);
    initTestPet({ ...dom, bridge, rng: () => 0.5 });
    zoomListener?.({ percent: 125, accepted: true });
    expect(dom.root.style.width).toBe("240px");
    expect(dom.root.style.height).toBe("135px");
    expect(dom.root.style.transform).toBe("none");
    expect(dom.stage.style.transform).toBe("none");
    expect(bridge.reportStageLayout).toHaveBeenLastCalledWith({
      stage: { x: 0, y: 0, width: 240, height: 135 },
    });
  });

  it("keeps wheel zoom threshold and request coalescing", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    let zoomListener:
      | ((state: { percent: number; accepted: boolean }) => void)
      | undefined;
    bridge.onZoomState.mockImplementation((listener) => {
      zoomListener = listener;
      return () => {};
    });
    mockStageRect(dom.stage);
    initTestPet({ ...dom, bridge, rng: () => 0.5 });
    const first = new WheelEvent("wheel", { deltaY: -50, cancelable: true });
    dom.hit.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(bridge.requestZoomPercent).not.toHaveBeenCalled();
    dom.hit.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -50, cancelable: true }),
    );
    expect(bridge.requestZoomPercent).toHaveBeenCalledWith({ percent: 125 });
    zoomListener?.({ percent: 125, accepted: true });
    expect(bridge.reportStageLayout).toHaveBeenLastCalledWith({
      stage: { x: 0, y: 0, width: 240, height: 135 },
    });
  });

  it("removes listeners and cancels pending frame work on destroy", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const removeZoom = vi.fn();
    const removeHitTest = vi.fn();
    const removeMouseMove = vi.spyOn(window, "removeEventListener");
    const caf = vi.fn();
    bridge.onZoomState.mockImplementation(() => removeZoom);
    bridge.onHitTestRequest.mockImplementation(() => removeHitTest);
    mockStageRect(dom.stage);
    const pet = initTestPet({
      ...dom,
      bridge,
      rng: () => 0.5,
      raf: () => 9,
      caf,
    });
    dom.hit.dispatchEvent(pointer("pointerdown", { clientX: 20, clientY: 40 }));
    dom.hit.dispatchEvent(pointer("pointermove", { clientX: 30, clientY: 40 }));
    pet.destroy();
    expect(removeZoom).toHaveBeenCalledTimes(1);
    expect(removeHitTest).toHaveBeenCalledTimes(1);
    expect(removeMouseMove).toHaveBeenCalledWith(
      "mousemove",
      expect.any(Function),
    );
    expect(caf).toHaveBeenCalledWith(9);
  });
});

describe("weighted animation chain", () => {
  const cfg: PetConfig = {
    animations: {
      idle: ["idle-A"],
      turn: [],
      drag: [],
      moves: [],
      clicks: [],
      categories: [
        { id: "small", weight: 20, actions: ["s1", "s2"] },
        { id: "play", weight: 20, actions: ["p1", "p2", "p3"] },
        { id: "food", weight: 16, actions: ["f1"] },
        { id: "fest", weight: 14, actions: ["fe1", "fe2"] },
        { id: "txt", weight: 10, noMirror: true, actions: ["t1"] },
      ],
    },
    animationWeights: { idle: 10, turn: 0, move: 0 },
  };

  // mulberry32 seeded RNG — deterministic distribution tests.
  const seededRng = (() => {
    let s = 0xdeadbeef;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  it("matches the weight distribution over 10000 picks", () => {
    // Total weight = 10 idle + 80 categories = 90. Shares are x/90.
    const counts: Record<string, number> = {
      idle: 0,
      small: 0,
      play: 0,
      food: 0,
      fest: 0,
      txt: 0,
    };
    const N = 10000;
    for (let i = 0; i < N; i++) {
      const p = pickNext(cfg, null, "left", seededRng);
      if (!p) continue;
      if (p.kind === "idle") counts.idle++;
      else {
        const cat = cfg.animations.categories.find((c) =>
          c.actions.includes(p.name),
        );
        if (cat) counts[cat.id]++;
      }
    }
    expect(Math.abs(counts.idle / N - 10 / 90)).toBeLessThan(0.015);
    expect(Math.abs(counts.small / N - 20 / 90)).toBeLessThan(0.015);
    expect(Math.abs(counts.play / N - 20 / 90)).toBeLessThan(0.015);
    expect(Math.abs(counts.food / N - 16 / 90)).toBeLessThan(0.015);
    expect(Math.abs(counts.fest / N - 14 / 90)).toBeLessThan(0.015);
    expect(Math.abs(counts.txt / N - 10 / 90)).toBeLessThan(0.015);
  });

  it("never repeats the same act twice in a row across 1000 picks", () => {
    let last: string | null = null;
    let repeats = 0;
    for (let i = 0; i < 1000; i++) {
      const p = pickNext(cfg, last, "left", seededRng);
      if (!p) continue;
      if (p.name === last) repeats++;
      last = p.name;
    }
    expect(repeats).toBe(0);
  });

  it("pickWeightedCategory returns null when all categories are noMirror and facing=right", () => {
    expect(
      pickWeightedCategory(
        [{ id: "x", weight: 1, noMirror: true, actions: ["x"] }],
        "right",
        seededRng,
      ),
    ).toBeNull();
  });

  it("pickWeightedCategory returns a noMirror category when facing=left", () => {
    expect(
      pickWeightedCategory(
        [{ id: "x", weight: 1, noMirror: true, actions: ["x"] }],
        "left",
        seededRng,
      ),
    ).toEqual({ id: "x", actions: ["x"] });
  });

  it("excludes noMirror categories when facing=right via the chain", () => {
    const cfgNoMirror: PetConfig = {
      animations: {
        idle: [],
        turn: [],
        drag: [],
        moves: [],
        clicks: [],
        categories: [
          { id: "ok", weight: 1, actions: ["a"] },
          { id: "txt", weight: 1, noMirror: true, actions: ["t"] },
        ],
      },
      animationWeights: { idle: 0, turn: 0, move: 0 },
    };
    let sawOk = false;
    for (let i = 0; i < 1000; i++) {
      const p = pickNext(cfgNoMirror, null, "right", seededRng);
      if (!p) continue;
      expect(p.name).not.toBe("t");
      if (p.name === "a") sawOk = true;
    }
    expect(sawOk).toBe(true);
  });
});
