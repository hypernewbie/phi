import { describe, it, expect } from 'vitest';
import { cpuLevel } from '../web/util.js';

// cpuLevel maps CPU % to a brand indicator class. Thresholds are strict '>'.

describe('cpuLevel', () => {
    it('idle at or below 30', () => {
        expect(cpuLevel(0)).toBe('cpu-idle');
        expect(cpuLevel(30)).toBe('cpu-idle');
    });

    it('moderate above 30 up to 70', () => {
        expect(cpuLevel(31)).toBe('cpu-moderate');
        expect(cpuLevel(70)).toBe('cpu-moderate');
    });

    it('high above 70 up to 90', () => {
        expect(cpuLevel(71)).toBe('cpu-high');
        expect(cpuLevel(90)).toBe('cpu-high');
    });

    it('critical above 90', () => {
        expect(cpuLevel(91)).toBe('cpu-critical');
        expect(cpuLevel(100)).toBe('cpu-critical');
    });

    it('boundary values use strict greater-than', () => {
        // exactly on a threshold stays in the lower band
        expect(cpuLevel(30)).toBe('cpu-idle');
        expect(cpuLevel(70)).toBe('cpu-moderate');
        expect(cpuLevel(90)).toBe('cpu-high');
    });
});
