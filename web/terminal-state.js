// Continuation state omitted by xterm's SerializeAddon. This is tied to the
// vendored xterm version and checked against its real parser in regression tests.
const CSI = '\x1b[';

function charsetName(map) {
    if (!map) return 'B';
    if (map.q === '─' && map.l === '┌') return '0';
    if (Object.keys(map).length === 1 && map['#'] === '£') return 'A';
    // Do not claim a checkpoint can restore an unknown character set.
    throw new Error('unsupported checkpoint character set');
}

function charsets(maps, level) {
    let ansi = '';
    for (let i = 0; i < 4; i++) ansi += `\x1b${'()*+'[i]}${charsetName(maps?.[i])}`;
    return ansi + (level === 1 ? '\x0e' : level === 2 ? '\x1bn' : level === 3 ? '\x1bo' : '\x0f');
}

function attributes(a) {
    if (!a) return `${CSI}0m`;
    const codes = [0];
    for (const [method, code] of [['isBold', 1], ['isDim', 2], ['isItalic', 3],
        ['isUnderline', 4], ['isBlink', 5], ['isInverse', 7], ['isInvisible', 8],
        ['isStrikethrough', 9], ['isOverline', 53]]) {
        if (a[method]?.()) codes.push(code);
    }
    for (const [side, base] of [['Fg', 38], ['Bg', 48]]) {
        const mode = a[`get${side}ColorMode`]?.();
        const color = a[`get${side}Color`]?.();
        if (mode === 0x1000000) codes.push((side === 'Fg' ? 30 : 40) + (color < 8 ? color : color + 52));
        else if (mode === 0x2000000) codes.push(base, 5, color);
        else if (mode === 0x3000000) codes.push(base, 2, color >>> 16 & 255, color >>> 8 & 255, color & 255);
    }
    return `${CSI}${codes.join(';')}m`;
}

function ident(code) {
    let text = '';
    for (; code; code >>>= 8) text = String.fromCharCode(code & 255) + text;
    return text;
}

function params(p) {
    const parts = [];
    for (const n of p.toArray()) {
        if (Array.isArray(n)) parts[parts.length - 1] += ':' + n.map(x => x < 0 ? '' : x).join(':');
        else parts.push(String(n));
    }
    return parts.join(';');
}

function pending(p) {
    const collect = ident(p._collect);
    const parameterized = () => {
        const privatePrefix = [...collect].filter(c => c.charCodeAt(0) >= 0x3c).join('');
        const intermediate = [...collect].filter(c => c.charCodeAt(0) < 0x3c).join('');
        return privatePrefix + params(p._params) + intermediate;
    };
    switch (p.currentState) {
        case 0: return '';
        case 1: case 2: return '\x1b' + collect;
        case 3: case 4: case 5: return CSI + parameterized();
        case 8: {
            const osc = p._oscParser;
            if (osc._state === 1) return '\x1b]' + (osc._id < 0 ? '' : osc._id);
            const handler = osc._active[0];
            if (!handler?._data || handler._hitLimit) throw new Error('unsupported pending OSC checkpoint');
            return `\x1b]${osc._id};${handler._data.toString()}`;
        }
        case 9: case 10: case 11: return '\x1bP' + parameterized();
        case 13: {
            const dcs = p._dcsParser;
            const handler = dcs._active[0];
            if (!handler?._data || handler._hitLimit) throw new Error('unsupported pending DCS checkpoint');
            const id = ident(dcs._ident);
            return '\x1bP' + params(handler._params) + id + handler._data.toString();
        }
        default: throw new Error('unsupported checkpoint parser state');
    }
}

export function terminalContinuation(term) {
    const core = term._core;
    const b = core?.buffer;
    const input = core?._inputHandler;
    // Lightweight terminal doubles do not expose the parser. Real xterm does.
    if (!b || !input?._parser) return '';
    const origin = Boolean(term.modes.originMode);
    const cup = (x, y, relative) => `${CSI}${Math.max(0, y - (relative ? b.scrollTop : 0)) + 1};${x + 1}H`;
    // DECSTBM and DECOM both home the cursor. Set the saved cursor first,
    // then the current position, after the addon restores those modes.
    let ansi = `${CSI}?6${b.savedOriginMode ? 'h' : 'l'}`;
    ansi += `${CSI}?7${b.savedWraparoundMode ? 'h' : 'l'}`;
    ansi += cup(b.savedX, Math.max(0, b.savedY - b.ybase), b.savedOriginMode);
    ansi += attributes(b.savedCurAttrData);
    ansi += charsets(b.savedCharsets, b.savedGlevel) + '\x1b7';
    ansi += `${CSI}?6${origin ? 'h' : 'l'}${CSI}?7${term.modes.wraparoundMode ? 'h' : 'l'}`;
    // Tab stops belong to the terminal buffer, not the displayed cells.
    ansi += `${CSI}3g`;
    for (const [col, set] of Object.entries(b.tabs)) {
        if (set) ansi += `${CSI}${Number(col) + 1}G\x1bH`;
    }
    ansi += cup(b.x, b.y, origin);
    ansi += attributes(input._curAttrData);
    ansi += charsets(core._charsetService._charsets, core._charsetService.glevel);
    // An unfinished command must be the very last bytes of the snapshot.
    return ansi + pending(input._parser);
}
