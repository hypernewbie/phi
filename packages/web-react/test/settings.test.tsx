// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { settingsCopy } from '../src/copy/settings.ts';
import type { SettingsView } from '../src/platform/settings-store.ts';
import { SettingsScreen } from '../src/screens/SettingsScreen.tsx';
import { cleanup, mount } from './react-env.ts';

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const CONTROLS = {
    hidden: false,
    reuse: true,
    reuseDisabled: false,
    autoReconnect: true,
    piOffline: false,
    piBridgeNoInject: false,
    claudeSkip: false,
    agyTheme: false,
    idleMinutes: 30,
    lowPower: false,
};

const noopHandlers = {
    onToggle: () => {},
    onIdleMinutes: () => {},
    onLowPower: () => {},
};

function view(patch: Partial<SettingsView> = {}): SettingsView {
    return {
        ready: true,
        pending: false,
        about: {
            hostname: 'FIXTURE-PHI',
            buildSource: 'test',
            workspaces: 2,
            version: '0.33.0',
            commit: 'abc1234567890',
            date: '2026-11-02',
        },
        controls: CONTROLS,
        note: null,
        ...patch,
    };
}

it('renders the About group with version and short commit', async () => {
    const { host } = await mount(
        <SettingsScreen view={view()} onRetry={() => {}} {...noopHandlers} />,
    );
    expect(host.querySelector('h1')?.textContent).toBe('Settings');
    expect(host.textContent).toContain('Hostname: FIXTURE-PHI');
    expect(host.textContent).toContain('Build source: test');
    expect(host.textContent).toContain('Workspaces: 2');
    expect(host.textContent).toContain('v0.33.0 · abc1234');
});

it('hides the build-source row when unknown', async () => {
    const { host } = await mount(
        <SettingsScreen
            view={view({
                about: {
                    hostname: 'H',
                    buildSource: '',
                    workspaces: 0,
                    version: '',
                    commit: '',
                    date: '',
                },
            })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    expect(host.textContent).not.toContain('Build source');
    expect(host.textContent).toContain('v?');
});

it('shows the note and retries on explicit action only', async () => {
    const onRetry = vi.fn();
    const { host } = await mount(
        <SettingsScreen
            view={view({ note: 'settings-stale' })}
            onRetry={onRetry}
            {...noopHandlers}
        />,
    );
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
        settingsCopy.messages['settings-stale'],
    );
    expect(onRetry).not.toHaveBeenCalled();
    const retry = host.querySelector('button');
    await act(async () => retry?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
});

it('ignores retry clicks while a load is pending', async () => {
    const onRetry = vi.fn();
    const { host } = await mount(
        <SettingsScreen
            view={view({ pending: true })}
            onRetry={onRetry}
            {...noopHandlers}
        />,
    );
    expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe(
        'true',
    );
    const retry = host.querySelector('button');
    expect(retry?.textContent).toBe('Loading…');
    await act(async () => retry?.click());
    expect(onRetry).not.toHaveBeenCalled();
});

it('renders toggles from the view and reports changes', async () => {
    const onToggle = vi.fn();
    const onIdleMinutes = vi.fn();
    const onLowPower = vi.fn();
    const { host } = await mount(
        <SettingsScreen
            view={view()}
            onRetry={() => {}}
            onToggle={onToggle}
            onIdleMinutes={onIdleMinutes}
            onLowPower={onLowPower}
        />,
    );
    const boxFor = (text: string): HTMLInputElement => {
        const label = Array.from(host.querySelectorAll('label')).find((el) =>
            el.textContent?.includes(text),
        );
        const box = label?.querySelector<HTMLInputElement>(
            'input[type="checkbox"]',
        );
        if (!box) throw new Error(`checkbox is missing: ${text}`);
        return box;
    };
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(8);
    await act(async () => {
        boxFor('Start pi with --offline').click();
    });
    expect(onToggle).toHaveBeenCalledExactlyOnceWith('piOffline', true);
    const idle = host.querySelector('select');
    expect(idle?.value).toBe('30');
    await act(async () => {
        if (!idle) throw new Error('idle select is missing');
        idle.value = '60';
        idle.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onIdleMinutes).toHaveBeenCalledExactlyOnceWith(60);
    await act(async () => {
        boxFor('Low power mode').click();
    });
    expect(onLowPower).toHaveBeenCalledExactlyOnceWith(true);
});

it('disables the behavior controls until the first load', async () => {
    const { host } = await mount(
        <SettingsScreen
            view={view({ ready: false, about: null })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    const fieldset = host.querySelector('fieldset');
    expect(fieldset?.disabled).toBe(true);
});

it('disables reuse while hidden is on', async () => {
    const { host } = await mount(
        <SettingsScreen
            view={view({
                controls: { ...CONTROLS, hidden: true, reuseDisabled: true },
            })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    const boxes = host.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
    );
    expect(boxes[0]?.disabled).toBe(false);
    expect(boxes[1]?.disabled).toBe(true);
});

it('falls back to Off when the server idle value is not an option', async () => {
    const { host } = await mount(
        <SettingsScreen
            view={view({
                controls: { ...CONTROLS, idleMinutes: 45 },
            })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    const select = host.querySelector('select');
    expect(select?.value).toBe('0');
});

it('titles the version with the build date and source', async () => {
    const { host } = await mount(
        <SettingsScreen view={view()} onRetry={() => {}} {...noopHandlers} />,
    );
    const version = host.querySelector('p[title]');
    expect(version?.getAttribute('title')).toBe('2026-11-02 · test');
});

it('shows a loading state without data on first load', async () => {
    const { host } = await mount(
        <SettingsScreen
            view={view({ ready: false, pending: true, about: null })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
        'Loading settings…',
    );
    expect(host.querySelector('h2')).toBeNull();
});
