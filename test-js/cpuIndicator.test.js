// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { setupDomHarness } from './_dom.js';
import { TabManager } from '../web/terminal.js';

setupDomHarness();

describe('CPU brand indicator', () => {
    let tm;
    let logo;
    let brandName;

    beforeEach(() => {
        document.body.innerHTML = `
            <div class="brand">
                <span class="logo">Φ</span>
                <span class="brand-name">phi</span>
            </div>
        `;
        logo = document.querySelector('.brand .logo');
        brandName = document.querySelector('.brand .brand-name');
        tm = Object.create(TabManager.prototype);
        tm.lastCpuPercent = null;
    });

    it('exposes the exact received percent in data-cpu-pct', () => {
        tm.applyCPUIndicator(42.5);
        expect(logo.dataset.cpuPct).toBe('42.5');
        expect(tm.lastCpuPercent).toBe(42.5);
    });

    it('applies the tier class as before', () => {
        tm.applyCPUIndicator(42.5);
        expect(logo.dataset.cpuLevel).toBe('cpu-moderate');
        expect(logo.classList.contains('cpu-moderate')).toBe(true);
        expect(brandName.classList.contains('cpu-moderate')).toBe(true);
    });

    it('refreshes data-cpu-pct on each poll even when the tier is unchanged', () => {
        tm.applyCPUIndicator(10);
        tm.applyCPUIndicator(18);
        expect(logo.dataset.cpuPct).toBe('18');
        expect(logo.dataset.cpuLevel).toBe('cpu-idle');
        expect(logo.classList.contains('cpu-idle')).toBe(true);
    });
});
