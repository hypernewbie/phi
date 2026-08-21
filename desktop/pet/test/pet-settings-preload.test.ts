// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { exposeInMainWorld, ipcRenderer } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer,
}));

import "../src/pet-settings-preload.js";

const api = exposeInMainWorld.mock.calls[0][1] as Record<
  string,
  (...args: any[]) => any
>;

beforeEach(() => vi.clearAllMocks());

describe("pet settings preload contract", () => {
  it("exposes exactly the request and state-listener methods", () => {
    expect(Object.keys(api).sort()).toEqual([
      "onIdleDwellState",
      "requestIdleDwellSeconds",
    ]);
  });

  it("invokes the bounded IPC request payload", async () => {
    ipcRenderer.invoke.mockResolvedValue({
      dwellSeconds: 60_000,
      accepted: true,
    });
    await expect(api.requestIdleDwellSeconds(60_000)).resolves.toEqual({
      dwellSeconds: 60_000,
      accepted: true,
    });
    expect(ipcRenderer.invoke).toHaveBeenCalledWith(
      "phi:pet-settings-idle-dwell-request",
      { dwellSeconds: 60_000 },
    );
  });

  it("delivers state through a wrapped listener and cleans it up", () => {
    const listener = vi.fn();
    const remove = api.onIdleDwellState(listener);
    const wrapped = ipcRenderer.on.mock.calls[0][1];
    wrapped({}, { dwellSeconds: 180_000 });
    remove();
    expect(listener).toHaveBeenCalledWith({ dwellSeconds: 180_000 });
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
      "phi:pet-idle-dwell-state",
      wrapped,
    );
  });
});
