import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHeadlessSandbox } from './_xtermHeadless.js';

const vm = createHeadlessSandbox();
vm.ctx.module = { exports: {} };
vm.runSource(
    readFileSync(
        join(
            process.cwd(),
            'node_modules/@xterm/addon-serialize/lib/addon-serialize.js',
        ),
        'utf8',
    ),
    'serialize-addon.js',
);
export const { Terminal } = vm;
export const { SerializeAddon } = vm.ctx.module.exports;
export const parse = (term, bytes) =>
    new Promise((resolve) => term.write(bytes, resolve));

export function terminalState(term) {
    const b = term.buffer.active;
    return {
        cols: term.cols,
        rows: term.rows,
        type: b.type,
        cursor: [b.cursorX, b.cursorY],
        baseY: b.baseY,
        modes: { ...term.modes },
        lines: Array.from({ length: b.length }, (_, row) => {
            const line = b.getLine(row);
            return {
                wrapped: line.isWrapped,
                cells: Array.from({ length: term.cols }, (_, col) => {
                    const c = line.getCell(col);
                    return [
                        c.getChars(),
                        c.getWidth(),
                        c.getFgColorMode(),
                        c.getFgColor(),
                        c.getBgColorMode(),
                        c.getBgColor(),
                        c.isBold(),
                        c.isDim(),
                        c.isItalic(),
                        c.isUnderline(),
                        c.getUnderlineStyle(),
                        c.getUnderlineColorMode(),
                        c.getUnderlineColor(),
                        c.isOverline(),
                        c.isInvisible(),
                        c.isStrikethrough(),
                        c.isInverse(),
                        c.isBlink(),
                    ];
                }),
            };
        }),
    };
}

export function firstDifference(expected, actual, path = '$') {
    if (Object.is(expected, actual)) return null;
    if (
        expected === null ||
        actual === null ||
        typeof expected !== 'object' ||
        typeof actual !== 'object'
    ) {
        return { path, expected, actual };
    }
    const expectedArray = Array.isArray(expected);
    if (expectedArray !== Array.isArray(actual))
        return {
            path,
            expected: expectedArray ? 'array' : 'object',
            actual: Array.isArray(actual) ? 'array' : 'object',
        };
    if (expectedArray && expected.length !== actual.length)
        return {
            path: `${path}.length`,
            expected: expected.length,
            actual: actual.length,
        };
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of keys) {
        const difference = firstDifference(
            expected[key],
            actual[key],
            expectedArray ? `${path}[${key}]` : `${path}.${key}`,
        );
        if (difference) return difference;
    }
    return null;
}
