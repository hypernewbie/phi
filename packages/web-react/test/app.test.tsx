// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import type {
    ConnectionResult,
    ConnectionService,
} from '../src/platform/http.ts';
import { cleanup, mount } from './react-env.ts';

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());
function deferredService() {
    const requests: Array<{
        signal: AbortSignal;
        resolve: (result: ConnectionResult) => void;
        reject: (error: Error) => void;
    }> = [];
    const service: ConnectionService = {
        serverLabel: '<hostile-server>',
        getStatus: vi.fn(
            (signal) =>
                new Promise<ConnectionResult>((resolve, reject) => {
                    requests.push({ signal, resolve, reject });
                }),
        ),
    };
    return { service, requests };
}

it('cancels Strict Mode requests, ignores obsolete completion, and keeps mutations inside its root', async () => {
    const outside = document.createElement('aside');
    outside.textContent = 'outside React';
    document.body.append(outside);
    try {
        const { service, requests } = deferredService();
        const { host } = await mount(
            <StrictMode>
                <App service={service} />
            </StrictMode>,
        );
        expect(requests).toHaveLength(2);
        expect(requests[0]?.signal.aborted).toBe(true);
        const status = host.querySelector('[role="status"]');
        expect(status?.textContent).toBe('Checking server…');
        expect(
            host.querySelector('section p:nth-of-type(2)')?.textContent,
        ).toBe('<hostile-server>');
        expect(host.querySelector('hostile-server')).toBeNull();
        await act(async () => requests[1]?.resolve('protected'));
        await act(async () => requests[0]?.resolve('disabled'));
        expect(host.textContent).toContain('Server requires sign-in.');
        expect(host.textContent).not.toContain(
            'Password protection is disabled.',
        );
        expect(host.querySelector('[role="status"]')).toBe(status);
        expect(outside.textContent).toBe('outside React');
        await cleanup();
        expect(requests[1]?.signal.aborted).toBe(true);
        expect(host.childElementCount).toBe(0);
        expect(document.body.contains(outside)).toBe(true);
    } finally {
        outside.remove();
    }
});

it('ignores superseded service results and cancelled results without announcing errors', async () => {
    const first = deferredService();
    const second = deferredService();
    const { host, render } = await mount(<App service={first.service} />);
    await render(<App service={second.service} />);
    expect(first.requests[0]?.signal.aborted).toBe(true);
    await act(async () => first.requests[0]?.resolve('unavailable'));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
        'Checking server…',
    );
    await act(async () => second.requests[0]?.resolve('cancelled'));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
        'Checking server…',
    );
});

it.each(['disabled', 'protected', 'unsupported', 'unavailable'] as const)(
    'presents %s and retries only on explicit action',
    async (result) => {
        const { service, requests } = deferredService();
        const { host } = await mount(<App service={service} />);
        const buttons = host.querySelectorAll('button');
        expect(buttons).toHaveLength(2);
        expect(buttons[0]?.getAttribute('aria-current')).toBe('page');
        expect(buttons[1]?.disabled).toBe(true);
        buttons[0]?.focus();
        await act(async () => requests[0]?.resolve(result));
        expect(document.activeElement).toBe(buttons[0]);
        expect(buttons[1]?.disabled).toBe(false);
        expect(buttons[1]?.textContent).toBe('Retry');
        expect(host.querySelector('input')).toBeNull();
        await act(async () => buttons[1]?.click());
        expect(requests).toHaveLength(2);
        expect(buttons[1]?.disabled).toBe(true);
        expect(host.querySelector('[role="status"]')?.textContent).toBe(
            'Checking server…',
        );
    },
);

async function startRetry(focused = true) {
    // jsdom does not model the browser's loss of focus on native disable.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { service, requests } = deferredService();
    const { host } = await mount(<App service={service} />);
    await act(async () => requests[0]?.resolve('unsupported'));
    const retry = host.querySelectorAll('button')[1];
    if (!retry) throw new Error('Retry button is missing.');
    if (focused) retry.focus();
    await act(async () => {
        retry.click();
        retry.blur();
    });
    expect(retry.disabled).toBe(true);
    expect(document.activeElement).toBe(document.body);
    return { host, requests, retry };
}

it.each([
    'disabled',
    'protected',
    'unsupported',
    'unavailable',
    'rejected',
] as const)(
    'restores focused Retry after %s without replacing its status node',
    async (result) => {
        const { host, requests, retry } = await startRetry();
        const status = host.querySelector('[role="status"]');
        await act(async () => {
            if (result === 'rejected')
                requests[1]?.reject(new Error('offline'));
            else requests[1]?.resolve(result);
        });
        expect(retry.disabled).toBe(false);
        expect(document.activeElement).toBe(retry);
        expect(host.querySelector('[role="status"]')).toBe(status);
    },
);

it.each(['focus elsewhere', 'pointer elsewhere', 'Tab', 'page blur'] as const)(
    'does not restore Retry after %s, even if focus returns to the body',
    async (activity) => {
        const { host, requests, retry } = await startRetry();
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
        await act(async () => requests[1]?.resolve('unsupported'));
        expect(retry.disabled).toBe(false);
        expect(document.activeElement).toBe(document.body);
    },
);

it('does not focus Retry when an unfocused button initiated the request', async () => {
    const { requests, retry } = await startRetry(false);
    await act(async () => requests[1]?.resolve('unsupported'));
    expect(retry.disabled).toBe(false);
    expect(document.activeElement).toBe(document.body);
});

it('does not restore Retry while its page is unfocused', async () => {
    const { requests } = await startRetry();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await act(async () => requests[1]?.resolve('unsupported'));
    expect(document.activeElement).toBe(document.body);
});

it('does not restore Retry after unmount or obsolete completion', async () => {
    const { requests, retry } = await startRetry();
    const focus = vi.spyOn(retry, 'focus');
    await cleanup();
    await act(async () => requests[1]?.resolve('unsupported'));
    expect(focus).not.toHaveBeenCalled();
});
