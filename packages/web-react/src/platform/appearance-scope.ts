// Appearance scope, profile, and storage keys. Mirrors
// web/mobile-appearance.js + web/backend-scope.js naming so shared
// localStorage keys and channel owners stay byte-identical.
export interface AppearanceScope {
    readonly profileId: string;
    readonly pageOrigin: string;
    readonly backendOrigin: string;
}

const PROFILE_KEY = 'phi_appearance_profile';

let memoryOverride: string | null = null;

function searchParams(): URLSearchParams {
    return new URLSearchParams(window.location.search);
}

function isEmbedded(): boolean {
    return (
        searchParams().get('embedded') === '1' ||
        window.location.protocol === 'phi-app:'
    );
}

function isNative(): boolean {
    const params = searchParams();
    return (
        params.get('desktop') === '1' ||
        params.get('desktop-popout') === '1' ||
        (window as unknown as Record<string, unknown>).__phiDesktop !==
            undefined ||
        window.location.protocol === 'phi-app:'
    );
}

// Null when embedded settings lack their backend identity: syncing
// without an owner would corrupt another backend's state.
export function readAppearanceScope(): AppearanceScope | null {
    const pageOrigin = window.location.origin;
    if (!isEmbedded())
        return { profileId: '', pageOrigin, backendOrigin: pageOrigin };
    const params = searchParams();
    const profileId = params.get('profile') || '';
    const origin = params.get('origin') || '';
    if (profileId === '' || origin === '') return null;
    let backendOrigin: string;
    try {
        const url = new URL(origin);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        backendOrigin = url.origin;
    } catch {
        return null;
    }
    return { profileId, pageOrigin, backendOrigin };
}

export function appearanceOwner(scope: AppearanceScope): string {
    return JSON.stringify([
        scope.pageOrigin,
        scope.profileId,
        scope.backendOrigin,
    ]);
}

export function legacyAppearanceKey(scope: AppearanceScope): string {
    return scope.profileId !== ''
        ? `phi:desktop-appearance:v1:${appearanceOwner(scope)}`
        : 'phi_appearance';
}

export type ProfileOverride = 'auto' | 'desktop' | 'mobile';

export function readProfileOverride(
    storage: Pick<Storage, 'getItem'> | null | undefined = localStorage,
): ProfileOverride {
    if (memoryOverride !== null)
        return memoryOverride === 'desktop' || memoryOverride === 'mobile'
            ? memoryOverride
            : 'auto';
    if (storage === null || storage === undefined) return 'auto';
    try {
        const value = storage.getItem(PROFILE_KEY);
        return value === 'desktop' || value === 'mobile' ? value : 'auto';
    } catch {
        return 'auto';
    }
}

// True when persisted; false means memory-only (storage denied).
export function writeProfileOverride(
    value: string,
    storage: Pick<Storage, 'setItem'> | null | undefined = localStorage,
): boolean {
    memoryOverride = value;
    if (storage === null || storage === undefined) return false;
    try {
        storage.setItem(PROFILE_KEY, value);
        return true;
    } catch {
        return false;
    }
}

export function currentProfile(): 'desktop' | 'mobile' {
    if (isNative()) return 'desktop';
    const override = readProfileOverride();
    if (override === 'desktop' || override === 'mobile') return override;
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
        ? 'mobile'
        : 'desktop';
}

export function isNativeContext(): boolean {
    return isNative();
}
