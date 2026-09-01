// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { App } from '../web/app.js';

// Reproduces the "Add Command doesn't work" bug: openConfigEditor builds a
// <form> (body) but appends the footer (with the type=submit button) to the
// modal, NOT the form. A submit button outside its form does not submit on
// click, so clicking "Add Command" never resolves the promise. openConfigEditor
// does not use `this`, so we can invoke it against a bare object.

setupDomHarness();

const openEditor = (over = {}) =>
    App.prototype.openConfigEditor.call(
        {},
        {
            title: 'Add Terminal Command',
            fields: [
                { id: 'name', label: 'Label' },
                { id: 'command', label: 'Command', multiline: true },
            ],
            submitLabel: 'Add Command',
            ...over,
        },
    );

// Resolve to a sentinel if the promise doesn't settle promptly, so a broken
// (never-resolving) submit shows up as a failed assertion instead of a hang.
const settleOr = (p, ms = 150) =>
    Promise.race([
        p,
        new Promise((r) => setTimeout(() => r('__timeout__'), ms)),
    ]);

describe('openConfigEditor', () => {
    it('resolves with field values when the submit button is clicked', async () => {
        const promise = openEditor();
        document.getElementById('config-editor-name').value = 'tests';
        document.getElementById('config-editor-command').value = 'npm test';

        const submitBtn = document.querySelector(
            '.config-editor-footer .btn-accent',
        );
        expect(submitBtn).toBeTruthy();
        submitBtn.click();

        const result = await settleOr(promise);
        expect(result).toEqual({ name: 'tests', command: 'npm test' });
    });

    it('resolves null when cancelled', async () => {
        const promise = openEditor();
        const cancelBtn = document.querySelector(
            '.config-editor-footer .btn:not(.btn-accent)',
        );
        cancelBtn.click();
        const result = await settleOr(promise);
        expect(result).toBeNull();
    });

    it('does not close and discard the draft when the backdrop is clicked', async () => {
        const promise = openEditor();
        document.getElementById('config-editor-name').value = 'tests';
        document.getElementById('config-editor-command').value = 'npm test';

        document.querySelector('.config-editor-overlay').click();
        expect(await settleOr(promise, 80)).toBe('__timeout__');

        document
            .querySelector('.config-editor-footer .btn:not(.btn-accent)')
            .click();
        expect(await settleOr(promise)).toBeNull();
    });

    it('does not submit while a required field is empty', async () => {
        const promise = openEditor();
        // leave name empty, fill command
        document.getElementById('config-editor-command').value = 'npm test';
        document.querySelector('.config-editor-footer .btn-accent').click();
        const result = await settleOr(promise, 80);
        expect(result).toBe('__timeout__'); // stayed open, no resolution
    });
});
