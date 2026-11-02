import type { AuthPhase } from './auth-session.ts';

// Phi-served builds gate the legacy main page until auth resolves, then
// hand off to it like the old backend. `?stay=1` keeps the gate visible
// for review. Dev-proxy builds never navigate away.
export function resolveLegacyHandoff(
    directServe: boolean,
    phase: AuthPhase,
    search: string,
): boolean {
    if (!directServe || phase !== 'ready') return false;
    return !new URLSearchParams(search).has('stay');
}

export function isDirectServe(): boolean {
    return typeof __PHI_DIRECT_SERVE__ !== 'undefined' && __PHI_DIRECT_SERVE__;
}

// Direct-serve identity: the page origin is the server. Undefined keeps
// the baked dev-proxy default in the factories.
export function directUpstreamOrigin(): string | undefined {
    return isDirectServe() ? window.location.origin : undefined;
}

export function currentSearch(): string {
    return window.location.search;
}

export function navigateToLegacyMain(): void {
    window.location.assign('/');
}
