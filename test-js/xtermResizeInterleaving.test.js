import { describe, expect, it } from 'vitest';
import { createHeadlessSandbox } from './_xtermHeadless.js';

function makeTerminal() {
    const { Terminal, ctx } = createHeadlessSandbox();
    const timers = [];
    let now = 0;
    ctx.performance.now = () => now;
    ctx.setTimeout = (callback) => {
        timers.push(callback);
        return timers.length;
    };
    ctx.clearTimeout = () => {};

    const term = new Terminal({ cols: 80, rows: 24, scrollback: 1000 });
    const writeBuffer = term._core._writeBuffer;
    const actions = [];
    const parse = writeBuffer._action;
    writeBuffer._action = function (data, promiseResult) {
        actions.push(data);
        const result = parse.call(this, data, promiseResult);
        if (data === 'A') now = 13;
        return result;
    };

    return {
        actions,
        term,
        timers,
        writeBuffer,
        runNextTimer() {
            const callback = timers.shift();
            if (!callback) throw new Error('no xterm timer was queued');
            callback();
        },
        drainTimers() {
            let runs = 0;
            while (timers.length && runs++ < 20) timers.shift()();
            if (timers.length) throw new Error('xterm timers did not drain');
        },
    };
}

function firstLine(term) {
    return term.buffer.active.getLine(0).translateToString(true);
}

describe('real xterm resize during sliced writes', () => {
    it('does not replay a parsed chunk when resize flushes pending writes', () => {
        const h = makeTerminal();
        const callbacks = [];
        h.term.write('A', () => callbacks.push('A'));
        h.term.write('B', () => callbacks.push('B'));

        h.runNextTimer();

        expect(h.writeBuffer._bufferOffset).toBe(1);
        expect(h.writeBuffer._writeBuffer).toEqual(['A', 'B']);
        expect(callbacks).toEqual(['A']);
        h.term.resize(81, 24);
        h.drainTimers();

        expect(firstLine(h.term)).toBe('AB');
        expect(h.actions).toEqual(['A', 'B']);
        expect(callbacks).toEqual(['A', 'B']);

        h.term.write('C', () => callbacks.push('C'));
        h.drainTimers();
        expect(firstLine(h.term)).toBe('ABC');
        expect(callbacks).toEqual(['A', 'B', 'C']);
        h.term.dispose();
    });

    it('keeps callbacks aligned when a callback enqueues another write', () => {
        const h = makeTerminal();
        const callbacks = [];
        h.term.write('A', () => {
            callbacks.push('A');
            h.term.write('B', () => callbacks.push('B'));
        });

        h.runNextTimer();

        expect(h.writeBuffer._bufferOffset).toBe(1);
        expect(h.writeBuffer._writeBuffer).toEqual(['A', 'B']);
        h.term.resize(81, 24);
        h.drainTimers();

        expect(firstLine(h.term)).toBe('AB');
        expect(h.actions).toEqual(['A', 'B']);
        expect(callbacks).toEqual(['A', 'B']);
        h.term.dispose();
    });

    it('flushes empty chunks without dropping later callbacks or text', () => {
        const h = makeTerminal();
        const callbacks = [];
        h.term.write('A', () => callbacks.push('A'));
        h.term.write('', () => callbacks.push('empty'));
        h.term.write('B', () => callbacks.push('B'));

        h.runNextTimer();

        expect(h.writeBuffer._bufferOffset).toBe(1);
        expect(h.writeBuffer._writeBuffer).toEqual(['A', '', 'B']);
        h.term.resize(81, 24);
        h.drainTimers();

        expect(firstLine(h.term)).toBe('AB');
        expect(h.actions).toEqual(['A', '', 'B']);
        expect(callbacks).toEqual(['A', 'empty', 'B']);
        h.term.dispose();
    });
});
