import { useEffect, useState } from 'react';
import { Button } from '../components/ui/Button.tsx';
import type { FontOption } from '../copy/appearance.ts';
import type {
    MobileAppearanceStore,
    MobileFieldKey,
} from '../platform/mobile-appearance-store.ts';
import settings from './settings.module.css';

const UI_FALLBACK = 17;
const TERM_FALLBACK = 14;

// Validated size rows keep a text draft so out-of-range keystrokes stay
// visible (and marked) while the store holds its last valid value.
function MobileSizeRow({
    id,
    resetId,
    label,
    min,
    max,
    fallback,
    committed,
    onEdit,
    onInvalid,
}: {
    id: string;
    resetId: string;
    label: string;
    min: number;
    max: number;
    fallback: number;
    committed: number | null;
    onEdit: (value: number | null) => void;
    onInvalid: () => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const [lastCommitted, setLastCommitted] = useState(committed);
    if (lastCommitted !== committed) {
        setLastCommitted(committed);
        setDraft(null);
    }
    const shown = draft ?? String(committed ?? fallback);
    const parsed = Number(shown);
    const invalid =
        draft !== null &&
        (!shown.trim() ||
            !Number.isInteger(parsed) ||
            parsed < min ||
            parsed > max);
    return (
        <p>
            <label>
                {label}{' '}
                <input
                    type="number"
                    id={id}
                    name={id}
                    min={min}
                    max={max}
                    value={shown}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => {
                        const raw = event.target.value;
                        setDraft(raw);
                        const next = Number(raw);
                        if (
                            !raw.trim() ||
                            !Number.isInteger(next) ||
                            next < min ||
                            next > max
                        ) {
                            onInvalid();
                            return;
                        }
                        onEdit(next);
                    }}
                />
            </label>{' '}
            <Button
                id={resetId}
                onClick={() => {
                    setDraft(null);
                    onEdit(null);
                }}
            >
                {`Default (${fallback})`}
            </Button>
        </p>
    );
}

function FamilySelect({
    id,
    label,
    field,
    options,
    value,
    inherited,
    customFontName,
    onEdit,
}: {
    id: string;
    label: string;
    field: MobileFieldKey;
    options: ReadonlyArray<FontOption>;
    value: string | null;
    inherited: string;
    customFontName: string;
    onEdit: (field: MobileFieldKey, value: string | null) => void;
}) {
    const encoded = JSON.stringify(value);
    const items: Array<{ value: string; label: string }> = [
        { value: 'null', label: `Inherit desktop — ${inherited}` },
        ...options.map((option) => ({
            value: JSON.stringify(option.value),
            label: option.label,
        })),
    ];
    if (!items.some((item) => item.value === encoded))
        items.push({ value: encoded, label: `Current: ${value}` });
    const customEncoded = JSON.stringify('Phi Custom Font');
    if (
        customFontName !== '' &&
        !items.some((item) => item.value === customEncoded)
    )
        items.push({
            value: customEncoded,
            label: `Custom: ${customFontName}`,
        });
    return (
        <p>
            <label>
                {label}{' '}
                <select
                    id={id}
                    name={id}
                    value={encoded}
                    onChange={(event) =>
                        onEdit(
                            field,
                            JSON.parse(event.target.value) as string | null,
                        )
                    }
                >
                    {items.map((item) => (
                        <option key={item.value} value={item.value}>
                            {item.label}
                        </option>
                    ))}
                </select>
            </label>
        </p>
    );
}

export function MobileAppearance({
    store,
    uiOptions,
    termOptions,
    customFontName,
    onSignIn,
}: {
    store: MobileAppearanceStore | null;
    uiOptions: ReadonlyArray<FontOption>;
    termOptions: ReadonlyArray<FontOption>;
    customFontName: string;
    onSignIn: () => void;
}) {
    const [, setVersion] = useState(0);
    const [actionError, setActionError] = useState<string | null>(null);
    useEffect(() => {
        if (store === null) return;
        return store.subscribe(() => {
            setActionError(null);
            setVersion((version) => version + 1);
        });
    }, [store]);
    if (store === null) {
        return (
            <fieldset disabled className={settings.group}>
                <legend className={settings.legend}>Mobile appearance</legend>
                <p role="status" className={settings.hint}>
                    Mobile settings are unavailable in this view.
                </p>
            </fieldset>
        );
    }
    const values = store.values;
    const uiInherited = store.inheritance?.ui_font_family || 'System default';
    const termInherited =
        store.inheritance?.terminal_font_family || 'Default (JetBrains Mono)';
    const run = (work: () => Promise<unknown>) => () => {
        void Promise.resolve()
            .then(work)
            .catch((error: unknown) =>
                setActionError(
                    error instanceof Error
                        ? error.message
                        : 'Changes are retained; action failed.',
                ),
            );
    };
    const attempt = store.attempt;
    const remaining = (attempt?.fences.at(-1)?.deadline ?? 0) - Date.now();
    // M4 installs no fonts, so a saved custom choice is always unavailable
    // here; M5 uploads will add the installed check legacy performs on the
    // shared style node.
    const missingCustom =
        (values.ui_font_family ?? store.inheritance?.ui_font_family) ===
            'Phi Custom Font' ||
        (values.terminal_font_family ??
            store.inheritance?.terminal_font_family) === 'Phi Custom Font';
    const fontNote = [store.inheritanceWarning || ''].filter(Boolean).join(' ');
    return (
        <fieldset className={settings.group} id="settings-mobile-appearance">
            <legend className={settings.legend}>Mobile appearance</legend>
            <FamilySelect
                id="settings-mobile-ui-font"
                label="Mobile UI font"
                field="ui_font_family"
                options={uiOptions}
                value={values.ui_font_family}
                inherited={uiInherited}
                customFontName={customFontName}
                onEdit={(field, value) => store.edit({ [field]: value })}
            />
            <FamilySelect
                id="settings-mobile-term-font"
                label="Mobile terminal font"
                field="terminal_font_family"
                options={termOptions}
                value={values.terminal_font_family}
                inherited={termInherited}
                customFontName={customFontName}
                onEdit={(field, value) => store.edit({ [field]: value })}
            />
            <MobileSizeRow
                id="settings-mobile-ui-font-size"
                resetId="settings-mobile-size-reset"
                label="Mobile UI font size"
                min={10}
                max={24}
                fallback={UI_FALLBACK}
                committed={values.ui_font_size}
                onEdit={(value) => store.edit({ ui_font_size: value })}
                onInvalid={() => store.invalidateInput()}
            />
            <MobileSizeRow
                id="settings-mobile-term-font-size"
                resetId="settings-mobile-term-size-reset"
                label="Mobile terminal font size"
                min={8}
                max={32}
                fallback={TERM_FALLBACK}
                committed={values.terminal_font_size}
                onEdit={(value) => store.edit({ terminal_font_size: value })}
                onInvalid={() => store.invalidateInput()}
            />
            {(missingCustom || fontNote !== '') && (
                <p className={settings.hint} id="settings-mobile-font-note">
                    {[
                        missingCustom
                            ? 'Saved font unavailable on this device. Using a readable fallback; the saved choice is unchanged.'
                            : '',
                        fontNote,
                    ]
                        .filter(Boolean)
                        .join(' ')}
                </p>
            )}
            <p>
                <Button
                    id="settings-mobile-reset"
                    onClick={() =>
                        store.edit({
                            ui_font_family: null,
                            ui_font_size: null,
                            terminal_font_family: null,
                            terminal_font_size: null,
                        })
                    }
                >
                    Reset mobile appearance
                </Button>
            </p>
            <p
                role="status"
                className={settings.hint}
                id="settings-mobile-status"
            >
                {actionError ?? store.status}
            </p>
            {attempt !== null && (
                <p className={settings.hint}>
                    {`Desired values: ${JSON.stringify(attempt.fields)}. The save may already have applied. Resolve checks the server and blocks older pending saves.`}
                </p>
            )}
            <p className={settings.securityActionsRow}>
                {store.pending && (
                    <Button
                        id="settings-mobile-save"
                        disabled={
                            attempt !== null ||
                            store.invalid ||
                            store.storageWarning !== ''
                        }
                        onClick={run(() => store.saveMyChanges())}
                    >
                        Save my changes
                    </Button>
                )}
                {store.pending && (
                    <Button
                        id="settings-mobile-use-server"
                        disabled={attempt !== null}
                        onClick={run(() => store.useServerValues())}
                    >
                        Use server values
                    </Button>
                )}
                {attempt !== null && (
                    <Button
                        id="settings-mobile-resolve"
                        disabled={remaining > 0}
                        onClick={run(() => store.resolve())}
                    >
                        {attempt.fences.length > 0
                            ? 'Resolve again'
                            : 'Resolve'}
                    </Button>
                )}
                {(store.unavailable ||
                    store.storageWarning !== '' ||
                    store.error !== '') && (
                    <Button
                        id="settings-mobile-refresh"
                        onClick={run(() => store.refresh(true))}
                    >
                        Refresh
                    </Button>
                )}
                {store.error.includes('Sign in') && (
                    <Button id="settings-mobile-sign-in" onClick={onSignIn}>
                        Sign in again
                    </Button>
                )}
            </p>
            <div id="settings-mobile-drafts">
                {store.records.drafts
                    .filter(
                        (draft) =>
                            draft.id !== store.draft.id &&
                            Object.keys(draft.fields).length > 0,
                    )
                    .map((draft) => {
                        const owned = draft.owner === store.owner;
                        return (
                            <div
                                key={draft.id}
                                className={settings.recoveryEntry}
                            >
                                <p>
                                    {owned
                                        ? `Retained draft #${draft.id}: ${JSON.stringify(draft.fields)}`
                                        : `Other backend (read-only) #${draft.id}: ${JSON.stringify(draft.fields)} — ${draft.owner}`}
                                </p>
                                {owned && (
                                    <p className={settings.securityActionsRow}>
                                        <Button
                                            onClick={run(() =>
                                                store.restore(
                                                    draft.id as number,
                                                ),
                                            )}
                                        >
                                            Restore
                                        </Button>
                                        <Button
                                            disabled={
                                                attempt?.draftId === draft.id
                                            }
                                            onClick={run(() =>
                                                store.discard(
                                                    draft.id as number,
                                                ),
                                            )}
                                        >
                                            Discard
                                        </Button>
                                    </p>
                                )}
                            </div>
                        );
                    })}
            </div>
        </fieldset>
    );
}
