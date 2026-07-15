// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { SessionsManager } from '../web/sessions.js';

setupDomHarness();

function makeManager(activeCoder = 'bash') {
    const manager = Object.create(SessionsManager.prototype);
    manager.activeCoder = activeCoder;
    manager.loadSessions = vi.fn();
    return manager;
}

beforeEach(() => {
    document.body.innerHTML = `
        <button class="coder-tab" data-coder="bash"></button>
        <button class="coder-tab" data-coder="pi"></button>
        <button id="send-input-btn">Send ↵</button>
        <button id="pi-shortcut-send-btn" class="hidden">Ctrl+Shift+X</button>
    `;
});

describe('pi send shortcut', () => {
    it('adds the pi shortcut without replacing the staged Send button', () => {
        const manager = makeManager();

        manager.switchCoder('pi', true);

        expect(document.getElementById('pi-shortcut-send-btn').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('send-input-btn').classList.contains('hidden')).toBe(false);
    });

    it('hides the pi-only shortcut outside pi without affecting Send', () => {
        const manager = makeManager('pi');
        const chip = document.getElementById('pi-shortcut-send-btn');
        chip.classList.remove('hidden');

        manager.switchCoder('bash', true);

        expect(chip.classList.contains('hidden')).toBe(true);
        expect(document.getElementById('send-input-btn').classList.contains('hidden')).toBe(false);
    });
});
