import { beforeEach, describe, expect, it, vi } from "vitest";

let request: ReturnType<typeof vi.fn>;
let stateListener: ((state: { dwellSeconds: number }) => void) | undefined;
let removeState: ReturnType<typeof vi.fn>;

async function loadView(query: string): Promise<HTMLInputElement> {
  window.history.replaceState({}, "", query);
  const input = document.createElement("input");
  input.id = "pet-idle-dwell";
  input.type = "number";
  input.min = "1";
  input.max = "3600";
  input.step = "1";
  const error = document.createElement("p");
  error.id = "pet-settings-error";
  document.body.replaceChildren(input, error);
  request = vi.fn((dwellSeconds: number) =>
    Promise.resolve({ dwellSeconds, accepted: true }),
  );
  stateListener = undefined;
  removeState = vi.fn();
  window.petSettings = {
    requestIdleDwellSeconds: request as unknown as (
      dwellSeconds: number,
    ) => Promise<{ dwellSeconds: number; accepted: boolean; error?: string }>,
    onIdleDwellState: (listener) => {
      stateListener = listener;
      return removeState as unknown as () => void;
    },
  };
  vi.resetModules();
  await import("../src/pet-settings-view.js");
  return document.getElementById("pet-idle-dwell") as HTMLInputElement;
}

beforeEach(() => {
  document.body.replaceChildren();
  window.history.replaceState({}, "", "/");
});

describe("pet settings renderer", () => {
  it.each([10, 1, 3600])(
    "selects the initial query value %i",
    async (value) => {
      const input = await loadView(`?petIdleDwellSeconds=${value}`);
      expect(input.value).toBe(String(value));
    },
  );

  it("falls back to 10 seconds for missing or out-of-range/malformed initial queries", async () => {
    expect((await loadView("/")).value).toBe("10");
    expect((await loadView("?petIdleDwellSeconds=3601")).value).toBe("10");
    expect((await loadView("?petIdleDwellSeconds=0")).value).toBe("10");
    expect((await loadView("?petIdleDwellSeconds=bad")).value).toBe("10");
  });

  it.each(["0", "3601", "10.5", "Infinity"])(
    "rejects invalid typed value %s without sending save IPC",
    async (value) => {
      const input = await loadView("?petIdleDwellSeconds=10");
      input.value = value;
      input.dispatchEvent(new Event("change"));
      await Promise.resolve();
      await Promise.resolve();
      expect(request).not.toHaveBeenCalled();
      expect(input.value).toBe("10");
      expect(
        document.getElementById("pet-settings-error")?.textContent,
      ).toContain("Invalid pet idle interval.");
    },
  );

  it("restores the confirmed selection and shows a non-blocking error for non-numeric input", async () => {
    const input = await loadView("?petIdleDwellSeconds=10");
    input.value = "abc";
    input.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(input.value).toBe("10");
    expect(
      document.getElementById("pet-settings-error")?.textContent,
    ).toContain("Invalid pet idle interval.");
  });

  it("restores the confirmed selection and shows a non-blocking persistence error", async () => {
    const input = await loadView("?petIdleDwellSeconds=10");
    request.mockResolvedValueOnce({
      dwellSeconds: 60,
      accepted: false,
      error: "Unable to save pet idle interval.",
    });
    input.value = "60";
    input.dispatchEvent(new Event("change"));
    await Promise.resolve();
    await Promise.resolve();
    expect(input.value).toBe("10");
    expect(
      document.getElementById("pet-settings-error")?.textContent,
    ).toContain("Unable to save");
  });

  it("ignores an invalid incoming state without canonicalizing the selection", async () => {
    const input = await loadView("?petIdleDwellSeconds=180");
    stateListener?.({ dwellSeconds: 3601 });
    expect(input.value).toBe("180");
  });

  it("updates from one valid state event and removes the listener on unload", async () => {
    const input = await loadView("?petIdleDwellSeconds=10");
    stateListener?.({ dwellSeconds: 180 });
    expect(input.value).toBe("180");
    window.dispatchEvent(new Event("unload"));
    expect(removeState).toHaveBeenCalledTimes(1);
  });
});
