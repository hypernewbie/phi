// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { authCopy } from '../src/copy/auth.ts';
import type { AuthView, SignInOutcome } from '../src/platform/auth-session.ts';
import { LoginScreen } from '../src/screens/LoginScreen.tsx';
import { cleanup, mount } from './react-env.ts';

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const UPSTREAM = 'http://fixture.invalid';

function view(patch: Partial<AuthView> = {}): AuthView {
    return {
        phase: 'sign-in',
        protection: 'enabled',
        serverLabel: UPSTREAM,
        hostname: null,
        stale: false,
        pending: false,
        canSignIn: true,
        message: null,
        ...patch,
    };
}

function deferredSignIn() {
    const calls: Array<{
        password: string;
        resolve: (outcome: SignInOutcome) => void;
    }> = [];
    const signIn = vi.fn(
        (password: string) =>
            new Promise<SignInOutcome>((resolve) => {
                calls.push({ password, resolve });
            }),
    );
    return { signIn, calls };
}

const fieldOf = (host: HTMLElement) =>
    host.querySelector<HTMLInputElement>('#login-password');
const errorOf = (host: HTMLElement) =>
    host.querySelector('#login-error')?.textContent ?? '';

async function type(host: HTMLElement, value: string) {
    const field = fieldOf(host);
    // Drive React's controlled input through native value setting.
    await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(field),
            'value',
        )?.set;
        setter?.call(field, value);
        field?.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

async function submit(host: HTMLElement) {
    await act(async () => {
        host.querySelector('form')?.dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }),
        );
    });
}

it('submits the typed password once and clears it only when accepted', async () => {
    const { signIn, calls } = deferredSignIn();
    const { host } = await mount(
        <LoginScreen view={view()} signIn={signIn} onRetry={() => {}} />,
    );
    const field = fieldOf(host);
    expect(field).not.toBeNull();
    await type(host, 'correct-horse');
    expect(field?.value).toBe('correct-horse');
    await submit(host);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(calls[0]?.password).toBe('correct-horse');
    expect(host.querySelector('button[type="submit"]')?.textContent).toBe(
        'Signing in…',
    );
    await act(async () => calls[0]?.resolve('accepted'));
    expect(field?.value).toBe('');
    expect(errorOf(host)).toBe('');
});

it('ignores double submits while a login is pending', async () => {
    const { signIn, calls } = deferredSignIn();
    const { host } = await mount(
        <LoginScreen view={view()} signIn={signIn} onRetry={() => {}} />,
    );
    await submit(host);
    await submit(host);
    await submit(host);
    expect(signIn).toHaveBeenCalledTimes(1);
    await act(async () => calls[0]?.resolve('wrong-password'));
    expect(errorOf(host)).toBe(authCopy.messages['wrong-password']);
    expect(fieldOf(host)?.value).toBe('');
});

it('keeps the field editable during a slow submit and retains failures', async () => {
    const { signIn, calls } = deferredSignIn();
    const { host } = await mount(
        <LoginScreen view={view()} signIn={signIn} onRetry={() => {}} />,
    );
    const field = fieldOf(host);
    await type(host, 'wrong-horse');
    await submit(host);
    expect(field?.disabled).toBe(false);
    await act(async () => calls[0]?.resolve('wrong-password'));
    expect(field?.value).toBe('wrong-horse');
    expect(errorOf(host)).toBe(authCopy.messages['wrong-password']);
    expect(field?.getAttribute('aria-describedby')).toContain('login-error');
});

it('suppresses a stale field error after the user edits the input', async () => {
    const { signIn, calls } = deferredSignIn();
    const { host } = await mount(
        <LoginScreen view={view()} signIn={signIn} onRetry={() => {}} />,
    );
    const field = fieldOf(host);
    await type(host, 'first-try');
    await submit(host);
    await type(host, 'first-try-edited');
    await act(async () => calls[0]?.resolve('wrong-password'));
    expect(field?.value).toBe('first-try-edited');
    expect(errorOf(host)).toBe('');
});

it('shows the service message when no field error applies', async () => {
    const { signIn } = deferredSignIn();
    const { host } = await mount(
        <LoginScreen
            view={view({
                protection: 'unknown',
                canSignIn: false,
                message: 'separate-profile',
            })}
            signIn={signIn}
            onRetry={() => {}}
        />,
    );
    expect(errorOf(host)).toBe(authCopy.messages['separate-profile']);
    expect(signIn).not.toHaveBeenCalled();
});

it('disables submit without disabling editing and offers Retry', async () => {
    const { signIn } = deferredSignIn();
    const onRetry = vi.fn();
    const { host } = await mount(
        <LoginScreen
            view={view({ canSignIn: false, message: 'status-unavailable' })}
            signIn={signIn}
            onRetry={onRetry}
        />,
    );
    const submit = host.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
    );
    expect(submit?.disabled).toBe(true);
    expect(fieldOf(host)?.disabled).toBe(false);
    const retry = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === 'Retry',
    );
    expect(retry).not.toBeUndefined();
    await act(async () => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(signIn).not.toHaveBeenCalled();
});

it('labels the password field and announces errors once', async () => {
    const { signIn, calls } = deferredSignIn();
    const { host } = await mount(
        <LoginScreen view={view()} signIn={signIn} onRetry={() => {}} />,
    );
    const field = fieldOf(host);
    expect(field?.type).toBe('password');
    expect(field?.autocomplete).toBe('current-password');
    expect(host.querySelector('label')?.getAttribute('for')).toBe(
        'login-password',
    );
    expect(document.activeElement).toBe(field);
    await submit(host);
    await act(async () => calls[0]?.resolve('invalid-length'));
    const alerts = host.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toBe(authCopy.messages['invalid-length']);
});
