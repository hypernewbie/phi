// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { resolveLegacyHandoff } from '../src/platform/legacy-handoff.ts';
import type { AuthSession, AuthView } from '../src/platform/auth-session.ts';
import type { SettingsStore } from '../src/platform/settings-store.ts';
import { cleanup, mount } from './react-env.ts';

function settingsFor(): SettingsStore {
    return {
        view: () => ({
            ready: false,
            pending: false,
            about: null,
            controls: {
                hidden: false,
                reuse: false,
                reuseDisabled: false,
                autoReconnect: true,
                piOffline: false,
                piBridgeNoInject: false,
                claudeSkip: false,
                agyTheme: false,
                idleMinutes: 0,
                lowPower: false,
                hostnameOverride: '',
            },
            appearance: {
                themeColor: 'purple',
                uiFontFamily: '',
                uiFontSize: 0,
                terminalFontFamily: '',
                terminalFontSize: 0,
                mobileScrollbackRows: 0,
                profile: 'auto',
                profileNative: false,
                profileMemoryOnly: false,
                customFontName: '',
    terminalBgName: '',
    fontInstalled: false,
    fontError: null,
    bgError: null,
            },
            security: {
                enabled: false,
                busy: false,
                error: null,
                done: null,
            },
            note: null,
        }),
        start: vi.fn(() => () => {}),
        retry: vi.fn(),
        setToggle: vi.fn(),
        setIdleMinutes: vi.fn(),
        setLowPower: vi.fn(),
        setHostnameOverride: vi.fn(),
        setUIFontFamily: vi.fn(),
        setUIFontSize: vi.fn(),
        setTerminalFontFamily: vi.fn(),
        setTerminalFontSize: vi.fn(),
        setMobileScrollback: vi.fn(),
        setThemeColor: vi.fn(),
        setProfile: vi.fn(),
        resetAppearance: vi.fn(),
        uploadFont: vi.fn(),
        uploadBackground: vi.fn(),
        removeBackground: vi.fn(),
        setAccessPassword: vi.fn(),
        clearAccessPassword: vi.fn(),
        dismissSecurity: vi.fn(),
    };
}

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

function sessionFor(initial: Partial<AuthView> = {}) {
    let current: AuthView = {
        phase: 'checking',
        protection: 'unknown',
        serverLabel: '<hostile-server>',
        hostname: null,
        stale: false,
        pending: true,
        canSignIn: false,
        message: null,
        ...initial,
    };
    const listeners = new Set<(view: AuthView) => void>();
    const session: AuthSession = {
        view: () => current,
        start: vi.fn((onView: (view: AuthView) => void) => {
            listeners.add(onView);
            onView(current);
            return () => {
                listeners.delete(onView);
            };
        }),
        signIn: vi.fn(async () => 'cancelled' as const),
        retry: vi.fn(),
        bearer: () => null,
        adoptBundle: vi.fn(),
    };
    const emit = async (patch: Partial<AuthView>) => {
        current = { ...current, ...patch };
        await act(async () => {
            for (const onView of listeners) onView(current);
        });
    };
    return { session, emit };
}

it('starts the session, escapes the server label, and keeps mutations inside its root', async () => {
    const outside = document.createElement('aside');
    outside.textContent = 'outside React';
    document.body.append(outside);
    try {
        const { session, emit } = sessionFor();
        const { host } = await mount(
            <StrictMode>
                <App session={session} settings={settingsFor()} mobile={null} />
            </StrictMode>,
        );
        expect(session.start).toHaveBeenCalledTimes(2);
        expect(host.querySelector('[role="status"]')?.textContent).toBe(
            'Checking server…',
        );
        expect(
            host.querySelector('section p:nth-of-type(2)')?.textContent,
        ).toBe('<hostile-server>');
        expect(host.querySelector('hostile-server')).toBeNull();
        await emit({
            phase: 'ready',
            protection: 'disabled',
            hostname: 'phi-1',
            pending: false,
        });
        expect(host.textContent).toContain('Password protection is disabled.');
        expect(host.textContent).toContain('phi-1');
        expect(outside.textContent).toBe('outside React');
        await cleanup();
        expect(host.childElementCount).toBe(0);
        expect(document.body.contains(outside)).toBe(true);
    } finally {
        outside.remove();
    }
});

it('opens settings as a modal and refocuses the opener on close', async () => {
    const { session, emit } = sessionFor();
    const { host } = await mount(
        <App session={session} settings={settingsFor()} mobile={null} />,
    );
    await emit({
        phase: 'ready',
        protection: 'disabled',
        hostname: 'phi-1',
        pending: false,
    });
    const settingsButton = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Settings',
    );
    if (!settingsButton) throw new Error('Settings button is missing.');
    expect(settingsButton.disabled).toBe(false);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    vi.spyOn(settingsButton, 'getBoundingClientRect').mockReturnValue({
        width: 10,
        height: 10,
        right: 10,
        left: 0,
        bottom: 10,
        top: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
    });
    await act(async () => settingsButton.click());
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');
    const done = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Close',
    );
    await act(async () => done?.click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(settingsButton);
});

it('closes the settings modal on Escape', async () => {
    const { session, emit } = sessionFor();
    const { host } = await mount(
        <App session={session} settings={settingsFor()} mobile={null} />,
    );
    await emit({
        phase: 'ready',
        protection: 'disabled',
        hostname: 'phi-1',
        pending: false,
    });
    const settingsButton = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Settings',
    );
    await act(async () => settingsButton?.click());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => {
        document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it('keeps Settings disabled until the session is ready', async () => {
    const { session } = sessionFor({ phase: 'checking', pending: true });
    const { host } = await mount(
        <App session={session} settings={settingsFor()} mobile={null} />,
    );
    const settingsButton = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Settings',
    );
    expect(settingsButton?.disabled).toBe(true);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
});

it('routes the sign-in phase to Login and other phases to the card', async () => {
    const { session, emit } = sessionFor({
        phase: 'sign-in',
        protection: 'enabled',
        pending: false,
        canSignIn: true,
    });
    const { host } = await mount(
        <App session={session} settings={settingsFor()} mobile={null} />,
    );
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
    await emit({ phase: 'ready', protection: 'enabled', hostname: 'phi-1' });
    expect(host.querySelector('input[type="password"]')).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
        'Connected.',
    );
});

it('labels cached hostnames as last known until confirmed', async () => {
    const { session, emit } = sessionFor({
        phase: 'ready',
        protection: 'enabled',
        hostname: 'cached-phi',
        stale: true,
        pending: false,
    });
    const { host } = await mount(
        <App session={session} settings={settingsFor()} mobile={null} />,
    );
    expect(host.textContent).toContain('Last known server');
    await emit({ stale: false });
    expect(host.textContent).not.toContain('Last known server');
    expect(host.textContent).toContain('Server name');
});

it('retries only on explicit action and keeps the status node', async () => {
    const { session, emit } = sessionFor({
        phase: 'unavailable',
        pending: false,
        message: 'status-unavailable',
    });
    const { host } = await mount(
        <App session={session} settings={settingsFor()} mobile={null} />,
    );
    const buttons = host.querySelectorAll('button');
    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.getAttribute('aria-current')).toBe('page');
    expect(buttons[1]?.textContent).toBe('Settings');
    expect(buttons[2]?.textContent).toBe('Retry');
    const status = host.querySelector('[role="status"]');
    buttons[0]?.focus();
    await act(async () => buttons[2]?.click());
    expect(session.retry).toHaveBeenCalledTimes(1);
    await emit({ pending: true });
    expect(host.querySelector('[role="status"]')).toBe(status);
    expect(document.activeElement).toBe(buttons[0]);
    await emit({ pending: false });
});

async function startRetry() {
    // jsdom does not model the browser's loss of focus on native disable.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { session, emit } = sessionFor({
        phase: 'unavailable',
        pending: false,
        message: 'status-unavailable',
    });
    const { host } = await mount(
        <App session={session} settings={settingsFor()} mobile={null} />,
    );
    const retry = host.querySelectorAll('button')[2];
    if (!retry) throw new Error('Retry button is missing.');
    retry.focus();
    await act(async () => {
        retry.click();
        retry.blur();
    });
    await emit({ pending: true });
    expect(retry.disabled).toBe(true);
    expect(document.activeElement).toBe(document.body);
    return { host, emit, retry };
}

it('restores focused Retry after the check settles', async () => {
    const { host, emit, retry } = await startRetry();
    const status = host.querySelector('[role="status"]');
    await emit({ pending: false });
    expect(retry.disabled).toBe(false);
    expect(document.activeElement).toBe(retry);
    expect(host.querySelector('[role="status"]')).toBe(status);
});

it.each(['focus elsewhere', 'pointer elsewhere', 'Tab', 'page blur'] as const)(
    'does not restore Retry after %s, even if focus returns to the body',
    async (activity) => {
        const { host, emit, retry } = await startRetry();
        if (activity === 'focus elsewhere') {
            const navigation = host.querySelector('button');
            navigation?.focus();
            navigation?.blur();
        } else if (activity === 'pointer elsewhere') {
            host.querySelector('h1')?.dispatchEvent(
                new Event('pointerdown', { bubbles: true }),
            );
        } else if (activity === 'Tab') {
            document.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
            );
        } else {
            document.defaultView?.dispatchEvent(new Event('blur'));
        }
        await emit({ pending: false });
        expect(retry.disabled).toBe(false);
        expect(document.activeElement).toBe(document.body);
    },
);

it('does not restore Retry after unmount', async () => {
    const { retry } = await startRetry();
    const focus = vi.spyOn(retry, 'focus');
    await cleanup();
    expect(focus).not.toHaveBeenCalled();
});

it.each([
    ['hands off when direct and ready', true, 'ready', '', true],
    ['stays in dev-proxy builds', false, 'ready', '', false],
    ['stays before ready', true, 'sign-in', '', false],
    ['stays with the review flag', true, 'ready', '?stay=1', false],
])('%s', (_name, direct, phase, search, expected) => {
    expect(
        resolveLegacyHandoff(
            direct as boolean,
            phase as AuthView['phase'],
            search as string,
        ),
    ).toBe(expected);
});

it('skips the modal when the desktop bridge claims settings', async () => {
    const request = vi.fn();
    const bridge = { request };
    (window as unknown as Record<string, unknown>).__phiDesktop = bridge;
    try {
        const { session, emit } = sessionFor();
        const { host } = await mount(
            <App
                session={session}
                settings={settingsFor()}
                mobile={null}
            />,
        );
        await emit({
            phase: 'ready',
            protection: 'disabled',
            hostname: 'phi-1',
            pending: false,
        });
        const settingsButton = [...host.querySelectorAll('button')].find(
            (button) => button.textContent === 'Settings',
        );
        await act(async () => settingsButton?.click());
        expect(request).toHaveBeenCalledWith('config', { page: 'desktop' });
        expect(host.querySelector('[role="dialog"]')).toBeNull();
    } finally {
        delete (window as unknown as Record<string, unknown>).__phiDesktop;
    }
});

it('closes the popout window instead of the modal', async () => {
    const close = vi.fn();
    window.close = close;
    window.history.replaceState(null, '', '/?desktop-popout=1');
    try {
        const { session, emit } = sessionFor();
        const { host } = await mount(
            <App
                session={session}
                settings={settingsFor()}
                mobile={null}
            />,
        );
        await emit({
            phase: 'ready',
            protection: 'disabled',
            hostname: 'phi-1',
            pending: false,
        });
        expect(host.querySelector('[role="dialog"]')).not.toBeNull();
        const done = [...host.querySelectorAll('button')].find(
            (button) => button.textContent === 'Close',
        );
        await act(async () => done?.click());
        expect(close).toHaveBeenCalled();
        expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    } finally {
        window.history.replaceState(null, '', '/');
    }
});
