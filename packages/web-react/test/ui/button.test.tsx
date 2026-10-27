// @vitest-environment jsdom
import { act, createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { Button } from '../../src/components/ui/Button.tsx';
import { cleanup, mount } from '../react-env.ts';

afterEach(cleanup);

it('forwards native props and ref, defaults to a primary non-submit button', async () => {
    const ref = createRef<HTMLButtonElement>();
    const click = vi.fn();
    const { host } = await mount(
        <Button ref={ref} onClick={click} aria-label="Connect">
            Connection
        </Button>,
    );
    const button = host.querySelector('button');
    expect(button).toBe(ref.current);
    expect(button?.type).toBe('button');
    expect(button?.textContent).toBe('Connection');
    expect(button?.getAttribute('aria-label')).toBe('Connect');
    expect(button?.className).toContain('primary');
    await act(async () => button?.click());
    expect(click).toHaveBeenCalledOnce();
});

it.each([
    { busy: true, disabled: false },
    { busy: false, disabled: true },
])('prevents native clicks when %j', async (state) => {
    const click = vi.fn();
    const { host } = await mount(
        <Button
            variant="accent"
            {...state}
            aria-busy={!state.busy}
            onClick={click}
        >
            Retry
        </Button>,
    );
    const button = host.querySelector('button');
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute('aria-busy')).toBe(String(state.busy));
    expect(button?.textContent).toBe('Retry');
    expect(button?.className).toContain('accent');
    expect(button?.hasAttribute('variant')).toBe(false);
    expect(button?.hasAttribute('busy')).toBe(false);
    await act(async () => button?.click());
    expect(click).not.toHaveBeenCalled();
});

it('retains explicit form type and clears busy state without losing the label', async () => {
    const { host, render } = await mount(
        <Button busy type="submit">
            Save
        </Button>,
    );
    await render(<Button type="submit">Save</Button>);
    expect(host.querySelector('button')?.disabled).toBe(false);
    expect(host.querySelector('button')?.type).toBe('submit');
    expect(host.querySelector('button')?.textContent).toBe('Save');
});
