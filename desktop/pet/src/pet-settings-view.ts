import type { PetIdleDwellState } from "./pet-bridge.js";

const MIN = 1;
const MAX = 3600;
const DEFAULT = 10;
const validDwellSeconds = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= MIN && (value as number) <= MAX;
// clamp is unused at module top-level — covered inside onChange

const queryValue = (): number => {
  const raw = new URLSearchParams(window.location.search).get(
    "petIdleDwellSeconds",
  );
  const value = raw === null ? null : Number(raw);
  return validDwellSeconds(value) ? (value as number) : DEFAULT;
};

const input = document.getElementById(
  "pet-idle-dwell",
) as HTMLInputElement | null;
const error = document.getElementById("pet-settings-error");
let confirmed = queryValue();
if (input) input.value = String(confirmed);

const showError = (message: string): void => {
  if (error) error.textContent = message;
};

const onChange = async (): Promise<void> => {
  if (!input) return;
  const raw = input.value.trim();
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || raw === "") {
    input.value = String(confirmed);
    showError("Invalid pet idle interval.");
    return;
  }
  const integer = Math.trunc(parsed);
  const clamped = Math.min(MAX, Math.max(MIN, integer));
  const clampedIsInteger = Number.isInteger(clamped) && clamped >= MIN && clamped <= MAX;
  if (!clampedIsInteger) {
    input.value = String(confirmed);
    showError("Invalid pet idle interval.");
    return;
  }
  try {
    const result = await window.petSettings.requestIdleDwellSeconds(clamped);
    if (result.accepted && result.dwellSeconds === clamped) {
      confirmed = clamped;
      input.value = String(clamped);
      showError("");
    } else {
      input.value = String(confirmed);
      showError(result.error ?? "Unable to save pet idle interval.");
    }
  } catch {
    input.value = String(confirmed);
    showError("Unable to save pet idle interval.");
  }
};
input?.addEventListener("change", () => void onChange());
input?.addEventListener("blur", () => void onChange());
const closeBtn = document.getElementById("pet-settings-close");
closeBtn?.addEventListener("click", () => window.close());
const remove = window.petSettings.onIdleDwellState(
  (state: PetIdleDwellState) => {
    if (!validDwellSeconds(state.dwellSeconds)) return;
    confirmed = state.dwellSeconds;
    if (input) input.value = String(state.dwellSeconds);
    showError("");
  },
);
window.addEventListener("unload", remove, { once: true });
