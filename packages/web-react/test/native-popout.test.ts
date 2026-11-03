import { expect, it, vi } from 'vitest';
import {
    isPopoutClose,
    tryOpenNative,
    type PopoutDeps,
} from '../src/platform/native-popout.ts';

const deps = (overrides: Partial<PopoutDeps> = {}): PopoutDeps => ({
    search: '',
    protocol: 'http:',
    pathname: '/',
    fullscreen: false,
    bridge: null,
    open: () => null,
    close: () => {},
    ...overrides,
});

it('keeps the modal in a plain browser tab', () => {
    const open = vi.fn();
    expect(tryOpenNative('desktop', deps({ open }))).toBe(false);
    expect(open).not.toHaveBeenCalled();
});

it('claims the settings action through the desktop bridge', () => {
    const request = vi.fn();
    expect(
        tryOpenNative('desktop', deps({ bridge: { request } })),
    ).toBe(true);
    expect(request).toHaveBeenCalledWith('config', { page: 'desktop' });
});

it('leaves embedded bridge tabs on the modal', () => {
    const request = vi.fn();
    expect(
        tryOpenNative(
            'desktop',
            deps({ search: '?embedded=1', bridge: { request } }),
        ),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
});

it('opens a popup under a native host and drops the opener', () => {
    const win = { opener: 'parent' };
    const open = vi.fn(() => win);
    expect(
        tryOpenNative(
            'desktop',
            deps({ search: '?desktop=1', open, pathname: '/app' }),
        ),
    ).toBe(true);
    expect(open).toHaveBeenCalledWith(
        '/app?desktop-popout=1',
        'phi-config',
        'width=860,height=1000',
    );
    expect(win.opener).toBeNull();
});

it('keeps the modal when the popup is blocked', () => {
    expect(
        tryOpenNative('desktop', deps({ search: '?desktop=1' })),
    ).toBe(false);
});

it('carries the mobile page and embedded identity into the popup', () => {
    const win = { opener: 'parent' };
    const open = vi.fn(() => win);
    expect(
        tryOpenNative(
            'mobile',
            deps({
                search: '?desktop=1&embedded=1&profile=p1&origin=http%3A%2F%2Fx',
                open,
                pathname: '/app',
            }),
        ),
    ).toBe(true);
    const calls = open.mock.calls as unknown as Array<[
        string,
        string,
        string,
    ]>;
    const [url, name] = calls[0];
    expect(url).toContain('page=mobile');
    expect(url).toContain('embedded=1');
    expect(url).toContain('profile=p1');
    expect(name).toContain('phi-config-p1-');
});

it('refuses an embedded popup without profile and origin', () => {
    const open = vi.fn(() => ({ opener: 'parent' }));
    expect(
        tryOpenNative(
            'desktop',
            deps({ search: '?desktop=1&embedded=1', open }),
        ),
    ).toBe(false);
    expect(open).not.toHaveBeenCalled();
});

it('keeps the modal in fullscreen', () => {
    const request = vi.fn();
    expect(
        tryOpenNative('desktop', deps({ fullscreen: true, bridge: { request } })),
    ).toBe(false);
    expect(request).not.toHaveBeenCalled();
});

it('detects the popout close query', () => {
    expect(isPopoutClose('?desktop-popout=1')).toBe(true);
    expect(isPopoutClose('?desktop-popout=1&page=mobile')).toBe(true);
    expect(isPopoutClose('?desktop=1')).toBe(false);
    expect(isPopoutClose('')).toBe(false);
});
