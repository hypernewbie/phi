const MAX_PENDING = 100;
const MAX_ID_LENGTH = 64;
const MAX_PROFILE_ID_LENGTH = 512;
const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 2_000;
function isDesktopPage() {
    try {
        return (new URLSearchParams(window.location.search).get('desktop') ===
            '1' ||
            document.documentElement.hasAttribute('data-phi-desktop-root'));
    }
    catch {
        return false;
    }
}
/** Adds a bounded, page-owned preview. Native delivery is best-effort. */
export function queueDesktopNotification(preview) {
    try {
        if (!isDesktopPage())
            return;
        if (typeof preview.id !== 'string' ||
            preview.id.length === 0 ||
            preview.id.length > MAX_ID_LENGTH ||
            (preview.profileId !== null &&
                (typeof preview.profileId !== 'string' ||
                    preview.profileId.length === 0 ||
                    preview.profileId.length > MAX_PROFILE_ID_LENGTH)) ||
            (preview.type !== 'info' &&
                preview.type !== 'success' &&
                preview.type !== 'error') ||
            typeof preview.timestamp !== 'number' ||
            !Number.isFinite(preview.timestamp) ||
            typeof preview.title !== 'string' ||
            typeof preview.message !== 'string') {
            return;
        }
        const copy = {
            id: preview.id,
            profileId: preview.profileId,
            title: preview.title.slice(0, MAX_TITLE_LENGTH),
            message: preview.message.slice(0, MAX_MESSAGE_LENGTH),
            type: preview.type,
            timestamp: preview.timestamp,
        };
        const target = window;
        const current = target.__phiDesktopNotificationsV1;
        const pending = [];
        if (Array.isArray(current)) {
            const length = current.length;
            const start = Math.max(0, length - (MAX_PENDING - 1));
            for (let index = start; index < length; index += 1) {
                pending[pending.length] = current[index];
            }
        }
        pending[pending.length] = copy;
        target.__phiDesktopNotificationsV1 = pending;
    }
    catch {
        // A replaced or frozen page slot must not affect local notifications.
    }
}
