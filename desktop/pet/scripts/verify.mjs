/**
 * Empirical playback check (research gap #1): proves a file:// <video>
 * plays under sandbox:true + webSecurity:true in a transparent window.
 * Run via `pnpm verify` (= `electron scripts/verify.mjs`). Exits 0 when
 * the renderer logs `pet-verify-ok`, 1 on timeout or did-fail-load.
 */
import { app } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPetWindow } from "../dist/pet-window.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const petRoot = path.join(here, "..");
const VERIFY_TIMEOUT_MS = 30_000;

app.whenReady().then(() => {
  let win;
  try {
    win = createPetWindow({
      root: petRoot,
      log: (msg) => console.log(`[verify] ${msg}`),
      query: { verify: "1" },
    });
  } catch (err) {
    console.error(`[verify] FAIL: ${String(err)}`);
    app.exit(1);
    return;
  }

  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    app.exit(code);
  };

  const timer = setTimeout(() => {
    console.error("[verify] FAIL: timed out after 30s (no pet-verify-ok)");
    finish(1);
  }, VERIFY_TIMEOUT_MS);

  win.webContents.on("console-message", (event, _level, message) => {
    // Electron 32+ exposes the message on the event object (event.message)
    // and keeps the old positional form for compatibility; read the event
    // property first and fall back to the positional argument so this works
    // on the 33.4.11 pin regardless of the event's argument shape.
    // (Plain JS — this file is .mjs, no TypeScript casts allowed.)
    const text = typeof event.message === "string" ? event.message : message;
    if (typeof text === "string" && text.startsWith("pet-verify-ok")) {
      clearTimeout(timer);
      console.log(`[verify] OK: ${text}`);
      console.log(`[verify] isVisible=${win.isVisible()}`);
      finish(0);
    }
  });

  win.webContents.on("did-fail-load", (_event, code, desc) => {
    console.error(`[verify] FAIL: did-fail-load ${code} ${desc}`);
    finish(1);
  });
});
