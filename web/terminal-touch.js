/* Φ phi — touch gestures for the terminal pane (mobile web) */
import { findTerminalLineLinks } from './util.js';
const MOVE_TOLERANCE_PX = 10;
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
    function onTouchStart(event) {
        const t = event.touches.length === 1 ? event.touches[0] : null;
        startPoint = t ? { clientX: t.clientX, clientY: t.clientY } : null;
        startViewportY = term.buffer.active.viewportY;
    }
    function onTouchEnd(event) {
        const start = startPoint;
        startPoint = null;
        if (!start || !isScreenTarget(event.target))
            return;
        if (event.touches.length !== 0)
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
    container.addEventListener('touchstart', onTouchStart, {
        capture: true,
        passive: true,
    });
    container.addEventListener('touchend', onTouchEnd, {
        capture: true,
        passive: true,
    });
    return {
        isSelecting: () => false,
        clear: () => { },
        dispose: () => {
            container.removeEventListener('touchstart', onTouchStart, {
                capture: true,
            });
            container.removeEventListener('touchend', onTouchEnd, {
                capture: true,
            });
            startPoint = null;
        },
    };
}
