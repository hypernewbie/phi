// Global toast-discipline setup. Runs before EVERY test file under ALL
// circumstances (vitest setupFiles): strict rate-limit mode is always
// on, and the violation log is always fresh.
//
// Congressional rule: the same toast twice within 2s is a violation.
// NotificationManager.show() throws on violation in strict mode, so
// the offending test fails at the emission site. The afterEach below
// is the backstop: if app code swallows the throw, the recorded
// violation still fails the test here. There is no opt-out.
import { afterEach, beforeEach } from 'vitest';

function disciplineGlobal() {
    if (typeof globalThis !== 'object' || globalThis === null) return null;
    return globalThis;
}

beforeEach(() => {
    const g = disciplineGlobal();
    if (!g) return;
    g.__phiToastStrict = true;
    g.__phiToastViolations = [];
});

afterEach(() => {
    const g = disciplineGlobal();
    if (!g) return;
    const violations = g.__phiToastViolations;
    if (Array.isArray(violations) && violations.length > 0) {
        const sigs = [
            ...new Set(
                violations.map((v) =>
                    v && typeof v.sig === 'string' ? v.sig : '?',
                ),
            ),
        ].join(', ');
        throw new Error(
            `toast discipline: ${violations.length} duplicate toast(s) within 2s during this test: ${sigs}`,
        );
    }
});
