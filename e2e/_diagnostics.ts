/**
 * Diagnostics classification for the list-title-wrap fixture harness.
 *
 * Kept here (not inside the spec) so the classification rules are
 * unit-tested: the teardown-abort rule below is what let a CI-load flake
 * bury the REAL test failure under an AggregateError of cleanup noise.
 */

export type DiagnosticEntry = {
    phase: string;
    // Loose on purpose: the spec's collector types `kind` as a bare
    // string; the classifier only ever compares it against literals.
    kind: string;
    message: string;
    url?: string;
    requestId?: number | null;
    classification?: string;
};

export type DiagnosticsLike = {
    entries: DiagnosticEntry[];
    pinRequests: Array<{
        classification?: string;
        requestId: number;
    }>;
};

/**
 * Entries the harness treats as proof something went wrong.
 *
 * An unclassified entry is unexpected — EXCEPT an aborted request in two
 * expected shapes:
 *
 * 1. `known-pin-completion` — a pin request whose terminal failure the
 *    fixture already understood and classified.
 *
 * 2. A TEARDOWN-phase `net::ERR_ABORTED` — `withFixture` flips every
 *    tracker to the teardown phase BEFORE `context.close()`, and closing
 *    a context aborts every in-flight request: long-lived attaches (the
 *    pane replay) die with ERR_ABORTED by design. Reporting them as
 *    cleanup errors produced CI flakes whose AggregateError message
 *    ("test failed and fixture cleanup reported errors") REPLACED the
 *    real assertion failure in the report. A teardown abort is not a
 *    signal; an abort in ANY live phase still is.
 */
export function unexpectedDiagnostics(
    diagnostics: DiagnosticsLike[],
): DiagnosticEntry[] {
    const knownIds = new Set(
        diagnostics.flatMap((item) =>
            item.pinRequests
                .filter(
                    (request) =>
                        request.classification === 'known-pin-completion',
                )
                .map((request) => request.requestId),
        ),
    );
    return diagnostics.flatMap((item) =>
        item.entries.filter((entry) => {
            if (entry.classification) return false;
            if (
                entry.kind === 'request-failed' &&
                entry.message === 'net::ERR_ABORTED'
            ) {
                // Expected teardown abort, or a pin completion the fixture
                // already classified — never a signal.
                if (entry.phase === 'teardown') return false;
                if (
                    entry.requestId !== undefined &&
                    entry.requestId !== null &&
                    knownIds.has(entry.requestId)
                )
                    return false;
            }
            return true;
        }),
    );
}
