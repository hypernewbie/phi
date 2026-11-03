// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
    appearanceOwner,
    legacyAppearanceKey,
    readAppearanceScope,
} from '../src/platform/appearance-scope.ts';
import { broadcastConfigSync } from '../src/platform/config-sync.ts';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

it('formats the owner exactly like legacy', () => {
    expect(
        appearanceOwner({
            profileId: 'p1',
            pageOrigin: 'http://page.invalid',
            backendOrigin: 'http://backend.invalid',
        }),
    ).toBe(
        JSON.stringify(['http://page.invalid', 'p1', 'http://backend.invalid']),
    );
});

it('reads an unscoped scope on a plain page', () => {
    expect(readAppearanceScope()).toEqual({
        profileId: '',
        pageOrigin: window.location.origin,
        backendOrigin: window.location.origin,
    });
});

it('uses the shared key unscoped and the owner key scoped', () => {
    expect(
        legacyAppearanceKey({
            profileId: '',
            pageOrigin: 'http://a',
            backendOrigin: 'http://a',
        }),
    ).toBe('phi_appearance');
    const scoped = {
        profileId: 'p1',
        pageOrigin: 'http://a',
        backendOrigin: 'http://b',
    };
    expect(legacyAppearanceKey(scoped)).toBe(
        `phi:desktop-appearance:v1:${appearanceOwner(scoped)}`,
    );
});

it('posts type plus owner on the sync channel', () => {
    const posted: Array<unknown> = [];
    const close = vi.fn();
    class FakeChannel {
        postMessage = (message: unknown) => {
            posted.push(message);
        };
        close = close;
    }
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    broadcastConfigSync('behavior');
    const scope = readAppearanceScope();
    if (!scope) throw new Error('expected a scope on a plain page');
    expect(posted).toEqual([
        { type: 'behavior', owner: appearanceOwner(scope) },
    ]);
    expect(close).toHaveBeenCalledTimes(1);
});

it('merges payloads without dropping the owner', () => {
    const posted: Array<unknown> = [];
    class FakeChannel {
        postMessage = (message: unknown) => {
            posted.push(message);
        };
        close = () => {};
    }
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    broadcastConfigSync('low-power', { enabled: true });
    expect(posted).toEqual([
        expect.objectContaining({
            type: 'low-power',
            enabled: true,
            owner: expect.any(String),
        }),
    ]);
});

it('stays silent without a channel implementation', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(() => broadcastConfigSync('behavior')).not.toThrow();
});
