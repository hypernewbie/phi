// @vitest-environment node
//
// ─────────────────────────────────────────────────────────────────────────
// FUNDAMENTAL CONTRACT — DO NOT CHANGE.
//
// The e2e fixture harness must REPORT THE REAL FAILURE. Two rules pin
// that (e2e/_diagnostics.ts, used by list-title-wrap.spec.ts):
//
//   1. A teardown-phase net::ERR_ABORTED is expected: withFixture flips
//      every diagnostics tracker to 'teardown' BEFORE context.close(),
//      and closing a context aborts every in-flight request — the pane
//      replay attach dies with ERR_ABORTED by design. Counting it as a
//      cleanup error once produced CI flakes whose AggregateError
//      ("test failed and fixture cleanup reported errors") REPLACED the
//      failing assertion in the report.
//   2. An abort in any LIVE phase is still a signal, and so is every
//      other unclassified entry. Nothing else may be silenced.
//
// If a change makes any case here fail, the change is wrong — not the
// test.
// ─────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from 'vitest';
import { unexpectedDiagnostics } from '../e2e/_diagnostics.js';

function tracker(entries, pinRequests = []) {
    return { entries, pinRequests };
}

describe('unexpectedDiagnostics (e2e teardown classification)', () => {
    it('a teardown-phase ERR_ABORTED is expected, with or without a request id', () => {
        const out = unexpectedDiagnostics([
            tracker([
                {
                    phase: 'teardown',
                    kind: 'request-failed',
                    message: 'net::ERR_ABORTED',
                    url: 'http://127.0.0.1:1/api/terminals/fixture-long/replay',
                    requestId: 41,
                },
                {
                    phase: 'teardown',
                    kind: 'request-failed',
                    message: 'net::ERR_ABORTED',
                    url: 'http://127.0.0.1:1/api/sessions',
                },
            ]),
        ]);
        expect(out).toEqual([]);
    });

    it('an ERR_ABORTED in a live phase is still a signal (unknown request id)', () => {
        const out = unexpectedDiagnostics([
            tracker([
                {
                    phase: 'online',
                    kind: 'request-failed',
                    message: 'net::ERR_ABORTED',
                    requestId: 7,
                },
            ]),
        ]);
        expect(out).toHaveLength(1);
    });

    it('a known-pin-completion abort is expected in any phase', () => {
        const out = unexpectedDiagnostics([
            tracker(
                [
                    {
                        phase: 'offline',
                        kind: 'request-failed',
                        message: 'net::ERR_ABORTED',
                        requestId: 9,
                    },
                ],
                [{ classification: 'known-pin-completion', requestId: 9 }],
            ),
        ]);
        expect(out).toEqual([]);
    });

    it('every other unclassified entry stays unexpected', () => {
        const entries = [
            {
                phase: 'teardown',
                kind: 'page-error',
                message: 'Uncaught TypeError',
            },
            {
                phase: 'online',
                kind: 'request-failed',
                message: 'net::ERR_CONNECTION_REFUSED',
                requestId: 3,
            },
            {
                phase: 'teardown',
                kind: 'request-failed',
                message: 'net::ERR_TIMED_OUT',
                requestId: 4,
            },
            {
                phase: 'online',
                kind: 'external-request',
                message: 'Blocked non-fixture browser request',
            },
        ];
        expect(unexpectedDiagnostics([tracker(entries)])).toEqual(entries);
    });

    it('classified entries are never re-reported', () => {
        const out = unexpectedDiagnostics([
            tracker([
                {
                    phase: 'online',
                    kind: 'request-failed',
                    message: 'net::ERR_ABORTED',
                    requestId: 2,
                    classification: 'cancelled-session-list-read',
                },
            ]),
        ]);
        expect(out).toEqual([]);
    });
});
