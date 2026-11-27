// THE TOAST BALLOT BOX.
//
// Congressional toast discipline: NO new toast without going through
// congress and an election. Concretely, that means:
//
//   1. DEBATE — add your key here with a justification of at least
//      24 characters explaining why this popup must exist at all.
//      "Why not the notification drawer? Why not the status bar?
//      Why must it interrupt?" If you cannot answer, no toast.
//   2. VOTE — pass `key: '<your-key>'` at the showToast call site,
//      then amend TOAST_CALL_SITE_COUNT in
//      test-js/toastDiscipline.test.js. That count is frozen; bumping
//      it is the vote, and it is reviewable in one line.
//   3. TERM LIMIT — the same key (or the same unkeyed title+message)
//      may not appear twice within 2000ms. The second emission is
//      dropped in production and THROWS in tests (global setup), so a
//      duplicate fails whichever test triggers it.
//
// Unkeyed legacy call sites keep rendering, but the frozen count means
// no NEW unkeyed toast can ever slip in unnoticed. Keys are
// kebab-case; justifications are permanent congressional record.

// Key -> justification. Deliberately empty at ratification: every
// future toast starts its campaign here.
export const TOAST_REGISTRY: Record<string, string> = {};

export function isRegisteredToastKey(key: unknown): key is string {
    return (
        typeof key === 'string' &&
        key !== '' &&
        Object.hasOwn(TOAST_REGISTRY, key)
    );
}

export function toastKeyJustification(key: string): string | null {
    if (!isRegisteredToastKey(key)) return null;
    return TOAST_REGISTRY[key];
}
