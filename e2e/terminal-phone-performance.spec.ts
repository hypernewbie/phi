import { createHash } from "node:crypto";
import { expect, test, type WebSocketRoute } from "@playwright/test";
import { startPhi, type PhiServer } from "./_server.js";

let phi: PhiServer;
test.beforeAll(async () => {
  phi = await startPhi();
});
test.afterAll(async () => {
  await phi.stop();
});

interface ObservedTerminal {
  element?: HTMLElement;
  rows: number;
  options: { scrollback: number };
  buffer: {
    active: {
      type: string;
      length: number;
      baseY: number;
      getLine(
        i: number,
      ): { translateToString(trim?: boolean): string } | undefined;
    };
  };
  write(data: string | Uint8Array, callback?: () => void): void;
  loadAddon(addon: ObservedAddon): void;
}
interface ObservedAddon {
  serialize?: (...args: unknown[]) => string;
}
interface Timing {
  at: number;
  ms: number;
}
interface PhoneMetrics {
  maxLag: number;
  maxRuntimeLag: number;
  firstWriteAt: number;
  received: number;
  pending: number;
  term: ObservedTerminal | null;
  tasks: Timing[];
  batches: Timing[];
  snapshots: Timing[];
  tape: string[];
}
interface Checkpoint {
  through: number;
  cols: number;
  rows: number;
  ansi: string;
}

// CPU throttling exercises a slow phone, not just a touch flag. Startup
// compilation is recorded separately from terminal work, so these tests do
// not mistake unrelated page compilation for a terminal parser stall.
for (const alternate of [false, true]) {
  test(`phone ${alternate ? "alternate" : "normal"} replay and checkpoint keep the event loop responsive`, async ({
    browser,
  }, info) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    const pane = "phone-performance";
    // ANSI is ineligible for the plain-text tail shortcut. Normal
    // scrollback remains present even when the alternate buffer is live.
    const text =
      Array.from(
        { length: 10000 },
        (_, i) =>
          `\x1b[38;2;120;80;200mPHONE ${String(i).padStart(5, "0")} ${"x".repeat(60)}\x1b[0m\r\n`,
      ).join("") +
      (alternate ? "\x1b[?1049h" : "") +
      "PHONE NEWEST\r\n";
    const bytes = Buffer.from(text);
    let retained = bytes;
    await page.addInitScript((id) => {
      const w = window as unknown as {
        phonePerf: PhoneMetrics;
        Terminal: new (options: Record<string, unknown>) => ObservedTerminal;
      };
      w.phonePerf = {
        maxLag: 0,
        maxRuntimeLag: 0,
        firstWriteAt: 0,
        received: 0,
        pending: 0,
        term: null,
        tasks: [],
        batches: [],
        snapshots: [],
        tape: [],
      };
      new PerformanceObserver((list) => {
        for (const task of list.getEntries())
          w.phonePerf.tasks.push({
            at: task.startTime,
            ms: task.duration,
          });
      }).observe({ type: "longtask", buffered: true });
      let last = performance.now();
      setInterval(() => {
        const now = performance.now();
        const p = w.phonePerf;
        p.maxLag = Math.max(p.maxLag, now - last - 25);
        if (p.firstWriteAt && last >= p.firstWriteAt)
          p.maxRuntimeLag = Math.max(p.maxRuntimeLag, now - last - 25);
        last = now;
      }, 25);
      let ctor: typeof w.Terminal;
      Object.defineProperty(window, "Terminal", {
        configurable: true,
        get: () => ctor,
        set: (base: typeof w.Terminal) => {
          ctor = class extends base {
            constructor(options: Record<string, unknown>) {
              super(options);
              w.phonePerf.term = this;
            }
            loadAddon(addon: ObservedAddon) {
              if (addon.serialize) {
                const serialize = addon.serialize.bind(addon);
                addon.serialize = (...args: unknown[]) => {
                  const at = performance.now();
                  const result = serialize(...args);
                  w.phonePerf.snapshots.push({
                    at,
                    ms: performance.now() - at,
                  });
                  return result;
                };
              }
              super.loadAddon(addon);
            }
            write(data: string | Uint8Array, callback?: () => void) {
              if (
                this.element &&
                this.element.closest(".term-container")?.id !== `term-${id}`
              ) {
                super.write(data, callback);
                return;
              }
              const p = w.phonePerf;
              const at = performance.now();
              p.firstWriteAt ||= at;
              p.term = this;
              const decoded =
                typeof data === "string"
                  ? data
                  : new TextDecoder().decode(data);
              p.tape.push(decoded);
              p.received += new TextEncoder().encode(decoded).length;
              p.pending++;
              super.write(data, () => {
                p.batches.push({
                  at,
                  ms: performance.now() - at,
                });
                p.pending--;
                callback?.();
              });
            }
          };
        },
      });
    }, pane);
    await page.route("**/api/terminals", (route) =>
      route.fulfill({
        json: [
          {
            id: pane,
            title: "Phone performance",
            coder: "bash",
            cwd: phi.dir,
            workspace: phi.dir,
            pinned: true,
          },
        ],
      }),
    );
    await page.route(`**/api/terminals/${pane}/**`, (route) =>
      route.fulfill({ json: {} }),
    );
    let checkpoint: Checkpoint | undefined;
    await page.route(`**/api/terminals/${pane}/checkpoint`, async (route) => {
      checkpoint = route.request().postDataJSON();
      await route.fulfill({ json: {} });
    });
    await page.route(`**/api/terminals/${pane}/recording?*`, (route) => {
      const query = new URL(route.request().url()).searchParams;
      const from = Number(query.get("from"));
      const end = Math.min(Number(query.get("through")), retained.length);
      const hdr = Buffer.from(
        JSON.stringify({ epoch: 7, start: from, end, resizes: [] }),
      );
      const size = Buffer.alloc(4);
      size.writeUInt32BE(hdr.length);
      return route.fulfill({
        contentType: "application/octet-stream",
        body: Buffer.concat([size, hdr, retained.subarray(from, end)]),
      });
    });
    let liveSocket: WebSocketRoute | undefined;
    await page.routeWebSocket(`**/ws/pane/${pane}?*`, (socket) => {
      liveSocket = socket;
      const ansi = checkpoint ? Buffer.from(checkpoint.ansi) : Buffer.alloc(0);
      const hdr = Buffer.from(
        JSON.stringify({
          epoch: 7,
          oldest: 0,
          head: retained.length,
          ...(checkpoint
            ? {
                ckpt: {
                  through: checkpoint.through,
                  cols: checkpoint.cols,
                  rows: checkpoint.rows,
                  len: ansi.length,
                },
              }
            : {}),
        }),
      );
      const size = Buffer.alloc(5);
      size[0] = 8;
      size.writeUInt32BE(hdr.length, 1);
      socket.send(Buffer.concat([size, hdr, ansi]));
    });
    const visible = () =>
      page.evaluate(() => {
        const p = (window as unknown as { phonePerf: PhoneMetrics }).phonePerf;
        const t = p.term;
        return t && p.pending === 0
          ? Array.from({ length: t.rows }, (_, i) =>
              t.buffer.active
                .getLine(t.buffer.active.baseY + i)
                ?.translateToString(true),
            )
          : [];
      });
    try {
      const start = Date.now();
      await page.goto(phi.url);
      await expect(page.locator(`#term-${pane}`)).toBeVisible();
      await expect.poll(visible, { timeout: 60000 }).toContain("PHONE NEWEST");
      const replayMs = Date.now() - start;
      // Quiet raw attaches also upload a checkpoint, not only live writes.
      await expect
        .poll(() => checkpoint?.through, { timeout: 30000 })
        .toBe(bytes.length);
      const live = Buffer.from("LIVE AFTER REPLAY\r\n");
      const frame = Buffer.alloc(9);
      frame[0] = 9;
      frame.writeBigUInt64BE(BigInt(bytes.length), 1);
      retained = Buffer.concat([bytes, live]);
      liveSocket?.send(Buffer.concat([frame, live]));
      await expect
        .poll(() => checkpoint?.through, { timeout: 30000 })
        .toBe(retained.length);
      const stats = await page.evaluate(async () => {
        const p = (window as unknown as { phonePerf: PhoneMetrics }).phonePerf;
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(p.tape.join("")),
        );
        return {
          maxTask: Math.max(0, ...p.tasks.map((t) => t.ms)),
          maxRuntimeTask: Math.max(
            0,
            ...p.tasks.filter((t) => t.at >= p.firstWriteAt).map((t) => t.ms),
          ),
          maxLag: p.maxLag,
          maxRuntimeLag: p.maxRuntimeLag,
          received: p.received,
          writes: p.batches.length,
          rows: p.term?.buffer.active.length ?? 0,
          budget: p.term?.options.scrollback ?? 0,
          digest: Array.from(new Uint8Array(digest), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join(""),
          tasks: p.tasks,
          batches: p.batches,
          snapshots: p.snapshots,
        };
      });
      const evidence = {
        ...stats,
        replayMs,
        sourceBytes: retained.length,
        checkpointBytes: Buffer.byteLength(checkpoint?.ansi ?? ""),
      };
      await info.attach("phone-performance.json", {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      });
      console.log("PHONE PERFORMANCE", {
        replayMs,
        maxRuntimeTask: stats.maxRuntimeTask,
        maxRuntimeLag: stats.maxRuntimeLag,
        checkpointBytes: evidence.checkpointBytes,
      });
      expect(stats.received).toBe(retained.length);
      expect(stats.digest).toBe(
        createHash("sha256").update(retained).digest("hex"),
      );
      expect(stats.rows).toBeLessThanOrEqual(stats.budget + 100);
      // Timing numbers are benchmark results, never pass/fail gates:
      // shared CI runners measure 2-4x slower than real hardware with
      // identical code. They stay attached as evidence above.
      expect(
        evidence.checkpointBytes,
        "phone restore must not copy the archive",
      ).toBeLessThan(32768);
      await page.reload();
      await expect
        .poll(visible, { timeout: 15000 })
        .toContain("LIVE AFTER REPLAY");
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { phonePerf: PhoneMetrics }).phonePerf.term
              ?.buffer.active.type,
        ),
      ).toBe(alternate ? "alternate" : "normal");
    } finally {
      await context.close();
    }
  });
}
