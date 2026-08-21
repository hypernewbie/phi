import { contextBridge, ipcRenderer } from "electron";
import type {
  PetIdleDwellResult,
  PetIdleDwellState,
  PetSettingsApi,
} from "./pet-bridge.js";

const REQUEST = "phi:pet-settings-idle-dwell-request";
const STATE = "phi:pet-idle-dwell-state";

const api: PetSettingsApi = {
  requestIdleDwellSeconds: (
    dwellSeconds: number,
  ): Promise<PetIdleDwellResult> =>
    ipcRenderer.invoke(REQUEST, { dwellSeconds }),
  onIdleDwellState: (
    listener: (state: PetIdleDwellState) => void,
  ): (() => void) => {
    const wrapped = (_event: unknown, state: PetIdleDwellState): void =>
      listener(state);
    ipcRenderer.on(STATE, wrapped);
    return () => ipcRenderer.removeListener(STATE, wrapped);
  },
};

contextBridge.exposeInMainWorld("petSettings", api);
