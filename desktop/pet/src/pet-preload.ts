/** Sandboxed, context-isolated bridge for the local pet renderer. */
import { contextBridge, ipcRenderer } from "electron";
import type { PetMove, PetScaleRequest, PetScaleState, PetStageLayout, TerritoryBounds } from "./pet-bridge.js";

const HIT = "phi:pet-hit";
const MOVE = "phi:pet-window-move";
const SCALE_REQUEST = "phi:pet-scale-request";
const SCALE_STATE = "phi:pet-scale-state";
const RESET_POSITION = "phi:pet-reset-position";
const LAYOUT = "phi:pet-stage-layout";
const TERRITORY = "phi:pet-territory-bounds";

contextBridge.exposeInMainWorld("pet", {
  sendHit: (inside: boolean): void => ipcRenderer.send(HIT, inside),
  sendMove: (move: PetMove): void => ipcRenderer.send(MOVE, move),
  requestScaleTick: (request: PetScaleRequest): void => ipcRenderer.send(SCALE_REQUEST, request),
  reportStageLayout: (layout: PetStageLayout): void => ipcRenderer.send(LAYOUT, layout),
  onTerritoryBounds: (listener: (bounds: TerritoryBounds) => void): (() => void) => {
    const wrapped = (_event: unknown, bounds: TerritoryBounds): void => listener(bounds);
    ipcRenderer.on(TERRITORY, wrapped);
    return () => ipcRenderer.removeListener(TERRITORY, wrapped);
  },
  onScaleState: (listener: (state: PetScaleState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: PetScaleState): void => listener(state);
    ipcRenderer.on(SCALE_STATE, wrapped);
    return () => ipcRenderer.removeListener(SCALE_STATE, wrapped);
  },
  onResetPosition: (listener: () => void): (() => void) => {
    const wrapped = (): void => listener();
    ipcRenderer.on(RESET_POSITION, wrapped);
    return () => ipcRenderer.removeListener(RESET_POSITION, wrapped);
  },
});
