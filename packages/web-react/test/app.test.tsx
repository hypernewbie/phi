// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import type { AuthSession, AuthView } from '../src/platform/auth-session.ts';
import { cleanup, mount } from './react-env.ts';

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
                <App session={session} />
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

it('routes the sign-in phase to Login and other phases to the card', async () => {
    const { session, emit } = sessionFor({
        phase: 'sign-in',
        protection: 'enabled',
        pending: false,
        canSignIn: true,
    });
    const { host } = await mount(<App session={session} />);
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
    const { host } = await mount(<App session={session} />);
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
    const { host } = await mount(<App session={session} />);
    const buttons = host.querySelectorAll('button');
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.getAttribute('aria-current')).toBe('page');
    expect(buttons[1]?.textContent).toBe('Retry');
    const status = host.querySelector('[role="status"]');
    buttons[0]?.focus();
    await act(async () => buttons[1]?.click());
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
    const { host } = await mount(<App session={session} />);
    const retry = host.querySelectorAll('button')[1];
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
