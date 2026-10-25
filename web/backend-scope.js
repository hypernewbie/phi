/**
 * Scopes network requests, timers, and event listeners to an active backend profile.
 * When the scope is aborted (e.g. during profile switch or teardown), in-flight fetches
 * are aborted, pending intervals/timeouts are cleared, and event listeners are unregistered.
 */
export class BackendScope {
    profileId;
    origin;
    controller = new AbortController();
    timers = new Set();
    constructor(profileId = '', origin = '') {
        this.profileId = profileId;
        this.origin = origin;
    }
    get signal() {
        return this.controller.signal;
    }
    get aborted() {
        return this.controller.signal.aborted;
    }
    headers(extra) {
        const out = {};
        if (extra) {
            if (typeof Headers !== 'undefined' && extra instanceof Headers) {
                extra.forEach((value, key) => {
                    out[key] = value;
                });
            }
            else if (Array.isArray(extra)) {
                for (const [key, value] of extra) {
                    out[key] = value;
                }
            }
            else if (typeof extra === 'object') {
                for (const [key, value] of Object.entries(extra)) {
                    if (value !== undefined) {
                        out[key] = String(value);
                    }
                }
            }
        }
        if (this.profileId && !out['X-Phi-Backend'] && !out['x-phi-backend']) {
            out['X-Phi-Backend'] = this.profileId;
        }
        return out;
    }
    async fetch(url, init = {}) {
        if (this.aborted) {
            throw new DOMException('BackendScope aborted', 'AbortError');
        }
        const mergedHeaders = this.headers(init.headers);
        const res = await globalThis.fetch(url, {
            ...init,
            headers: mergedHeaders,
            signal: this.signal,
        });
        if (this.aborted) {
            throw new DOMException('BackendScope aborted', 'AbortError');
        }
        return res;
    }
    async fetchText(url, init = {}) {
        const res = await this.fetch(url, init);
        if (!res.ok) {
            const err = new Error(`HTTP ${res.status}`);
            err.status = res.status;
            throw err;
        }
        const text = await res.text();
        if (this.aborted) {
            throw new DOMException('BackendScope aborted', 'AbortError');
        }
        return text;
    }
    interval(fn, ms) {
        if (this.aborted) {
            return 0;
        }
        const cleanup = () => {
            clearInterval(id);
            this.timers.delete(cleanup);
        };
        const id = setInterval(() => {
            if (this.aborted) {
                cleanup();
                return;
            }
            fn();
        }, ms);
        this.timers.add(cleanup);
        return id;
    }
    timeout(fn, ms) {
        if (this.aborted) {
            return 0;
        }
        const cleanup = () => {
            clearTimeout(id);
            this.timers.delete(cleanup);
        };
        const id = setTimeout(() => {
            this.timers.delete(cleanup);
            if (!this.aborted) {
                fn();
            }
        }, ms);
        this.timers.add(cleanup);
        return id;
    }
    listen(target, event, handler, opts) {
        if (this.aborted) {
            return;
        }
        const options = {
            ...(typeof opts === 'object' ? opts : { capture: Boolean(opts) }),
            signal: this.signal,
        };
        target.addEventListener(event, handler, options);
    }
    abort() {
        if (this.aborted) {
            return;
        }
        this.controller.abort();
        for (const cleanup of Array.from(this.timers)) {
            try {
                cleanup();
            }
            catch { }
        }
        this.timers.clear();
    }
}
