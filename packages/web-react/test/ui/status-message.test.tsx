// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
    StatusMessage,
    type StatusKind,
} from '../../src/components/ui/StatusMessage.tsx';
import { cleanup, mount } from '../react-env.ts';

afterEach(cleanup);

it('keeps one polite atomic status node across every state without moving focus', async () => {
    const { host, render } = await mount(
        <StatusMessage kind="loading">Checking server…</StatusMessage>,
    );
    const status = host.querySelector('[role="status"]');
    const focus = document.activeElement;
    for (const kind of [
        'success',
        'warning',
        'error',
        'loading',
    ] as StatusKind[]) {
        await render(<StatusMessage kind={kind}>State: {kind}</StatusMessage>);
        expect(host.querySelector('[role="status"]')).toBe(status);
        expect(status?.getAttribute('aria-live')).toBe('polite');
        expect(status?.getAttribute('aria-atomic')).toBe('true');
        expect(status?.textContent).toBe(`State: ${kind}`);
        expect(document.activeElement).toBe(focus);
        expect(host.querySelector('[role="alert"]')).toBeNull();
    }
});
