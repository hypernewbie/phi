// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { SettingsView } from '../src/platform/settings-store.ts';
import type {
    MobileDraft,
    MobileDraftStore,
    MobileOwnerRecord,
} from '../src/platform/mobile-appearance-store.ts';
import {
    EMPTY_MOBILE,
    MobileAppearanceStore,
} from '../src/platform/mobile-appearance-store.ts';
import type {
    MobileAppearance,
    MobileFenceOutcome,
    MobileReadOutcome,
    MobileSaveOutcome,
} from '../src/platform/http.ts';
import { SettingsScreen } from '../src/screens/SettingsScreen.tsx';
import { MobileAppearance as MobileSection } from '../src/screens/MobileAppearance.tsx';
import {
    TERM_FONT_OPTIONS,
    UI_FONT_OPTIONS,
} from '../src/copy/appearance.ts';
import { cleanup, mount } from './react-env.ts';

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());

const OWNER = '["http://page.invalid","","http://phi.invalid"]';
const flush = () => new Promise<void>((done) => setTimeout(done, 0));
const live: Array<MobileAppearanceStore> = [];
afterEach(() => {
    for (const store of live.splice(0)) store.dispose();
});

const state = (
    revision: number,
    fields: Partial<MobileAppearance> = {},
): MobileAppearance => ({
    ...EMPTY_MOBILE,
    revision,
    ...fields,
});

function memoryDraftStore(): MobileDraftStore {
    const owners = new Map<string, MobileOwnerRecord>();
    const drafts = new Map<number, MobileDraft>();
    let nextId = 1;
    return {
        async change(owner, update) {
            let record = owners.get(owner);
            if (!record) {
                record = {
                    owner,
                    confirmed: null,
                    counter: 0,
                    attempt: null,
                };
                owners.set(owner, record);
            }
            const result = update(record, [...drafts.values()], {
                put(draft) {
                    if (draft.id === undefined) draft.id = nextId++;
                    drafts.set(draft.id, draft);
                },
                delete(id) {
                    drafts.delete(id);
                },
            });
            owners.set(owner, record);
            return result;
        },
    };
}

function mobileStore(
    options: {
        read?: MobileReadOutcome;
        save?: MobileSaveOutcome;
        fence?: MobileFenceOutcome;
        storage?: MobileDraftStore;
    } = {},
): {
    store: MobileAppearanceStore;
    saves: Array<string>;
} {
    const saves: Array<string> = [];
    const store = new MobileAppearanceStore({
        http: {
            getConfigDocument: () =>
                Promise.resolve({ kind: 'cancelled' } as never),
            getMobileAppearance: () =>
                Promise.resolve(
                    options.read ?? { kind: 'ok', state: state(1) },
                ),
            postMobileAppearance: (body) => {
                saves.push(body);
                return Promise.resolve(
                    options.save ?? { kind: 'unknown' },
                );
            },
            postMobileFence: () =>
                Promise.resolve(options.fence ?? { kind: 'unknown' }),
        },
        bearer: () => 'tok',
        owner: OWNER,
        storage: options.storage ?? memoryDraftStore(),
        createChannel: () => null,
    });
    live.push(store);
    return { store, saves };
}

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
        controls: {
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
        },
        appearance: { ...APPEARANCE },
        security: { enabled: false, busy: false, error: null, done: null },
        note: null,
        ...patch,
    };
}

function handlers(override: Record<string, unknown> = {}) {
    return {
        onRetry: () => {},
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
        ...override,
    };
}

async function mobileSection(
    store: MobileAppearanceStore | null,
): Promise<HTMLElement> {
    const { store: real } = { store };
    if (real !== null) await real.start();
    const { host } = await mount(
        <MobileSection
            store={store}
            uiOptions={UI_FONT_OPTIONS}
            termOptions={TERM_FONT_OPTIONS}
            customFontName=""
            fontInstalled={false}
            onSignIn={() => {}}
        />,
    );
    await act(async () => {
        await flush();
    });
    return host;
}

it('moves the scrollback row onto the mobile page without duplicating it', async () => {
    const { store } = mobileStore();
    await store.start();
    const { host } = await mount(
        <SettingsScreen
            view={view()}
            {...handlers({ mobileStore: store })}
        />,
    );
    expect(
        host.querySelectorAll('#settings-mobile-scrollback'),
    ).toHaveLength(1);
    expect(host.querySelector('#settings-mobile-appearance')).toBeNull();
    await act(async () => {
        host
            .querySelector<HTMLButtonElement>('#settings-mobile-view')
            ?.click();
        await flush();
    });
    const rows = host.querySelectorAll('#settings-mobile-scrollback');
    expect(rows).toHaveLength(1);
    expect(
        host.querySelector('#settings-mobile-appearance') !== null,
    ).toBe(true);
    // The moved row lives outside the shared-appearance fieldset.
    const fieldsets = [...host.querySelectorAll('fieldset')];
    const shared = fieldsets.find((fieldset) =>
        fieldset.querySelector('legend')?.textContent?.includes('Shared'),
    );
    expect(shared?.querySelector('#settings-mobile-scrollback')).toBeNull();
    expect(
        host.querySelector('#settings-mobile-view')?.getAttribute('aria-pressed'),
    ).toBe('true');
});

it('forces the mobile page when the profile override is mobile', async () => {
    const { store } = mobileStore();
    await store.start();
    const { host } = await mount(
        <SettingsScreen
            view={view({
                appearance: { ...APPEARANCE, profile: 'mobile' },
            })}
            {...handlers({ mobileStore: store })}
        />,
    );
    expect(host.querySelector('#settings-desktop-view')).toBeNull();
    expect(host.querySelector('#settings-mobile-appearance') !== null).toBe(
        true,
    );
    expect(host.querySelector('#settings-ui-font')).toBeNull();
});

it('retitles the desktop group and hides font rows on the mobile page', async () => {
    const { store } = mobileStore();
    await store.start();
    const { host } = await mount(
        <SettingsScreen
            view={view()}
            {...handlers({ mobileStore: store })}
        />,
    );
    await act(async () => {
        host
            .querySelector<HTMLButtonElement>('#settings-mobile-view')
            ?.click();
        await flush();
    });
    expect(host.querySelector('#settings-ui-font')).toBeNull();
    expect(host.querySelector('#settings-ui-font-size')).toBeNull();
    expect(host.querySelector('#settings-term-font')).toBeNull();
    expect(host.querySelector('#settings-term-font-size')).toBeNull();
    // Swatches stay: highlight color is shared, like legacy.
    expect(host.querySelector('[name="highlight-color"]') !== null).toBe(true);
});

it('shows the inherit option first with the desktop value', async () => {
    const { store } = mobileStore({
        read: { kind: 'ok', state: state(2) },
    });
    const host = await mobileSection(store);
    const select = host.querySelector<HTMLSelectElement>(
        '#settings-mobile-ui-font',
    );
    expect(select?.options[0]?.textContent).toBe(
        'Inherit desktop — System default',
    );
    expect(select?.value).toBe('null');
});

it('marks an out-of-range size invalid and blocks the save', async () => {
    const { store, saves } = mobileStore({
        save: { kind: 'saved', state: state(2, { ui_font_size: 17 }) },
    });
    const host = await mobileSection(store);
    const input = host.querySelector<HTMLInputElement>(
        '#settings-mobile-ui-font-size',
    );
    if (!input) throw new Error('size input is missing');
    await act(async () => {
        const native = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype,
            'value',
        )?.set;
        native?.call(input, '99');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await flush();
    });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(store.invalid).toBe(true);
    expect(
        host.querySelector('#settings-mobile-status')?.textContent,
    ).toBe('Enter a whole number in the allowed range.');
    await act(async () => {
        host.querySelector<HTMLButtonElement>('#settings-mobile-save')?.click();
        await flush();
        await flush();
    });
    expect(saves).toHaveLength(0);
});

it('writes null when Default restores the inherited size', async () => {
    const { store, saves } = mobileStore({
        read: { kind: 'ok', state: state(1, { ui_font_size: 20 }) },
        save: { kind: 'saved', state: state(2) },
    });
    const host = await mobileSection(store);
    const input = host.querySelector<HTMLInputElement>(
        '#settings-mobile-ui-font-size',
    );
    expect(input?.value).toBe('20');
    await act(async () => {
        host
            .querySelector<HTMLButtonElement>('#settings-mobile-size-reset')
            ?.click();
        await flush();
    });
    expect(input?.value).toBe('17');
    await act(async () => {
        host.querySelector<HTMLButtonElement>('#settings-mobile-save')?.click();
        await flush();
        await flush();
    });
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0] as string)).toEqual({
        revision: 1,
        fields: { ui_font_size: null },
    });
});

it('shows Resolve only while a save outcome is unknown', async () => {
    const { store } = mobileStore({
        save: { kind: 'unknown' },
        fence: { kind: 'saved', state: state(2) },
    });
    const host = await mobileSection(store);
    expect(host.querySelector('#settings-mobile-resolve')).toBeNull();
    await act(async () => {
        store.edit({ ui_font_size: 19 });
        await store.persistDraft();
        await store.flush(true);
        await flush();
    });
    expect(
        host.querySelector('#settings-mobile-status')?.textContent,
    ).toBe('Save outcome unknown');
    const resolve = host.querySelector<HTMLButtonElement>(
        '#settings-mobile-resolve',
    );
    expect(resolve !== null).toBe(true);
    expect(resolve?.disabled).toBe(false);
    await act(async () => {
        resolve?.click();
        await flush();
        await flush();
    });
    expect(host.querySelector('#settings-mobile-resolve')).toBeNull();
});

it('renders retained drafts with restore and discard', async () => {
    const storage = memoryDraftStore();
    const first = mobileStore({ storage });
    await first.store.start();
    first.store.edit({ ui_font_size: 19 });
    await first.store.persistDraft();
    first.store.dispose();
    live.splice(live.indexOf(first.store), 1);
    const { store } = mobileStore({ storage });
    await store.start();
    store.edit({ terminal_font_size: 15 });
    await store.persistDraft();
    const host = await mobileSection(store);
    const drafts = host.querySelector('#settings-mobile-drafts');
    expect(drafts?.children).toHaveLength(1);
    expect(drafts?.textContent).toContain('Retained draft');
    expect(drafts?.textContent).toContain('"ui_font_size":19');
    await act(async () => {
        const buttons = [...(drafts?.querySelectorAll('button') ?? [])];
        buttons.find((button) => button.textContent === 'Restore')?.click();
        await flush();
        await flush();
    });
    expect(store.values.ui_font_size).toBe(19);
});
