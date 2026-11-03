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
    hostnameOverride: '',
};

const APPEARANCE = {
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
} as const;

const noopHandlers = {
    onToggle: () => {},
    onIdleMinutes: () => {},
    onLowPower: () => {},
    onHostname: () => {},
    onUIFontFamily: () => {},
    onUIFontSize: () => {},
    onTerminalFontFamily: () => {},
    onTerminalFontSize: () => {},
    onMobileScrollback: () => {},
    onThemeColor: () => {},
    onProfile: () => {},
    onResetAppearance: () => {},
    onSetAccessPassword: () => {},
    onClearAccessPassword: () => {},
    onSecurityEdit: () => {},
    mobileStore: null,
    onMobileSignIn: () => {},
    onUploadFont: () => {},
    onUploadBackground: () => {},
    onRemoveBackground: () => {},
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
        appearance: { ...APPEARANCE },
        security: {
            enabled: false,
            busy: false,
            error: null,
            done: null,
        },
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
    const retry = Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === 'Retry',
    );
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
    const retry = Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === 'Loading…',
    );
    expect(retry?.textContent).toBe('Loading…');
    await act(async () => retry?.click());
    expect(onRetry).not.toHaveBeenCalled();
});

it('renders toggles from the view and reports changes', async () => {
    const onToggle = vi.fn();
    const onIdleMinutes = vi.fn();
    const onLowPower = vi.fn();
    const onHostname = vi.fn();
    const { host } = await mount(
        <SettingsScreen
            view={view()}
            onRetry={() => {}}
            {...noopHandlers}
            onToggle={onToggle}
            onIdleMinutes={onIdleMinutes}
            onLowPower={onLowPower}
            onHostname={onHostname}
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
    const idle = host.querySelector(
        '#settings-opencode-idle',
    ) as HTMLSelectElement | null;
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
    const select = host.querySelector<HTMLSelectElement>(
        '#settings-opencode-idle',
    );
    expect(select?.value).toBe('0');
});

it('titles the version with the build date and source', async () => {
    const { host } = await mount(
        <SettingsScreen view={view()} onRetry={() => {}} {...noopHandlers} />,
    );
    const version = host.querySelector('p[title]');
    expect(version?.getAttribute('title')).toBe('2026-11-02 · test');
});

it('renders the hostname label and reports edits', async () => {
    const onHostname = vi.fn();
    const { host } = await mount(
        <SettingsScreen
            view={view({
                controls: { ...CONTROLS, hostnameOverride: 'europa' },
            })}
            onRetry={() => {}}
            {...noopHandlers}
            onHostname={onHostname}
        />,
    );
    const input = host.querySelector(
        'input[type="text"]',
    ) as HTMLInputElement | null;
    expect(input?.value).toBe('europa');
    expect(input?.placeholder).toContain('dusty_potato');
    await act(async () => {
        if (!input) throw new Error('hostname input is missing');
        const native = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value',
        )?.set;
        native?.call(input, 'io');
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onHostname).toHaveBeenCalledWith('io');
});

it('renders 29 swatches with the active color checked', async () => {
    const onThemeColor = vi.fn();
    const { host } = await mount(
        <SettingsScreen
            view={view({
                appearance: { ...APPEARANCE, themeColor: 'teal' },
            })}
            onRetry={() => {}}
            {...noopHandlers}
            onThemeColor={onThemeColor}
        />,
    );
    const radios = host.querySelectorAll('input[type="radio"]');
    expect(radios).toHaveLength(29);
    const checked = Array.from(radios).filter(
        (radio) => (radio as HTMLInputElement).checked,
    );
    expect(checked).toHaveLength(1);
    expect(checked[0]?.getAttribute('title')).toBe('teal');
    await act(async () => {
        (radios[0] as HTMLInputElement).click();
    });
    expect(onThemeColor).toHaveBeenCalledWith('purple');
});

it('injects Custom and Current font options like legacy', async () => {
    const { host } = await mount(
        <SettingsScreen
            view={view({
                appearance: {
                    ...APPEARANCE,
                    terminalFontFamily: 'Hand Edit Mono',
                    customFontName: 'mine.woff2',
                },
            })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    const ui = host.querySelector('#settings-ui-font');
    expect(ui?.textContent).toContain('Custom: mine.woff2');
    const term = host.querySelector('#settings-term-font');
    const labels = Array.from(term?.querySelectorAll('option') ?? []).map(
        (option) => option.textContent,
    );
    expect(labels[1]).toBe('Current: Hand Edit Mono');
    expect(labels[labels.length - 1]).toBe('Custom: mine.woff2');
    expect((term as HTMLSelectElement | null)?.value).toBe('Hand Edit Mono');
});

it('reports font picks and number commits as raw text', async () => {
    const onUIFontFamily = vi.fn();
    const onUIFontSize = vi.fn();
    const { host } = await mount(
        <SettingsScreen
            view={view()}
            onRetry={() => {}}
            {...noopHandlers}
            onUIFontFamily={onUIFontFamily}
            onUIFontSize={onUIFontSize}
        />,
    );
    const select = host.querySelector(
        '#settings-ui-font',
    ) as HTMLSelectElement | null;
    await act(async () => {
        if (!select) throw new Error('UI font select is missing');
        select.value = 'Inter, system-ui, sans-serif';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onUIFontFamily).toHaveBeenCalledWith('Inter, system-ui, sans-serif');
    const size = host.querySelector(
        '#settings-ui-font-size',
    ) as HTMLInputElement | null;
    expect(size?.value).toBe('14');
    await act(async () => {
        if (!size) throw new Error('UI size input is missing');
        const native = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value',
        )?.set;
        native?.call(size, '9');
        size.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onUIFontSize).toHaveBeenCalledWith('9');
    expect(size?.value).toBe('9');
});

it('shows the native profile warning and disables the select', async () => {
    const { host } = await mount(
        <SettingsScreen
            view={view({
                appearance: { ...APPEARANCE, profileNative: true },
            })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    const select = host.querySelector(
        '#settings-appearance-profile',
    ) as HTMLSelectElement | null;
    expect(select?.disabled).toBe(true);
    expect(host.textContent).toContain(
        'Native desktop always uses the desktop appearance.',
    );
});

it('reports profile picks and appearance resets', async () => {
    const onProfile = vi.fn();
    const onResetAppearance = vi.fn();
    const { host } = await mount(
        <SettingsScreen
            view={view()}
            onRetry={() => {}}
            {...noopHandlers}
            onProfile={onProfile}
            onResetAppearance={onResetAppearance}
        />,
    );
    const select = host.querySelector(
        '#settings-appearance-profile',
    ) as HTMLSelectElement | null;
    await act(async () => {
        if (!select) throw new Error('profile select is missing');
        select.value = 'mobile';
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onProfile).toHaveBeenCalledWith('mobile');
    const reset = Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === 'Reset appearance',
    );
    await act(async () => reset?.click());
    expect(onResetAppearance).toHaveBeenCalledTimes(1);
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

const SECURITY_OFF = {
    enabled: false,
    busy: false,
    error: null,
    done: null,
} as const;

const SECURITY_ON = {
    enabled: true,
    busy: false,
    error: null,
    done: null,
} as const;

const typePassword = async (input: HTMLInputElement, text: string) => {
    await act(async () => {
        const native = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value',
        )?.set;
        native?.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};

const securityInputs = (host: HTMLElement) => ({
    next: host.querySelector('#settings-access-new') as HTMLInputElement,
    confirm: host.querySelector('#settings-access-confirm') as HTMLInputElement,
});

it('renders the Security group with disabled state and no remove link', async () => {
    const { host } = await mount(
        <SettingsScreen
            view={view({ security: { ...SECURITY_OFF } })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    const copy = settingsCopy.security;
    expect(host.textContent).toContain(copy.accessPassword);
    expect(host.textContent).toContain(copy.disabledText);
    expect(host.textContent).toContain(copy.setButton);
    expect(host.textContent).not.toContain('Remove password');
    const { next, confirm } = securityInputs(host);
    expect(next.placeholder).toBe(copy.newPlaceholder);
    expect(confirm.placeholder).toBe(copy.confirmPlaceholder);
    expect(next.autocomplete).toBe('new-password');
});

it('submits the typed passwords on Set', async () => {
    const onSetAccessPassword = vi.fn();
    const { host } = await mount(
        <SettingsScreen
            view={view({ security: { ...SECURITY_OFF } })}
            onRetry={() => {}}
            {...noopHandlers}
            onSetAccessPassword={onSetAccessPassword}
        />,
    );
    const { next, confirm } = securityInputs(host);
    await typePassword(next, 'new-secret-12');
    await typePassword(confirm, 'new-secret-12');
    const set = Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === settingsCopy.security.setButton,
    );
    await act(async () => set?.click());
    expect(onSetAccessPassword).toHaveBeenCalledTimes(1);
    expect(onSetAccessPassword).toHaveBeenCalledWith(
        'new-secret-12',
        'new-secret-12',
    );
});

it('requires two distinct clicks to remove the password', async () => {
    const onClearAccessPassword = vi.fn();
    const { host } = await mount(
        <SettingsScreen
            view={view({ security: { ...SECURITY_ON } })}
            onRetry={() => {}}
            {...noopHandlers}
            onClearAccessPassword={onClearAccessPassword}
        />,
    );
    const copy = settingsCopy.security;
    expect(host.textContent).toContain(copy.updateButton);
    expect(host.textContent).not.toContain(copy.confirmRemove);
    const remove = Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === copy.removeLink,
    );
    await act(async () => remove?.click());
    expect(onClearAccessPassword).not.toHaveBeenCalled();
    const confirm = Array.from(host.querySelectorAll('button')).find(
        (button) => button.textContent === copy.confirmRemove,
    );
    expect(confirm).not.toBeUndefined();
    await act(async () => confirm?.click());
    expect(onClearAccessPassword).toHaveBeenCalledTimes(1);
});

it('shows the store error in the alert slot and clears inputs on done', async () => {
    const { host, render } = await mount(
        <SettingsScreen
            view={view({
                security: { ...SECURITY_ON, error: 'mismatch' },
            })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        settingsCopy.security.errors.mismatch,
    );
    const { next, confirm } = securityInputs(host);
    await typePassword(next, 'typed-secret-1');
    await typePassword(confirm, 'typed-secret-1');
    await render(
        <SettingsScreen
            view={view({ security: { ...SECURITY_ON, done: 'updated' } })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    expect(
        (host.querySelector('#settings-access-new') as HTMLInputElement).value,
    ).toBe('');
    expect(
        (host.querySelector('#settings-access-confirm') as HTMLInputElement)
            .value,
    ).toBe('');
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
        settingsCopy.security.done.updated,
    );
});

it('passes a chosen font file to the upload handler', async () => {
    const onUploadFont = vi.fn();
    const { host } = await mount(
        <SettingsScreen
            view={view()}
            onRetry={() => {}}
            {...noopHandlers}
            onUploadFont={onUploadFont}
        />,
    );
    const input = host.querySelector(
        '#settings-font-upload',
    ) as HTMLInputElement | null;
    if (!input) throw new Error('font upload input is missing');
    expect(input.accept).toBe('.woff2,.woff,.ttf,.otf');
    const file = new File(['font-bytes'], 'Fira.woff2', {
        type: 'font/woff2',
    });
    await act(async () => {
        Object.defineProperty(input, 'files', {
            value: [file],
            configurable: true,
        });
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onUploadFont).toHaveBeenCalledWith('Fira.woff2', file);
});

it('names the loaded font and renders an inline font error', async () => {
    const { host, render } = await mount(
        <SettingsScreen
            view={view({
                appearance: { ...APPEARANCE, customFontName: 'Fira.woff2' },
            })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    expect(host.textContent).toContain('Loaded Fira.woff2.');
    await render(
        <SettingsScreen
            view={view({
                appearance: {
                    ...APPEARANCE,
                    customFontName: '',
                    fontError: 'Font too large (max 8MB)',
                },
            })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        'Font too large (max 8MB)',
    );
});

it('labels the background upload and offers Remove', async () => {
    const onRemoveBackground = vi.fn();
    const onUploadBackground = vi.fn();
    const { host } = await mount(
        <SettingsScreen
            view={view({
                appearance: {
                    ...APPEARANCE,
                    terminalBgName: 'wallpaper.png',
                },
            })}
            onRetry={() => {}}
            {...noopHandlers}
            onUploadBackground={onUploadBackground}
            onRemoveBackground={onRemoveBackground}
        />,
    );
    expect(host.textContent).toContain(
        'Terminal background (wallpaper.png)',
    );
    const remove = host.querySelector(
        '#settings-bg-remove',
    ) as HTMLButtonElement | null;
    if (!remove) throw new Error('background Remove button is missing');
    await act(async () => {
        remove.dispatchEvent(new Event('click', { bubbles: true }));
    });
    expect(onRemoveBackground).toHaveBeenCalled();
    const input = host.querySelector(
        '#settings-bg-upload',
    ) as HTMLInputElement | null;
    if (!input) throw new Error('background upload input is missing');
    const file = new File(['png-bytes'], 'wallpaper.png', {
        type: 'image/png',
    });
    await act(async () => {
        Object.defineProperty(input, 'files', {
            value: [file],
            configurable: true,
        });
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onUploadBackground).toHaveBeenCalledWith('wallpaper.png', file);
});

it('renders an inline background error', async () => {
    const { host } = await mount(
        <SettingsScreen
            view={view({
                appearance: {
                    ...APPEARANCE,
                    bgError: 'Background image too large (max 16MB)',
                },
            })}
            onRetry={() => {}}
            {...noopHandlers}
        />,
    );
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
        'Background image too large (max 16MB)',
    );
});
