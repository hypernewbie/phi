// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { exposeInMainWorld, ipcRenderer } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer,
}));

import "../src/pet-preload.js";

const bridge = exposeInMainWorld.mock.calls[0][1] as {
  sendDragPosition(position: unknown): void;
  requestZoomPercent(request: unknown): void;
  reportStageLayout(layout: unknown): void;
  setMousePassthrough(ignore: boolean): void;
  reportHitTestResult(result: unknown): void;
  onHitTestRequest(listener: (request: unknown) => void): () => void;
  onZoomState(listener: (state: unknown) => void): () => void;
  onIdleDwellState(listener: (state: unknown) => void): () => void;
};

beforeEach(() => vi.clearAllMocks());

describe("reduced pet preload bridge", () => {
  it("exposes only the retained runtime methods", () => {
    expect(Object.keys(bridge).sort()).toEqual([
      "onHitTestRequest",
      "onIdleDwellState",
      "onZoomState",
      "reportHitTestResult",
      "reportStageLayout",
      "requestZoomPercent",
      "sendDragPosition",
      "setMousePassthrough",
    ]);
  });

  it("sends drag, zoom, and layout payloads on their retained channels", () => {
    const drag = {
      phase: "move",
      screenX: 20,
      screenY: 30,
      anchorX: 4,
      anchorY: 5,
      stage: { x: 0, y: 0, width: 192, height: 108 },
    };
    const zoom = { percent: 125 };
    const layout = { stage: { x: 0, y: 0, width: 240, height: 135 } };
    const hitResult = { requestId: 1, visible: true };
    bridge.sendDragPosition(drag);
    bridge.requestZoomPercent(zoom);
    bridge.reportStageLayout(layout);
    bridge.setMousePassthrough(false);
    bridge.reportHitTestResult(hitResult);
    expect(ipcRenderer.send).toHaveBeenNthCalledWith(
      1,
      "phi:pet-drag-position",
      drag,
    );
    expect(ipcRenderer.send).toHaveBeenNthCalledWith(
      2,
      "phi:pet-zoom-request",
      zoom,
    );
    expect(ipcRenderer.send).toHaveBeenNthCalledWith(
      3,
      "phi:pet-stage-layout",
      layout,
    );
    expect(ipcRenderer.send).toHaveBeenNthCalledWith(
      4,
      "phi:pet-mouse-passthrough",
      false,
    );
    expect(ipcRenderer.send).toHaveBeenNthCalledWith(
      5,
      "phi:pet-hit-test-result",
      hitResult,
    );
  });

  it("delivers hit-test requests and removes their wrapped listener on cleanup", () => {
    const listener = vi.fn();
    const unsubscribe = bridge.onHitTestRequest(listener);
    const wrapped = ipcRenderer.on.mock.calls[0][1];
    const request = {
      requestId: 1,
      screenX: 20,
      screenY: 30,
      window: { x: 0, y: 0, width: 192, height: 108 },
    };
    wrapped({}, request);
    unsubscribe();
    expect(listener).toHaveBeenCalledWith(request);
    expect(ipcRenderer.on).toHaveBeenCalledWith(
      "phi:pet-hit-test-request",
      wrapped,
    );
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "phi:pet-hit-test-request",
      wrapped,
    );
  });

  it("delivers zoom state and removes its wrapped listener on cleanup", () => {
    const listener = vi.fn();
    const unsubscribe = bridge.onZoomState(listener);
    const wrapped = ipcRenderer.on.mock.calls[0][1];
    const state = { percent: 200, accepted: true };
    wrapped({}, state);
    unsubscribe();
    expect(listener).toHaveBeenCalledWith(state);
    expect(ipcRenderer.on).toHaveBeenCalledWith("phi:pet-zoom-state", wrapped);
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "phi:pet-zoom-state",
      wrapped,
    );
  });

  it("delivers dwell state and removes its wrapped listener on cleanup", () => {
    const listener = vi.fn();
    const unsubscribe = bridge.onIdleDwellState(listener);
    const wrapped = ipcRenderer.on.mock.calls[0][1];
    wrapped({}, { dwellSeconds: 180_000 });
    unsubscribe();
    expect(listener).toHaveBeenCalledWith({ dwellSeconds: 180_000 });
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "phi:pet-idle-dwell-state",
      wrapped,
    );
  });
});
