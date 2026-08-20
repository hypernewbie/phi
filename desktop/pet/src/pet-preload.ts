/**
 * Preload bridge for the pet page (sandboxed, context isolated). Exposes
 * a single window.pet surface with the two renderer→main sends the pet
 * needs. Channel literals are duplicated here on purpose — the CJS
 * preload build must not pull in the ESM src modules (the same convention
 * as the shell's preload.ts).
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pet", {
 /** Report whether the pointer is over the pet's hit region. */
 sendHit: (inside: boolean): void => {
  ipcRenderer.send("phi:pet-hit", inside);
 },
 /** Report the accumulated drag delta (the window follows home). */
 sendMove: (dx: number, dy: number): void => {
  ipcRenderer.send("phi:pet-window-move", { dx, dy });
 },
});
