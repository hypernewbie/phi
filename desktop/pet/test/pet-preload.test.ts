// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { exposeInMainWorld, ipcRenderer } = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer,
}));

import '../src/pet-preload.js';

type PetBridge = {
  onTerritoryBounds(listener: (bounds: { minStageX: number; maxStageX: number; minStageY: number; maxStageY: number }) => void): () => void;
};

const bridge = exposeInMainWorld.mock.calls[0][1] as PetBridge;
beforeEach(() => vi.clearAllMocks());

describe('pet preload territory bridge', () => {
  it('removes its wrapped IPC listener when unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = bridge.onTerritoryBounds(listener);
    const wrapped = ipcRenderer.on.mock.calls[0][1];

    wrapped({}, { minStageX: 1, maxStageX: 2, minStageY: 3, maxStageY: 4 });
    unsubscribe();

    expect(listener).toHaveBeenCalledWith({ minStageX: 1, maxStageX: 2, minStageY: 3, maxStageY: 4 });
    expect(ipcRenderer.removeListener).toHaveBeenCalledWith('phi:pet-territory-bounds', wrapped);
  });
});
