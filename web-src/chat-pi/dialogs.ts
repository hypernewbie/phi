export type DialogMethod = 'select' | 'confirm' | 'input' | 'editor';

export interface DialogRecord {
    id: string;
    method: DialogMethod;
    title: string;
    options?: string[];
    message?: string;
    placeholder?: string;
    prefill?: string;
    timeout: number;
    createdAt: number;
}

export type DialogAnswer =
    | { value: string }
    | { confirmed: boolean }
    | { cancelled: true };

export type DialogCloseReason =
    | 'resolved'
    | 'cancelled'
    | 'timeout'
    | 'childExit'
    | 'tabClosed'
    | 'server'
    | 'unsupported'
    | 'late';

export type DialogResponseResult = { resolved?: boolean } | undefined;

export interface PiDialogControllerOptions {
    host: HTMLElement;
    /** True only while this chat pane owns the visible tab focus. */
    isActive?: () => boolean;
    fallbackFocus: () => HTMLElement | null;
    respond: (
        record: DialogRecord,
        answer: DialogAnswer,
    ) => Promise<DialogResponseResult>;
    cancelAll: (reason: 'tabClosed' | 'server') => Promise<unknown>;
    announce: (message: string) => void;
}

export interface PiDialogController {
    setDialogs(dialogs: readonly DialogRecord[]): void;
    upsertDialog(dialog: DialogRecord): void;
    closeDialog(id: string, reason: DialogCloseReason): void;
    /** Focus the retained dialog only when this pane is active. */
    focusActive(): void;
    closeActive(): boolean;
    cancelAll(reason: 'tabClosed' | 'server'): Promise<unknown>;
    destroy(): void;
}

/** Validate the browser-side response shape before it reaches Pi. */
export function validateDialogResponse(
    record: DialogRecord,
    answer: DialogAnswer,
): string | null {
    if ('cancelled' in answer) return null;
    if (record.method === 'confirm') {
        return 'confirmed' in answer && typeof answer.confirmed === 'boolean'
            ? null
            : 'Confirm dialogs require a boolean answer';
    }
    if (!('value' in answer) || typeof answer.value !== 'string')
        return `${record.method} dialogs require a string value`;
    if (
        record.method === 'select' &&
        Array.isArray(record.options) &&
        record.options.length > 0 &&
        !record.options.includes(answer.value)
    )
        return 'The selected option is not available';
    return null;
}

export function dialogResponseFor(
    record: DialogRecord,
    value?: string,
    confirmed?: boolean,
): DialogAnswer {
    if (record.method === 'confirm') {
        return { confirmed: confirmed === true };
    }
    return { value: value ?? '' };
}

type DialogEntry = {
    record: DialogRecord;
    overlay: HTMLDivElement;
    dialog: HTMLDivElement;
    priorFocus: HTMLElement | null;
    resolving: boolean;
    error: HTMLDivElement | null;
};

function isHTMLElement(value: Element | null): value is HTMLElement {
    return value instanceof HTMLElement;
}

function connectedFocus(element: HTMLElement | null): HTMLElement | null {
    return element?.isConnected ? element : null;
}

function closeAnnouncement(reason: DialogCloseReason): string | null {
    switch (reason) {
        case 'timeout':
            return 'Pi dialog timed out';
        case 'childExit':
            return 'Pi exited and closed the dialog';
        case 'server':
            return 'Pi dialog cancelled';
        case 'unsupported':
            return 'Pi closed an unsupported dialog';
        case 'late':
            return 'Pi dialog was already closed';
        default:
            return null;
    }
}

export function createPiDialogController(
    options: PiDialogControllerOptions,
): PiDialogController {
    const entries = new Map<string, DialogEntry>();
    const isActive = options.isActive ?? (() => true);
    let activeId: string | null = null;
    let destroyed = false;

    const focusables = (entry: DialogEntry): HTMLElement[] =>
        Array.from(
            entry.dialog.querySelectorAll<HTMLElement>(
                'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([aria-disabled="true"])',
            ),
        );

    const setDisabled = (entry: DialogEntry, disabled: boolean): void => {
        for (const element of entry.dialog.querySelectorAll<
            HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
        >('button, input, textarea')) {
            element.disabled = disabled;
        }
    };

    const setError = (entry: DialogEntry, message: string): void => {
        if (!entry.error) {
            entry.error = document.createElement('div');
            entry.error.className = 'pi-extension-dialog-error';
            entry.error.setAttribute('role', 'alert');
            const content = entry.dialog.querySelector(
                '.pi-extension-dialog-content',
            );
            content?.appendChild(entry.error);
        }
        entry.error.textContent = message;
    };

    const focusInitial = (entry: DialogEntry): void => {
        const target =
            entry.record.method === 'select'
                ? entry.dialog.querySelector<HTMLElement>(
                      '.pi-extension-dialog-option',
                  )
                : entry.record.method === 'confirm'
                  ? entry.dialog.querySelector<HTMLElement>(
                        '.pi-extension-dialog-cancel',
                    )
                  : entry.dialog.querySelector<HTMLElement>(
                        entry.record.method === 'editor'
                            ? '.pi-extension-dialog-editor'
                            : '.pi-extension-dialog-input',
                    );
        (target ?? focusables(entry)[0])?.focus({ preventScroll: true });
    };

    const showActive = (): void => {
        if (destroyed) return;
        const entry = activeId ? entries.get(activeId) : undefined;
        for (const candidate of entries.values()) {
            const visible = candidate === entry;
            candidate.overlay.classList.toggle('hidden', !visible);
            candidate.overlay.setAttribute(
                'aria-hidden',
                visible ? 'false' : 'true',
            );
        }
        if (entry && isActive()) focusInitial(entry);
    };

    const removeEntry = (
        id: string,
        reason: DialogCloseReason,
        restoreFocus: boolean,
    ): void => {
        const entry = entries.get(id);
        if (!entry) return;
        const wasActive = activeId === id;
        entry.overlay.remove();
        entries.delete(id);
        if (wasActive) {
            activeId = entries.keys().next().value ?? null;
            if (activeId) {
                showActive();
            } else if (restoreFocus && isActive()) {
                (
                    connectedFocus(entry.priorFocus) ??
                    connectedFocus(options.fallbackFocus())
                )?.focus({
                    preventScroll: true,
                });
            }
        }
        const announcement = closeAnnouncement(reason);
        if (announcement) options.announce(announcement);
    };

    const submit = (entry: DialogEntry, answer: DialogAnswer): void => {
        if (destroyed || entry.resolving) return;
        const validation = validateDialogResponse(entry.record, answer);
        if (validation) {
            setError(entry, validation);
            return;
        }
        entry.resolving = true;
        setDisabled(entry, true);
        void options
            .respond(entry.record, answer)
            .then((result) => {
                const resolved =
                    !result || result.resolved === undefined
                        ? true
                        : result.resolved;
                removeEntry(
                    entry.record.id,
                    resolved ? 'resolved' : 'late',
                    true,
                );
            })
            .catch((error: unknown) => {
                entry.resolving = false;
                setDisabled(entry, false);
                setError(
                    entry,
                    `Dialog response failed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                const cancel = entry.dialog.querySelector<HTMLElement>(
                    '.pi-extension-dialog-cancel',
                );
                cancel?.focus({ preventScroll: true });
            });
    };

    const onDialogKeydown = (
        entry: DialogEntry,
        event: KeyboardEvent,
    ): void => {
        if (entry.resolving) {
            event.preventDefault();
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            submit(entry, { cancelled: true });
            return;
        }
        const current =
            event.target instanceof HTMLElement ? event.target : null;
        const list = focusables(entry);
        if (event.key === 'Tab') {
            event.preventDefault();
            if (list.length === 0) return;
            const index = current ? list.indexOf(current) : -1;
            const next = event.shiftKey
                ? index <= 0
                    ? list.length - 1
                    : index - 1
                : index < 0 || index >= list.length - 1
                  ? 0
                  : index + 1;
            list[next]?.focus({ preventScroll: true });
            return;
        }
        if (event.key === 'Enter' && current) {
            if (current instanceof HTMLTextAreaElement && event.shiftKey)
                return;
            event.preventDefault();
            if (current instanceof HTMLButtonElement) {
                current.click();
                return;
            }
            const value =
                current instanceof HTMLInputElement ||
                current instanceof HTMLTextAreaElement
                    ? current.value
                    : undefined;
            if (entry.record.method === 'confirm') {
                submit(entry, { confirmed: true });
            } else {
                submit(entry, dialogResponseFor(entry.record, value));
            }
        }
    };

    const addButton = (
        entry: DialogEntry,
        className: string,
        label: string,
        handler: () => void,
    ): HTMLButtonElement => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        button.addEventListener('click', handler);
        entry.dialog
            .querySelector('.pi-extension-dialog-actions')
            ?.appendChild(button);
        return button;
    };

    const buildEntry = (record: DialogRecord): DialogEntry => {
        const overlay = document.createElement('div');
        overlay.className = 'pi-extension-dialog-overlay';
        overlay.dataset.dialogId = record.id;
        overlay.setAttribute('aria-hidden', 'true');

        const dialog = document.createElement('div');
        dialog.className = 'pi-extension-dialog';
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        const title = document.createElement('div');
        title.className = 'pi-extension-dialog-title';
        title.id = `pi-extension-dialog-title-${entries.size}`;
        title.textContent = record.title;
        dialog.setAttribute('aria-labelledby', title.id);
        dialog.appendChild(title);

        const content = document.createElement('div');
        content.className = 'pi-extension-dialog-content';
        dialog.appendChild(content);
        const actions = document.createElement('div');
        actions.className = 'pi-extension-dialog-actions';
        dialog.appendChild(actions);
        const entry: DialogEntry = {
            record: { ...record, options: record.options?.slice() },
            overlay,
            dialog,
            priorFocus:
                isHTMLElement(document.activeElement) &&
                document.activeElement !== document.body &&
                document.activeElement !== document.documentElement
                    ? document.activeElement
                    : null,
            resolving: false,
            error: null,
        };

        if (record.method === 'select') {
            for (const option of record.options ?? []) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'pi-extension-dialog-option';
                button.dataset.dialogValue = option;
                button.textContent = option;
                button.addEventListener('click', () =>
                    submit(entry, { value: option }),
                );
                content.appendChild(button);
            }
            addButton(entry, 'pi-extension-dialog-cancel', 'Cancel', () =>
                submit(entry, { cancelled: true }),
            );
        } else if (record.method === 'confirm') {
            const message = document.createElement('div');
            message.className = 'pi-extension-dialog-message';
            message.textContent = record.message ?? '';
            content.appendChild(message);
            addButton(entry, 'pi-extension-dialog-confirm', 'Confirm', () =>
                submit(entry, { confirmed: true }),
            );
            addButton(entry, 'pi-extension-dialog-cancel', 'Cancel', () =>
                submit(entry, { cancelled: true }),
            );
        } else {
            const field =
                record.method === 'editor'
                    ? document.createElement('textarea')
                    : document.createElement('input');
            field.className =
                record.method === 'editor'
                    ? 'pi-extension-dialog-editor'
                    : 'pi-extension-dialog-input';
            if (field instanceof HTMLInputElement) {
                field.type = 'text';
                field.placeholder = record.placeholder ?? '';
            }
            field.value = record.prefill ?? '';
            content.appendChild(field);
            addButton(entry, 'pi-extension-dialog-submit', 'Submit', () =>
                submit(entry, dialogResponseFor(record, field.value)),
            );
            addButton(entry, 'pi-extension-dialog-cancel', 'Cancel', () =>
                submit(entry, { cancelled: true }),
            );
        }

        dialog.addEventListener('keydown', (event) =>
            onDialogKeydown(entry, event),
        );
        overlay.appendChild(dialog);
        return entry;
    };

    const activate = (id: string): void => {
        if (!entries.has(id)) return;
        activeId = id;
        showActive();
    };

    const upsertDialog = (dialog: DialogRecord): void => {
        if (destroyed || !dialog.id) return;
        const existing = entries.get(dialog.id);
        if (existing) {
            existing.record = { ...dialog, options: dialog.options?.slice() };
            return;
        }
        const entry = buildEntry(dialog);
        entries.set(dialog.id, entry);
        options.host.appendChild(entry.overlay);
        if (!activeId) activate(dialog.id);
        else showActive();
    };

    return {
        setDialogs(dialogs) {
            const ids = new Set(dialogs.map((dialog) => dialog.id));
            for (const id of [...entries.keys()]) {
                if (!ids.has(id)) removeEntry(id, 'cancelled', false);
            }
            for (const dialog of dialogs) upsertDialog(dialog);
            if (!activeId && entries.size > 0)
                activate(entries.keys().next().value as string);
            showActive();
        },
        upsertDialog,
        closeDialog(id, reason) {
            removeEntry(id, reason, true);
        },
        focusActive() {
            if (isActive()) showActive();
        },
        closeActive() {
            if (!activeId) return false;
            const entry = entries.get(activeId);
            if (!entry) return false;
            submit(entry, { cancelled: true });
            return true;
        },
        cancelAll(reason) {
            if (destroyed) return Promise.resolve();
            return options.cancelAll(reason).then((result) => {
                for (const id of [...entries.keys()])
                    removeEntry(
                        id,
                        reason === 'tabClosed' ? 'tabClosed' : 'server',
                        false,
                    );
                return result;
            });
        },
        destroy() {
            if (destroyed) return;
            destroyed = true;
            for (const entry of entries.values()) entry.overlay.remove();
            entries.clear();
            activeId = null;
        },
    };
}
