import { STORAGE_PREFIX, STORAGE_SCHEMA } from './constants.js';
export function loadPersisted(sid) {
    try {
        const raw = localStorage.getItem(STORAGE_PREFIX + sid);
        if (!raw)
            return null;
        const p = JSON.parse(raw);
        if (p.schema !== STORAGE_SCHEMA || p.sid !== sid)
            return null;
        return Array.isArray(p.messages) ? p.messages : [];
    }
    catch {
        return null;
    }
}
export function savePersisted(sid, messages) {
    try {
        localStorage.setItem(STORAGE_PREFIX + sid, JSON.stringify({
            schema: STORAGE_SCHEMA,
            sid,
            savedAt: Date.now(),
            messages,
        }));
    }
    catch {
        /* quota/disabled: degrade to in-memory */
    }
}
