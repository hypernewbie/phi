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
    const codes = ['0'];
    for (const [method, code] of [['isBold', 1], ['isDim', 2], ['isItalic', 3],
        ['isBlink', 5], ['isInverse', 7], ['isInvisible', 8],
        ['isStrikethrough', 9], ['isOverline', 53]]) {
        if (a[method]?.()) codes.push(String(code));
    }
    const underlineStyle = a.getUnderlineStyle?.() ?? (a.isUnderline?.() ? 1 : 0);
    if (underlineStyle > 1) codes.push(`4:${underlineStyle}`);
    else if (underlineStyle === 1 || a.isUnderline?.()) codes.push('4');
    const underlineMode = a.getUnderlineColorMode?.();
    const underlineColor = a.getUnderlineColor?.();
    if (!a.isUnderlineColorDefault?.()) {
        if (underlineMode === 0x2000000) codes.push(`58:5:${underlineColor}`);
        else if (underlineMode === 0x3000000) {
            codes.push(`58:2::${underlineColor >>> 16 & 255}:${underlineColor >>> 8 & 255}:${underlineColor & 255}`);
        }
    }
    for (const [side, base] of [['Fg', 38], ['Bg', 48]]) {
        const mode = a[`get${side}ColorMode`]?.();
        const color = a[`get${side}Color`]?.();
        if (mode === 0x1000000) codes.push(String((side === 'Fg' ? 30 : 40) + (color < 8 ? color : color + 52)));
        else if (mode === 0x2000000) codes.push(`${base};5;${color}`);
        else if (mode === 0x3000000) codes.push(`${base};2;${color >>> 16 & 255};${color >>> 8 & 255};${color & 255}`);
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

function setPrivateMode(mode, enabled) {
    return `${CSI}?${mode}${enabled ? 'h' : 'l'}`;
}

function cursorPosition(buffer, x, y, origin) {
    const relativeY = origin ? y - buffer.scrollTop : y;
    return `${CSI}${Math.max(0, relativeY) + 1};${x + 1}H`;
}

function restoreBufferState(term, buffer, bufferView, state) {
    const rows = term.rows;
    let ansi = setPrivateMode(6, false);
    ansi += `${CSI}r`;
    if (buffer.scrollTop !== 0 || buffer.scrollBottom !== rows - 1) {
        ansi += `${CSI}${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r`;
    }
    ansi += `${CSI}3g`;
    for (const [col, set] of Object.entries(buffer.tabs)) {
        if (set) ansi += `${CSI}${Number(col) + 1}G\x1bH`;
    }

    // Rebuild DECSC while this buffer is active. The serializer restores its
    // cells, but saved cursor attributes, charset, and origin mode are not
    // part of that screen data.
    ansi += setPrivateMode(6, Boolean(buffer.savedOriginMode));
    ansi += setPrivateMode(7, Boolean(buffer.savedWraparoundMode));
    ansi += cursorPosition(
        buffer,
        buffer.savedX,
        Math.max(0, buffer.savedY - buffer.ybase),
        Boolean(buffer.savedOriginMode),
    );
    ansi += attributes(buffer.savedCurAttrData);
    ansi += charsets(buffer.savedCharsets, buffer.savedGlevel);
    ansi += '\x1b7';

    ansi += setPrivateMode(6, state.origin);
    ansi += setPrivateMode(7, state.wraparound);
    ansi += cursorPosition(buffer, buffer.x, buffer.y, state.origin);
    ansi += attributes(state.attributes);
    ansi += charsets(state.charsets, state.charsetLevel);

    // xterm represents pending autowrap with x === cols. CUP cannot restore
    // that state. Reprint the cell at the right margin under its own rendition
    // to recreate the wrap-pending cursor without changing the visible cell.
    if (state.wraparound && buffer.x >= term.cols) {
        const line = bufferView.getLine(buffer.ybase + buffer.y);
        let col = term.cols - 1;
        let cell = line?.getCell(col);
        if (cell?.getWidth() === 0) cell = line.getCell(--col);
        const chars = cell?.getChars();
        if (!chars) throw new Error('cannot restore empty pending-wrap cell');
        ansi += cursorPosition(buffer, col, buffer.y, state.origin);
        ansi += attributes(cell);
        ansi += charsets(undefined, 0);
        ansi += chars;
        ansi += attributes(state.attributes);
        ansi += charsets(state.charsets, state.charsetLevel);
    }
    return ansi;
}

export function terminalContinuation(term) {
    const core = term._core;
    const input = core?._inputHandler;
    const buffers = core?._bufferService?.buffers;
    // Lightweight terminal doubles do not expose the parser. Real xterm does.
    if (!buffers || !input?._parser) return '';
    const normal = buffers.normal;
    const alternate = buffers.alt;
    const isAlternate = buffers.active === alternate;
    const activeState = {
        origin: Boolean(term.modes.originMode),
        wraparound: Boolean(term.modes.wraparoundMode),
        attributes: input._curAttrData,
        charsets: core._charsetService._charsets,
        charsetLevel: core._charsetService.glevel,
    };
    const normalState = {
        origin: Boolean(normal.savedOriginMode),
        wraparound: Boolean(normal.savedWraparoundMode),
        attributes: normal.savedCurAttrData,
        charsets: normal.savedCharsets,
        charsetLevel: normal.savedGlevel,
    };

    let ansi = '';
    if (isAlternate) {
        // Preserve the already-serialized alternate contents with DEC mode 47.
        // First enter normal mode to restore state that belongs to its buffer.
        ansi += `${CSI}?1049l`;
        ansi += restoreBufferState(term, normal, term.buffer.normal, normalState);
        ansi += `${CSI}?47h`;
        ansi += restoreBufferState(term, alternate, term.buffer.alternate, activeState);
    } else {
        ansi += restoreBufferState(term, normal, term.buffer.normal, activeState);
    }
    // An unfinished command must be the very last bytes of the snapshot.
    return ansi + pending(input._parser);
}
