// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createPiDialogController,
    dialogResponseFor,
    validateDialogResponse,
} from '../web/chat-pi/dialogs.js';

const selectRecord = {
    id: 'select-1',
    method: 'select',
    title: 'Choose fixture',
    options: ['Allow', 'Block'],
    timeout: 5000,
    createdAt: 1,
};

function setup(respond = vi.fn(async () => ({ resolved: true }))) {
    document.body.replaceChildren();
    const fallback = document.createElement('textarea');
    fallback.id = 'input-textarea';
    const host = document.createElement('div');
    host.className = 'pi-extension-dialog-host';
    document.body.append(fallback, host);
    const announce = vi.fn();
    const cancelAll = vi.fn(async () => ({ cancelled: 1 }));
    const controller = createPiDialogController({
        host,
        fallbackFocus: () => fallback,
        respond,
        cancelAll,
        announce,
    });
    return { controller, fallback, host, announce, cancelAll, respond };
}

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
});

describe('Pi native dialog payloads', () => {
    it('validates exact response shapes and method-specific fields', () => {
        expect(
            validateDialogResponse(selectRecord, { value: 'Allow' }),
        ).toBeNull();
        expect(
            validateDialogResponse(selectRecord, { value: 'Other' }),
        ).toContain('not available');
        expect(
            validateDialogResponse(
                { ...selectRecord, method: 'confirm' },
                { confirmed: true },
            ),
        ).toBeNull();
        expect(
            validateDialogResponse(selectRecord, { cancelled: true }),
        ).toBeNull();
        expect(
            dialogResponseFor(
                { ...selectRecord, method: 'confirm' },
                undefined,
                true,
            ),
        ).toEqual({
            confirmed: true,
        });
        expect(dialogResponseFor(selectRecord, 'Allow')).toEqual({
            value: 'Allow',
        });
    });

    it('sends one exact select response and restores fallback focus', async () => {
        const ctx = setup();
        ctx.fallback.focus();
        ctx.controller.setDialogs([selectRecord]);
        const overlay = ctx.host.querySelector(
            '.pi-extension-dialog-overlay[data-dialog-id="select-1"]',
        );
        const dialog = overlay.querySelector('.pi-extension-dialog');
        expect(dialog.getAttribute('role')).toBe('dialog');
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(
            dialog.querySelector('.pi-extension-dialog-title').textContent,
        ).toBe('Choose fixture');
        expect(document.activeElement.dataset.dialogValue).toBe('Allow');

        overlay.querySelector('[data-dialog-value="Allow"]').click();
        await Promise.resolve();
        expect(ctx.respond).toHaveBeenCalledTimes(1);
        expect(ctx.respond).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'select-1', method: 'select' }),
            { value: 'Allow' },
        );
        expect(
            ctx.host.querySelector('[data-dialog-id="select-1"]'),
        ).toBeNull();
        expect(document.activeElement).toBe(ctx.fallback);
    });

    it('sends exact confirm, input, and editor payloads', async () => {
        const cases = [
            {
                record: {
                    id: 'confirm-1',
                    method: 'confirm',
                    title: 'Confirm fixture',
                    message: 'Continue?',
                    timeout: 1000,
                    createdAt: 1,
                },
                selector: '.pi-extension-dialog-confirm',
                answer: { confirmed: true },
            },
            {
                record: {
                    id: 'input-1',
                    method: 'input',
                    title: 'Input fixture',
                    placeholder: 'Value',
                    timeout: 1000,
                    createdAt: 2,
                },
                selector: '.pi-extension-dialog-submit',
                answer: { value: 'typed value' },
            },
            {
                record: {
                    id: 'editor-1',
                    method: 'editor',
                    title: 'Editor fixture',
                    prefill: 'prefilled',
                    timeout: 0,
                    createdAt: 3,
                },
                selector: '.pi-extension-dialog-submit',
                answer: { value: 'edited value' },
            },
        ];

        for (const item of cases) {
            const ctx = setup();
            ctx.controller.setDialogs([item.record]);
            const overlay = ctx.host.querySelector(
                `[data-dialog-id="${item.record.id}"]`,
            );
            const field = overlay.querySelector(
                '.pi-extension-dialog-input, .pi-extension-dialog-editor',
            );
            if (field) field.value = item.answer.value ?? '';
            overlay.querySelector(item.selector).click();
            await Promise.resolve();
            expect(ctx.respond).toHaveBeenCalledTimes(1);
            expect(ctx.respond.mock.calls[0][1]).toEqual(item.answer);
        }

        const cancelCtx = setup();
        cancelCtx.controller.setDialogs([
            {
                id: 'confirm-cancel',
                method: 'confirm',
                title: 'Confirm fixture',
                message: 'Continue?',
                timeout: 1000,
                createdAt: 4,
            },
        ]);
        cancelCtx.host.querySelector('.pi-extension-dialog-cancel').click();
        await Promise.resolve();
        expect(cancelCtx.respond.mock.calls[0][1]).toEqual({ cancelled: true });
    });
});

describe('Pi native dialog focus and recovery', () => {
    it('traps Tab, Escape cancels once, and restores prior focus', async () => {
        const ctx = setup();
        const prior = document.createElement('button');
        prior.textContent = 'prior';
        document.body.insertBefore(prior, ctx.fallback);
        prior.focus();
        ctx.controller.setDialogs([selectRecord]);
        const overlay = ctx.host.querySelector('[data-dialog-id="select-1"]');
        const cancel = overlay.querySelector('.pi-extension-dialog-cancel');
        const first = overlay.querySelector('.pi-extension-dialog-option');
        cancel.focus();
        cancel.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Tab',
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(document.activeElement).toBe(first);
        first.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Tab',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            }),
        );
        expect(document.activeElement).toBe(cancel);

        overlay.querySelector('.pi-extension-dialog').dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }),
        );
        await Promise.resolve();
        expect(ctx.respond).toHaveBeenCalledTimes(1);
        expect(ctx.respond.mock.calls[0][1]).toEqual({ cancelled: true });
        expect(document.activeElement).toBe(prior);

        const enterCtx = setup();
        enterCtx.controller.setDialogs([selectRecord]);
        const enterOption = enterCtx.host.querySelector(
            '[data-dialog-value="Allow"]',
        );
        enterOption.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }),
        );
        await Promise.resolve();
        expect(enterCtx.respond.mock.calls[0][1]).toEqual({ value: 'Allow' });

        const fallbackCtx = setup();
        const disconnected = document.createElement('button');
        document.body.insertBefore(disconnected, fallbackCtx.fallback);
        disconnected.focus();
        fallbackCtx.controller.setDialogs([
            { ...selectRecord, id: 'fallback-1' },
        ]);
        disconnected.remove();
        fallbackCtx.host.querySelector('[data-dialog-value="Allow"]').click();
        await Promise.resolve();
        expect(document.activeElement).toBe(fallbackCtx.fallback);
    });

    it('keeps one visible overlay and deduplicates hydrated request IDs', () => {
        const ctx = setup();
        const second = { ...selectRecord, id: 'select-2', title: 'Second' };
        ctx.controller.setDialogs([selectRecord, second]);
        expect(
            ctx.host.querySelectorAll('.pi-extension-dialog-overlay'),
        ).toHaveLength(2);
        expect(
            ctx.host.querySelectorAll(
                '.pi-extension-dialog-overlay:not(.hidden)',
            ),
        ).toHaveLength(1);
        ctx.controller.upsertDialog(selectRecord);
        ctx.controller.setDialogs([selectRecord, second]);
        expect(
            ctx.host.querySelectorAll('.pi-extension-dialog-overlay'),
        ).toHaveLength(2);
    });

    it('does not let a background pane steal focus and focuses it on activation', () => {
        document.body.replaceChildren();
        let activePane = 'pane-a';
        const makePane = (paneId) => {
            const host = document.createElement('div');
            host.className = 'pi-extension-dialog-host';
            const fallback = document.createElement('textarea');
            fallback.id = `input-textarea-${paneId}`;
            document.body.append(fallback, host);
            return {
                host,
                controller: createPiDialogController({
                    host,
                    isActive: () => activePane === paneId,
                    fallbackFocus: () => fallback,
                    respond: vi.fn(async () => ({ resolved: true })),
                    cancelAll: vi.fn(async () => ({ cancelled: 1 })),
                    announce: vi.fn(),
                }),
            };
        };
        const paneA = makePane('pane-a');
        const paneB = makePane('pane-b');
        paneA.controller.setDialogs([{ ...selectRecord, id: 'pane-a-dialog' }]);
        const optionA = paneA.host.querySelector('.pi-extension-dialog-option');
        expect(document.activeElement).toBe(optionA);
        paneB.controller.setDialogs([{ ...selectRecord, id: 'pane-b-dialog' }]);
        expect(
            document.activeElement.closest('.pi-extension-dialog-host'),
        ).toBe(paneA.host);
        activePane = 'pane-b';
        paneB.controller.focusActive();
        expect(
            document.activeElement.closest('.pi-extension-dialog-host'),
        ).toBe(paneB.host);
    });

    it('leaves an alert and usable cancel when response fails', async () => {
        const respond = vi
            .fn()
            .mockRejectedValueOnce(new Error('transport failed'))
            .mockResolvedValueOnce({ resolved: true });
        const ctx = setup(respond);
        const record = { ...selectRecord, id: 'failure-1' };
        ctx.controller.setDialogs([record]);
        const overlay = ctx.host.querySelector('[data-dialog-id="failure-1"]');
        overlay.querySelector('[data-dialog-value="Allow"]').click();
        await Promise.resolve();
        await Promise.resolve();
        expect(
            overlay.querySelector('.pi-extension-dialog-error').textContent,
        ).toContain('transport failed');
        const cancel = overlay.querySelector('.pi-extension-dialog-cancel');
        expect(cancel.disabled).toBe(false);
        cancel.click();
        await Promise.resolve();
        expect(respond).toHaveBeenCalledTimes(2);
        expect(overlay.isConnected).toBe(false);
    });

    it('announces timeout/child-exit closure and supports explicit cancellation', async () => {
        const ctx = setup();
        ctx.controller.setDialogs([selectRecord]);
        ctx.controller.closeDialog('select-1', 'timeout');
        expect(ctx.announce).toHaveBeenCalledWith('Pi dialog timed out');

        const next = { ...selectRecord, id: 'server-1' };
        ctx.controller.setDialogs([next]);
        const result = ctx.controller.cancelAll('tabClosed');
        await expect(result).resolves.toEqual({ cancelled: 1 });
        expect(ctx.cancelAll).toHaveBeenCalledWith('tabClosed');
        expect(
            ctx.host.querySelector('[data-dialog-id="server-1"]'),
        ).toBeNull();
    });
});
