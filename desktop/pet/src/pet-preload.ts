/** Sandboxed, context-isolated bridge for the local pet renderer. */
import { contextBridge, ipcRenderer } from "electron";
import type {
  PetDragPosition,
  PetStageLayout,
  PetZoomRequest,
  PetZoomState,
  PetIdleDwellState,
} from "./pet-bridge.js";

const DRAG_POSITION = "phi:pet-drag-position";
const ZOOM_REQUEST = "phi:pet-zoom-request";
const ZOOM_STATE = "phi:pet-zoom-state";
const LAYOUT = "phi:pet-stage-layout";
const DWELL_STATE = "phi:pet-idle-dwell-state";

contextBridge.exposeInMainWorld("pet", {
  sendDragPosition: (position: PetDragPosition): void =>
    ipcRenderer.send(DRAG_POSITION, position),
  requestZoomPercent: (request: PetZoomRequest): void =>
    ipcRenderer.send(ZOOM_REQUEST, request),
  reportStageLayout: (layout: PetStageLayout): void =>
    ipcRenderer.send(LAYOUT, layout),
  onZoomState: (listener: (state: PetZoomState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: PetZoomState): void => listener(state);
    ipcRenderer.on(ZOOM_STATE, wrapped);
    return () => ipcRenderer.removeListener(ZOOM_STATE, wrapped);
  },
  onIdleDwellState: (listener: (state: PetIdleDwellState) => void): (() => void) => {
    const wrapped = (_event: unknown, state: PetIdleDwellState): void => listener(state);
    ipcRenderer.on(DWELL_STATE, wrapped);
    return () => ipcRenderer.removeListener(DWELL_STATE, wrapped);
  },
});
