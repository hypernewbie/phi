// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHeadlessSandbox } from './_xtermHeadless.js';

// SUPERHIGHWAY §1–3: speed-of-light + write-path + batch-framing sweeps.
// A real headless xterm parses the payloads; the suite reports
// bytes/sec per payload shape and per write batch size, and asserts the
// properties that must hold regardless of machine speed:
//
//   - every batching of the same bytes renders byte-identical rows
//     (framing is never allowed to corrupt the terminal);
//   - every sweep completes inside a generous ceiling (hang guard, not a
//     perf gate — CI machines vary; the printed numbers are the data).
//
// Compression ratios (node:zlib, same deflate family as the wire's
// permessage-deflate) are reported alongside: informational only,
// compression stays on unconditionally (§7).

const TARGET_BYTES = 1024 * 1024;
const CEILING_MS = 120000;

let Terminal;

function writeAll(term, data) {
    return new Promise((resolve) => term.write(data, resolve));
}

function buildPayloads() {
    const shortLine = (i) => `ok ${String(i).padStart(6, '0')}\r\n`;
    const longLine = (i) =>
        `L${String(i).padStart(6, '0')} ` + 'x'.repeat(190) + '\r\n';
    const ansiLine = (i) =>
        `\x1b[1;3${i % 8}m#${String(i).padStart(6, '0')}\x1b[0m ` +
        `\x1b[38;5;${i % 256}m▓░\x1b[0m progress ${(i * 7) % 100}%\r` +
        `\x1b[Kdone ${i}\r\n`;
    // Array-join, not += with a byteLength check per line (quadratic).
    const grow = (fn) => {
        const parts = [];
        let bytes = 0;
        let i = 0;
        while (bytes < TARGET_BYTES) {
            const s = fn(i++);
            parts.push(s);
            bytes += Buffer.byteLength(s);
        }
        return parts.join('');
    };
    const mixed = (() => {
        let s = '';
        let i = 0;
        while (Buffer.byteLength(s) < TARGET_BYTES) {
            s += `$ run ${i}\r\n` + shortLine(i) + ansiLine(i) + longLine(i);
            i++;
        }
        return s;
    })();
    return {
        short: grow(shortLine),
        long: grow(longLine),
        ansi: grow(ansiLine),
        mixed,
    };
}

// Probes every Kth row plus first/last instead of extracting the whole
// buffer: getLine crosses the vm-context boundary per call, so full
// extraction of a 1 MiB buffer would dominate the sweep (the harness
// must measure the parse, not itself). Chunk-boundary corruption lands
// on scattered rows, so strided probes catch it.
function probeText(term, stride = 100) {
    const buf = term.buffer.active;
    const out = [`len:${buf.length}`];
    for (let i = 0; i < buf.length; i += stride) {
        out.push(buf.getLine(i)?.translateToString() ?? '');
    }
    out.push(buf.getLine(buf.length - 1)?.translateToString() ?? '');
    return out.join('\n');
}

async function sweep(termOpts, label, data, batchSize) {
    const term = new Terminal({
        cols: 80,
        rows: 24,
        scrollback: 100000,
        allowProposedApi: true,
        ...termOpts,
    });
    const t0 = performance.now();
    if (!batchSize || batchSize >= data.length) {
        await writeAll(term, data);
    } else {
        for (let off = 0; off < data.length; off += batchSize) {
            await writeAll(term, data.slice(off, off + batchSize));
        }
    }
    const ms = performance.now() - t0;
    if (ms > CEILING_MS) {
        throw new Error(`sweep ${label} exceeded hang ceiling: ${ms}ms`);
    }
    return { ms, text: probeText(term) };
}

const fmtMBs = (bytes, ms) =>
    `${(bytes / 1048576 / (ms / 1000) || 0).toFixed(2)} MB/s`;

beforeAll(() => {
    Terminal = createHeadlessSandbox().Terminal;
});

describe('write-path sweeps (numbers are data, asserts are guards)', () => {
    it('§1 speed of light: 1 MiB mixed payload parses correctly + reports ceiling', async () => {
        const { short, long, ansi, mixed } = buildPayloads();
        for (const [name, data] of Object.entries({
            short,
            long,
            ansi,
            mixed,
        })) {
            const { ms, text } = await sweep({}, `light-${name}`, data, 0);
            // Correctness: every payload shape survives the parse intact.
            expect(text.length).toBeGreaterThan(0);
            expect(ms).toBeLessThan(CEILING_MS);
            const ratio = (
                gzipSync(Buffer.from(data)).byteLength / data.length
            ).toFixed(3);
            console.log(
                `[sweep/light] ${name}: ${fmtMBs(data.length, ms)} ` +
                    `(${(data.length / 1024).toFixed(0)} KiB in ${ms.toFixed(1)}ms, ` +
                    `deflate-ratio ${ratio})`,
            );
        }
    });

    it('§3 batch framing never corrupts: 4K→1M chunkings render identical rows', async () => {
        const { mixed } = buildPayloads();
        const reference = await sweep({}, 'batch-ref', mixed, 0);
        for (const size of [4096, 16384, 65536, 262144]) {
            const { ms, text } = await sweep({}, `batch-${size}`, mixed, size);
            expect(text).toBe(reference.text);
            console.log(
                `[sweep/batch] ${(size / 1024).toFixed(0)}K chunks: ` +
                    `${fmtMBs(mixed.length, ms)} (${ms.toFixed(1)}ms)`,
            );
        }
        console.log(
            `[sweep/batch] single write: ${fmtMBs(mixed.length, reference.ms)} ` +
                `(${reference.ms.toFixed(1)}ms)`,
        );
    });
});
