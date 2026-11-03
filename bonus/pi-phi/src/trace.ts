import { randomBytes } from 'node:crypto';

/**
 * Mint a W3C trace-context header for one bridge operation.
 *
 * A fresh trace id per request keeps one trace bounded to one operation instead
 * of a pane's whole lifetime, so a collector never sees a trace with hours of
 * spans. The span id is the caller's own span; Phi continues the trace from it.
 *
 * Absent or malformed headers are valid input for Phi — it falls back to the
 * stream span — so this never gates a message and never throws.
 */
export function mintTraceparent(): string {
    return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}
