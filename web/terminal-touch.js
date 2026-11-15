/* Φ phi — touch gestures for the terminal pane (mobile web) */
import { findTerminalLineLinks } from './util.js';
const MOVE_TOLERANCE_PX = 10;
const LONG_PRESS_MS = 500;
/** linkAtCell returns the link whose range contains the cell.
 *  col1 and row1 are 1-based, matching the link ranges. */
export function linkAtCell(links, col1, row1) {
    if (!Array.isArray(links))
        return undefined;
    for (const link of links) {
        const { start, end } = link.range;
        if (row1 < start.y || row1 > end.y)
            continue;
        if (start.y === end.y) {
            if (col1 >= start.x && col1 <= end.x)
                return link;
            continue;
        }
        if (row1 === start.y) {
            if (col1 >= start.x)
                return link;
            continue;
        }
        if (row1 === end.y) {
            if (col1 <= end.x)
                return link;
            continue;
        }
        return link; // a row strictly between the ends is fully covered
    }
    return undefined;
}
export function cellIndex(col, row, cols) {
    return row * cols + col;
}
export function installTerminalTouch(options) {
    const { term, container } = options;
    const screen = term.element?.querySelector('.xterm-screen');
    if (!screen)
        return null;
    // Re-bind as a non-optional const: closures below keep the narrowing.
    const screenEl = screen;
    const internals = term;
    let startPoint = null;
    let startViewportY = 0;
    let selectionActive = false;
    // True for the whole touch gesture on the screen. xterm's own long-press
    // contextmenu selects a word at ~700 ms, before this controller's timer on
    // a slow device, so ownership must start at touchstart and not at the
    // moment the selection is created.
    let touchGestureActive = false;
    let longPressFired = false;
    let touchActive = false;
    let moved = false;
    let wordStartIndex = 0;
    let wordEndIndex = 0;
    let lastRange = null;
    let longPressTimer = null;
    let pill = null;
    function clamp(value, min, max) {
        return value < min ? min : value > max ? max : value;
    }
    // cellAt maps a viewport point to a 1-based cell, or undefined when the
    // point is outside the screen.
    function cellAt(clientX, clientY, isSelection) {
        const rect = screenEl.getBoundingClientRect();
        if (clientX < rect.left ||
            clientX > rect.right ||
            clientY < rect.top ||
            clientY > rect.bottom)
            return undefined;
        if (term.cols <= 0 || term.rows <= 0)
            return undefined;
        try {
            const coords = internals._core?._mouseCoordsService?.getCoords({ clientX, clientY }, screenEl, term.cols, term.rows, isSelection);
            if (coords) {
                return {
                    col1: clamp(Math.round(coords[0]), 1, term.cols),
                    row1: clamp(Math.round(coords[1]), 1, term.rows),
                };
            }
        }
        catch {
            /* fall through to the geometric mapping */
        }
        const cellW = rect.width / term.cols;
        const cellH = rect.height / term.rows;
        if (cellW <= 0 || cellH <= 0)
            return undefined;
        return {
            col1: clamp(Math.floor((clientX - rect.left) / cellW) + 1, 1, term.cols),
            row1: clamp(Math.floor((clientY - rect.top) / cellH) + 1, 1, term.rows),
        };
    }
    function isScreenTarget(target) {
        return target instanceof Element && screenEl.contains(target);
    }
    function dropTimer() {
        if (longPressTimer !== null) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    }
    function hidePill() {
        if (pill)
            pill.hidden = true;
    }
    function ensurePill() {
        if (pill)
            return pill;
        const button = document.createElement('button');
        button.className = 'terminal-copy-pill';
        button.type = 'button';
        button.textContent = 'Copy';
        button.setAttribute('aria-label', 'Copy selection');
        button.hidden = true;
        button.addEventListener('click', () => {
            const sel = term.getSelection();
            if (sel)
                options.copyText(sel);
            clear();
        });
        container.appendChild(button);
        pill = button;
        return button;
    }
    function clear() {
        dropTimer();
        if (selectionActive) {
            // Still flagged while the selection is torn down: the app's
            // auto-copy listener must see it as touch-owned.
            term.clearSelection();
            selectionActive = false;
        }
        hidePill();
        moved = false;
        longPressFired = false;
        touchActive = false;
        touchGestureActive = false;
        startPoint = null;
        startViewportY = 0;
        lastRange = null;
    }
    function onLongPress() {
        longPressFired = true;
        if (!touchActive || !startPoint)
            return;
        const cell = cellAt(startPoint.clientX, startPoint.clientY, false);
        if (!cell)
            return;
        const row0 = startViewportY + cell.row1 - 1;
        const col0 = cell.col1 - 1;
        let word;
        try {
            word = internals._core?._selectionService?._getWordAt?.([col0, row0], false, false, false);
        }
        catch {
            word = undefined;
        }
        if (!word ||
            !Number.isInteger(word.start) ||
            !Number.isInteger(word.length) ||
            word.length <= 0) {
            word = { start: col0, length: 1 };
        }
        selectionActive = true;
        try {
            term.select(word.start, row0, word.length);
        }
        catch {
            selectionActive = false;
            return;
        }
        if (!term.hasSelection()) {
            selectionActive = false;
            return;
        }
        wordStartIndex = cellIndex(word.start, row0, term.cols);
        wordEndIndex = wordStartIndex + word.length - 1;
        lastRange = { col: word.start, row: row0, length: word.length };
        ensurePill().hidden = false;
    }
    function onTouchStart(event) {
        if (event.touches.length !== 1) {
            // A second finger turns the gesture into a pinch: never select.
            dropTimer();
            moved = true;
            touchActive = false;
            touchGestureActive = false;
            startPoint = null;
            return;
        }
        if (!isScreenTarget(event.target))
            return;
        const t = event.touches[0];
        if (!t)
            return;
        startPoint = { clientX: t.clientX, clientY: t.clientY };
        startViewportY = term.buffer.active.viewportY;
        moved = false;
        longPressFired = false;
        touchActive = true;
        touchGestureActive = true;
        dropTimer();
        longPressTimer = setTimeout(onLongPress, LONG_PRESS_MS);
    }
    function onTouchEnd(event) {
        dropTimer();
        touchActive = false;
        touchGestureActive = false;
        const start = startPoint;
        startPoint = null;
        if (!start || !isScreenTarget(event.target))
            return;
        if (event.touches.length !== 0)
            return;
        if (longPressFired || moved)
            return;
        const t = event.changedTouches[0];
        if (!t)
            return;
        if (Math.abs(t.clientX - start.clientX) > MOVE_TOLERANCE_PX ||
            Math.abs(t.clientY - start.clientY) > MOVE_TOLERANCE_PX)
            return;
        const cell = cellAt(start.clientX, start.clientY, false);
        if (!cell)
            return;
        const bufferRow1 = startViewportY + cell.row1;
        const links = findTerminalLineLinks(term.buffer.active, bufferRow1);
        const link = linkAtCell(links, cell.col1, bufferRow1);
        if (link)
            options.openLink(link.text);
    }
    function onTouchMove(event) {
        if (!touchActive || !startPoint)
            return;
        if (event.touches.length !== 1)
            return;
        const t = event.touches[0];
        if (!t)
            return;
        if (Math.abs(t.clientX - startPoint.clientX) > MOVE_TOLERANCE_PX ||
            Math.abs(t.clientY - startPoint.clientY) > MOVE_TOLERANCE_PX) {
            moved = true;
            dropTimer();
        }
    }
    container.addEventListener('touchstart', onTouchStart, {
        capture: true,
        passive: true,
    });
    container.addEventListener('touchend', onTouchEnd, {
        capture: true,
        passive: true,
    });
    container.addEventListener('touchmove', onTouchMove, {
        capture: true,
        passive: false,
    });
    return {
        isSelecting: () => selectionActive || touchGestureActive,
        clear,
        dispose: () => {
            dropTimer();
            container.removeEventListener('touchstart', onTouchStart, {
                capture: true,
            });
            container.removeEventListener('touchend', onTouchEnd, {
                capture: true,
            });
            container.removeEventListener('touchmove', onTouchMove, {
                capture: true,
            });
            selectionActive = false;
            touchActive = false;
            touchGestureActive = false;
            startPoint = null;
            pill?.remove();
            pill = null;
            lastRange = null;
        },
    };
}
