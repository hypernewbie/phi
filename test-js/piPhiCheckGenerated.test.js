// Isolated regression for the generated-assets drift gate: consistent
// outputs must pass and stale/missing/stray outputs must fail, without
// Git and without touching the active source tree. Uses owned temporary
// fixtures only; the full gate still runs via pnpm check:pi-phi-generated.
// The second block covers actual fresh-generation file-set behavior
// through the generator's real output-clearing step.
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    GENERATED_OUTPUT_DIRS,
    clearGeneratedOutputs,
} from '../scripts/pi-phi-generate.mjs';
import {
    diffSnapshots,
    snapshotTree,
} from '../scripts/pi-phi-check-generated.mjs';

const owned = [];
afterEach(() => {
    while (owned.length > 0)
        rmSync(owned.pop(), { recursive: true, force: true });
});

function fixture(files) {
    const dir = mkdtempSync(join(tmpdir(), 'phi-gen-check-'));
    owned.push(dir);
    for (const [name, bytes] of Object.entries(files)) {
        writeFileSync(join(dir, name), bytes);
    }
    return dir;
}

describe('pi-phi generated drift comparison', () => {
    it('passes consistent outputs', () => {
        const dir = fixture({ 'bridge.ts': 'v1', 'nested.pb.go': 'v2' });
        const before = snapshotTree(dir);
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual([]);
    });

    it('fails stale bytes', () => {
        const dir = fixture({ 'bridge.ts': 'v1' });
        const before = snapshotTree(dir);
        writeFileSync(join(dir, 'bridge.ts'), 'v2');
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual([
            'bytes differ: bridge.ts',
        ]);
    });

    it('fails outputs missing from the worktree', () => {
        const dir = fixture({ 'bridge.ts': 'v1' });
        const before = snapshotTree(dir);
        rmSync(join(dir, 'bridge.ts'));
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual([
            'only in worktree: bridge.ts',
        ]);
    });

    it('fails outputs missing before regeneration', () => {
        const dir = fixture({});
        const before = snapshotTree(dir);
        writeFileSync(join(dir, 'bridge.ts'), 'v1');
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual([
            'only after regeneration: bridge.ts',
        ]);
    });

    it('treats a missing directory as an empty snapshot', () => {
        const base = mkdtempSync(join(tmpdir(), 'phi-gen-check-'));
        owned.push(base);
        const dir = join(base, 'absent');
        expect(snapshotTree(dir).size).toBe(0);
        expect(diffSnapshots(snapshotTree(dir), snapshotTree(dir))).toEqual([]);
    });

    it('fails a symlink in a generated tree', () => {
        const dir = fixture({ 'bridge.ts': 'v1' });
        symlinkSync(join(dir, 'bridge.ts'), join(dir, 'stray.ts'));
        const before = snapshotTree(dir);
        // Regeneration writes regular files only, so the link vanishes
        // and the gate must report it instead of silently agreeing.
        rmSync(join(dir, 'stray.ts'));
        expect(diffSnapshots(before, snapshotTree(dir))).toEqual([
            'only in worktree: stray.ts',
        ]);
    });

    it('fails a generated root that is itself a symlink', () => {
        const base = mkdtempSync(join(tmpdir(), 'phi-gen-check-'));
        owned.push(base);
        const real = join(base, 'real');
        mkdirSync(real);
        writeFileSync(join(real, 'bridge.ts'), 'v1');
        const linked = join(base, 'gen');
        symlinkSync(real, linked);
        // Read through the link the file set looks identical to the
        // regeneration, so the root entry itself must carry the drift.
        expect(diffSnapshots(snapshotTree(linked), snapshotTree(real))).toEqual(
            ['only after regeneration: bridge.ts', 'only in worktree: .'],
        );
    });
});

// Canonical bytes stand in for buf's deterministic generation. The
// clear step is the real one from the generator: this block fails if
// generation ever stops clearing a generated tree before writing.
const CANONICAL = {
    'internal/pibridge/pb/bridge.pb.go': 'go-bytes',
    'internal/pibridge/pb/bridge_grpc.pb.go': 'go-grpc-bytes',
    'bonus/pi-phi/src/gen/bridge.ts': 'ts-bytes',
};

function repoRoot(files) {
    const dir = mkdtempSync(join(tmpdir(), 'phi-gen-fresh-'));
    owned.push(dir);
    for (const [name, bytes] of Object.entries(files)) {
        const abs = join(dir, name);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, bytes);
    }
    return dir;
}

function snapshotOutputs(dir) {
    const out = new Map();
    for (const gen of GENERATED_OUTPUT_DIRS) {
        for (const [name, bytes] of snapshotTree(join(dir, gen))) {
            out.set(`${gen}/${name}`, bytes);
        }
    }
    return out;
}

function freshGenerate(dir) {
    clearGeneratedOutputs(dir);
    for (const [name, bytes] of Object.entries(CANONICAL)) {
        const abs = join(dir, name);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, bytes);
    }
}

describe('pi-phi fresh-generation file-set drift', () => {
    it('passes consistent outputs', () => {
        const dir = repoRoot({ ...CANONICAL });
        const before = snapshotOutputs(dir);
        freshGenerate(dir);
        expect(diffSnapshots(before, snapshotOutputs(dir))).toEqual([]);
    });

    it('fails stale bytes', () => {
        const dir = repoRoot({
            ...CANONICAL,
            'bonus/pi-phi/src/gen/bridge.ts': 'stale',
        });
        const before = snapshotOutputs(dir);
        freshGenerate(dir);
        expect(diffSnapshots(before, snapshotOutputs(dir))).toEqual([
            'bytes differ: bonus/pi-phi/src/gen/bridge.ts',
        ]);
    });

    it('fails outputs missing from the worktree', () => {
        const rest = { ...CANONICAL };
        delete rest['internal/pibridge/pb/bridge.pb.go'];
        const dir = repoRoot(rest);
        const before = snapshotOutputs(dir);
        freshGenerate(dir);
        expect(diffSnapshots(before, snapshotOutputs(dir))).toEqual([
            'only after regeneration: internal/pibridge/pb/bridge.pb.go',
        ]);
    });

    it('fails extra outputs in either generated tree', () => {
        const dir = repoRoot({
            ...CANONICAL,
            'internal/pibridge/pb/stray.pb.go': 'stray',
            'bonus/pi-phi/src/gen/stray.ts': 'stray',
        });
        const before = snapshotOutputs(dir);
        freshGenerate(dir);
        // The real clear step removes both strays, so the fresh set
        // exposes them. A TS-only clear would let the Go stray
        // survive both snapshots and escape detection.
        expect(diffSnapshots(before, snapshotOutputs(dir))).toEqual([
            'only in worktree: bonus/pi-phi/src/gen/stray.ts',
            'only in worktree: internal/pibridge/pb/stray.pb.go',
        ]);
    });
});
