import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTS, STATIC, initPet, pick } from "../src/pet-view.js";

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
    onZoomState: vi.fn(
      (_listener: (state: { percent: number; accepted: boolean }) => void) =>
        () => {},
    ),
    onIdleDwellState: vi.fn(
      (_listener: (state: { dwellSeconds: number }) => void) => () => {},
    ),
  };
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

describe("stationary animation chain", () => {
  it("retains the act catalog and excludes the current animation when requested", () => {
    expect(ACTS).toHaveLength(42);
    expect(new Set(ACTS).size).toBe(42);
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
    const pet = initPet({
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
    expect(ACTS).toContain(pet.getState().anim);
    // First act goes to videoB (initial front=0, el=videoB).
    dom.videoB.dispatchEvent(new Event("loadeddata"));
    dom.videoB.dispatchEvent(new Event("ended"));
    expect(pet.getState().anim).toBe(STATIC);
    expect(dom.staticImg.classList.contains("is-front")).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(pet.getState().anim).toBe(STATIC);
    vi.advanceTimersByTime(1);
    expect(ACTS).toContain(pet.getState().anim);
    expect(ACTS).toContain(pet.getState().anim);
    // Second act goes to videoA (front=1 after first onReady).
    dom.videoA.dispatchEvent(new Event("loadeddata"));
    dom.videoA.dispatchEvent(new Event("ended"));
    pet.destroy();
  });

  it("returns to STATIC when an act video load fails", () => {
    vi.useFakeTimers();
    const dom = buildDom();
    mockStageRect(dom.stage);
    const pet = initPet({
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
    const pet = initPet({
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
    const pet = initPet({
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
    const pet = initPet({ ...dom, bridge: makeBridge(), rng: () => 0.5 });
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
    initPet({ ...dom, bridge: makeBridge(), rng: () => 0.5 });
    expect(dom.staticImg.src).toMatch(/maid-static\.png$/);
  });

  it("transitions STATIC to ACTS to STATIC on the dwell cycle", () => {
    vi.useFakeTimers();
    const dom = buildDom();
    mockStageRect(dom.stage);
    const pet = initPet({
      ...dom,
      bridge: makeBridge(),
      rng: () => 0,
      raf: () => 0,
      caf: () => {},
    });
    vi.advanceTimersByTime(10_000);
    expect(ACTS).toContain(pet.getState().anim);
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
    const pet = initPet({
      ...dom,
      bridge: makeBridge(),
      rng: () => 0.5,
      raf: () => 0,
      caf: () => {},
    });
    dom.hit.dispatchEvent(pointer("click"));
    expect(ACTS).not.toContain(pet.getState().anim);
    dom.videoB.dispatchEvent(new Event("loadeddata"));
    dom.videoB.dispatchEvent(new Event("ended"));
    expect(pet.getState().anim).toBe(STATIC);
    expect(dom.staticImg.classList.contains("is-front")).toBe(true);
    pet.destroy();
  });

  it("returns to STATIC after a drag ends", () => {
    const dom = buildDom();
    mockStageRect(dom.stage);
    const pet = initPet({
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
    const pet = initPet({
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
    const pet = initPet({
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
    const pet = initPet({
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

describe("viewport layout and full-stage input", () => {
  it("reports exact fixed-base dimensions with viewport-aligned transforms", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    mockStageRect(dom.stage);
    const pet = initPet({ ...dom, bridge, rng: () => 0.5 });
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
    expect("sendHit" in bridge).toBe(false);
    pet.destroy();
  });

  it("uses the supplied zoom baseline without legacy window geometry", () => {
    setZoomQuery(200);
    const dom = buildDom();
    mockStageRect(dom.stage);
    const bridge = makeBridge();
    initPet({ ...dom, bridge, rng: () => 0.5 });
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
    const pet = initPet({ ...dom, bridge, rng: () => 0.5 });
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
    initPet({
      ...dom,
      bridge,
      rng: () => 0.5,
      raf: (cb) => (frames.push(cb), frames.length),
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
    const pet = initPet({
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
    const pet = initPet({ ...dom, bridge, rng: () => 0.5, raf: () => 7, caf });
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

  it("uses the complete hit viewport for click and drag input", () => {
    const dom = buildDom();
    const bridge = makeBridge();
    const pet = initPet({
      ...dom,
      bridge,
      rng: () => 0.5,
      raf: () => 0,
      caf: () => {},
    });
    dom.hit.dispatchEvent(pointer("click"));
    expect(bridge.sendDragPosition).not.toHaveBeenCalled();
    expect(dom.hit.style.inset).toBe("0px");
    pet.destroy();
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
    initPet({ ...dom, bridge, rng: () => 0.5 });
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
    initPet({ ...dom, bridge, rng: () => 0.5 });
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
    const caf = vi.fn();
    bridge.onZoomState.mockImplementation(() => removeZoom);
    const pet = initPet({ ...dom, bridge, rng: () => 0.5, raf: () => 9, caf });
    dom.hit.dispatchEvent(pointer("pointerdown", { clientX: 20, clientY: 40 }));
    dom.hit.dispatchEvent(pointer("pointermove", { clientX: 30, clientY: 40 }));
    pet.destroy();
    expect(removeZoom).toHaveBeenCalledTimes(1);
    expect(caf).toHaveBeenCalledWith(9);
  });
});
