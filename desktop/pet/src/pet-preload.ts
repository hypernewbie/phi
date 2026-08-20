/** Sandboxed, context-isolated bridge for the local pet renderer. */
import { contextBridge, ipcRenderer } from "electron";
import type { PetMove, StageRect, TerritoryBounds } from "./pet-bridge.js";

const HIT = "phi:pet-hit";
const MOVE = "phi:pet-window-move";
const LAYOUT = "phi:pet-stage-layout";
const TERRITORY = "phi:pet-territory-bounds";

contextBridge.exposeInMainWorld("pet", {
  sendHit: (inside: boolean): void => ipcRenderer.send(HIT, inside),
  sendMove: (move: PetMove): void => ipcRenderer.send(MOVE, move),
  reportStageLayout: (stage: StageRect): void => ipcRenderer.send(LAYOUT, { stage }),
  onTerritoryBounds: (listener: (bounds: TerritoryBounds) => void): (() => void) => {
    const wrapped = (_event: unknown, bounds: TerritoryBounds): void => listener(bounds);
    ipcRenderer.on(TERRITORY, wrapped);
    return () => ipcRenderer.removeListener(TERRITORY, wrapped);
  },
});
