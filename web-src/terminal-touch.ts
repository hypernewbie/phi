/* Φ phi — touch gestures for the terminal pane (mobile web) */

import type { Terminal } from '@xterm/xterm';
import { findTerminalLineLinks, type TerminalLinkMatch } from './util.js';

export interface TouchTerminalOptions {
    term: Terminal;
    container: HTMLElement;
    openLink: (url: string) => void;
    copyText: (text: string) => void;
}

export interface TouchTerminalController {
    /** True while the touch gesture owns selection and clipboard events. */
    isSelecting(): boolean;
    /** True only once a touch selection actually exists on the screen. */
    hasSelection(): boolean;
    /** Clear the touch selection and hide the pill. Auto-copy stays off. */
    clear(): void;
    /** Remove every listener, timer and DOM node this controller owns. */
    dispose(): void;
}

/** The private xterm services this module reaches for, guarded at every
 *  use. They are not part of the public Terminal type. */
interface TouchTerminalInternals {
    _core?: {
        _mouseCoordsService?: {
            getCoords(
                event: { clientX: number; clientY: number },
                element: HTMLElement,
                colCount: number,
                rowCount: number,
                isSelection?: boolean,
            ): [number, number] | undefined;
        };
        _selectionService?: {
            _getWordAt?(
                coords: [number, number],
                allowWhitespaceOnlySelection: boolean,
                followWrappedLinesAbove?: boolean,
                followWrappedLinesBelow?: boolean,
            ): { start: number; length: number } | undefined;
        };
    };
}

const MOVE_TOLERANCE_PX = 10;
const LONG_PRESS_MS = 500;

/** linkAtCell returns the link whose range contains the cell.
 *  col1 and row1 are 1-based, matching the link ranges. */
export function linkAtCell(
    links: TerminalLinkMatch[] | null | undefined,
    col1: number,
    row1: number,
): TerminalLinkMatch | undefined {
    if (!Array.isArray(links)) return undefined;
    for (const link of links) {
        const { start, end } = link.range;
        if (row1 < start.y || row1 > end.y) continue;
        if (start.y === end.y) {
            if (col1 >= start.x && col1 <= end.x) return link;
            continue;
        }
        if (row1 === start.y) {
            if (col1 >= start.x) return link;
            continue;
        }
        if (row1 === end.y) {
            if (col1 <= end.x) return link;
            continue;
        }
        return link; // a row strictly between the ends is fully covered
    }
    return undefined;
}

export function cellIndex(col: number, row: number, cols: number): number {
    return row * cols + col;
}

export function selectionRange(
    startIndex: number,
    endIndex: number,
    cols: number,
): { col: number; row: number; length: number } {
    const from = Math.min(startIndex, endIndex);
    const to = Math.max(startIndex, endIndex);
    return {
        col: from % cols,
        row: Math.floor(from / cols),
        length: to - from + 1,
    };
}

export function installTerminalTouch(
    options: TouchTerminalOptions,
): TouchTerminalController | null {
    const { term, container } = options;
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return null;
    // Re-bind as a non-optional const: closures below keep the narrowing.
    const screenEl: HTMLElement = screen;
    const internals = term as unknown as TouchTerminalInternals;

    let startPoint: { clientX: number; clientY: number } | null = null;
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
    let lastRange: { col: number; row: number; length: number } | null = null;
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let pill: HTMLButtonElement | null = null;
    let scrollSub: { dispose(): void } | null = null;
    let docListenerActive = false;
    let frame: number | null = null;

    function clamp(value: number, min: number, max: number): number {
        return value < min ? min : value > max ? max : value;
    }

    // cellAt maps a viewport point to a 1-based cell, or undefined when the
    // point is outside the screen.
    function cellAt(
        clientX: number,
        clientY: number,
        isSelection: boolean,
    ): { col1: number; row1: number } | undefined {
        const rect = screenEl.getBoundingClientRect();
        if (
            clientX < rect.left ||
            clientX > rect.right ||
            clientY < rect.top ||
            clientY > rect.bottom
        )
            return undefined;
        if (term.cols <= 0 || term.rows <= 0) return undefined;
        try {
            const coords = internals._core?._mouseCoordsService?.getCoords(
                { clientX, clientY },
                screenEl,
                term.cols,
                term.rows,
                isSelection,
            );
            if (coords) {
                return {
                    col1: clamp(Math.round(coords[0]), 1, term.cols),
                    row1: clamp(Math.round(coords[1]), 1, term.rows),
                };
            }
        } catch {
            /* fall through to the geometric mapping */
        }
        const cellW = rect.width / term.cols;
        const cellH = rect.height / term.rows;
        if (cellW <= 0 || cellH <= 0) return undefined;
        return {
            col1: clamp(
                Math.floor((clientX - rect.left) / cellW) + 1,
                1,
                term.cols,
            ),
            row1: clamp(
                Math.floor((clientY - rect.top) / cellH) + 1,
                1,
                term.rows,
            ),
        };
    }

    function isScreenTarget(target: EventTarget | null): boolean {
        return target instanceof Element && screenEl.contains(target);
    }

    function dropTimer(): void {
        if (longPressTimer !== null) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }
    }

    function hidePill(): void {
        if (pill) pill.hidden = true;
    }

    function ensurePill(): HTMLButtonElement {
        if (pill) return pill;
        const button = document.createElement('button');
        button.className = 'terminal-copy-pill';
        button.type = 'button';
        button.textContent = 'Copy';
        button.setAttribute('aria-label', 'Copy selection');
        button.hidden = true;
        button.addEventListener('click', () => {
            const sel = term.getSelection();
            if (sel) options.copyText(sel);
            clear();
        });
        container.appendChild(button);
        pill = button;
        return button;
    }

    function placePill(): void {
        if (!pill || !selectionActive) return;
        const button = pill;
        button.hidden = false;
        const width = button.offsetWidth;
        const height = button.offsetHeight;
        if (width <= 0 || height <= 0) {
            // The pane is hidden (display: none); a zero-size measurement
            // would put the pill at a bogus position.
            button.hidden = true;
            return;
        }
        const pos = term.getSelectionPosition();
        if (!pos) {
            button.hidden = true;
            return;
        }
        const screenRect = screenEl.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const cols = term.cols;
        const rows = term.rows;
        if (cols <= 0 || rows <= 0) {
            button.hidden = true;
            return;
        }
        const viewportY = term.buffer.active.viewportY;
        if (pos.start.y - viewportY > rows - 1 || pos.end.y - viewportY < 0) {
            button.hidden = true;
            return;
        }
        const cellW = screenRect.width / cols;
        const cellH = screenRect.height / rows;
        const row = clamp(pos.start.y - viewportY, 0, rows - 1);
        const endRow = clamp(pos.end.y - viewportY, 0, rows - 1);
        const originX = screenRect.left - containerRect.left;
        const originY = screenRect.top - containerRect.top;
        let x = originX + clamp(pos.start.x, 0, cols - 1) * cellW;
        let top = originY + row * cellH - height - 8;
        if (top < 0) top = originY + (endRow + 1) * cellH + 8;
        const maxX = Math.max(0, container.clientWidth - width);
        const maxY = Math.max(0, container.clientHeight - height);
        x = clamp(x, 0, maxX);
        top = clamp(top, 0, maxY);
        button.style.left = `${Math.round(x)}px`;
        button.style.top = `${Math.round(top)}px`;
        button.hidden = false;
    }

    function schedulePlacement(): void {
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
            frame = null;
            placePill();
        });
    }

    function onDocumentTouchStart(event: TouchEvent): void {
        if (event.touches.length > 1) return;
        const target = event.target;
        if (pill && target instanceof Node && pill.contains(target)) return;
        clear();
    }

    function attachDocumentClear(): void {
        if (docListenerActive) return;
        document.addEventListener('touchstart', onDocumentTouchStart, {
            capture: true,
            passive: true,
        });
        docListenerActive = true;
    }

    function detachDocumentClear(): void {
        if (!docListenerActive) return;
        document.removeEventListener('touchstart', onDocumentTouchStart, {
            capture: true,
        });
        docListenerActive = false;
    }

    function attachScroll(): void {
        if (scrollSub) return;
        if (typeof term.onScroll !== 'function') return;
        scrollSub = term.onScroll(() => schedulePlacement());
    }

    function detachScroll(): void {
        scrollSub?.dispose();
        scrollSub = null;
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }
    }

    function clear(): void {
        dropTimer();
        detachDocumentClear();
        detachScroll();
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

    function onLongPress(): void {
        longPressFired = true;
        if (!touchActive || !startPoint) return;
        const cell = cellAt(startPoint.clientX, startPoint.clientY, false);
        if (!cell) return;
        const row0 = startViewportY + cell.row1 - 1;
        const col0 = cell.col1 - 1;
        let word: { start: number; length: number } | undefined;
        try {
            word = internals._core?._selectionService?._getWordAt?.(
                [col0, row0],
                false,
                false,
                false,
            );
        } catch {
            word = undefined;
        }
        if (
            !word ||
            !Number.isInteger(word.start) ||
            !Number.isInteger(word.length) ||
            word.length <= 0
        ) {
            word = { start: col0, length: 1 };
        }
        selectionActive = true;
        try {
            term.select(word.start, row0, word.length);
        } catch {
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
        ensurePill();
        attachDocumentClear();
        attachScroll();
        placePill();
    }

    function onTouchStart(event: TouchEvent): void {
        if (event.touches.length !== 1) {
            // A second finger turns the gesture into a pinch: never select.
            dropTimer();
            moved = true;
            touchActive = false;
            touchGestureActive = false;
            startPoint = null;
            return;
        }
        if (!isScreenTarget(event.target)) return;
        // A new gesture owns the screen again. Clearing here is what keeps
        // the terminal scrollable: a selection that is never released would
        // make every later touchmove extend it instead of scrolling.
        if (selectionActive) clear();
        const t = event.touches[0];
        if (!t) return;
        startPoint = { clientX: t.clientX, clientY: t.clientY };
        startViewportY = term.buffer.active.viewportY;
        moved = false;
        longPressFired = false;
        touchActive = true;
        touchGestureActive = true;
        dropTimer();
        longPressTimer = setTimeout(onLongPress, LONG_PRESS_MS);
    }

    function onTouchEnd(event: TouchEvent): void {
        dropTimer();
        touchActive = false;
        touchGestureActive = false;
        const start = startPoint;
        startPoint = null;
        if (!start || !isScreenTarget(event.target)) return;
        if (event.touches.length !== 0) return;
        if (longPressFired || moved) return;
        const t = event.changedTouches[0];
        if (!t) return;
        if (
            Math.abs(t.clientX - start.clientX) > MOVE_TOLERANCE_PX ||
            Math.abs(t.clientY - start.clientY) > MOVE_TOLERANCE_PX
        )
            return;
        const cell = cellAt(start.clientX, start.clientY, false);
        if (!cell) return;
        const bufferRow1 = startViewportY + cell.row1;
        const links = findTerminalLineLinks(term.buffer.active, bufferRow1);
        const link = linkAtCell(links, cell.col1, bufferRow1);
        if (link) options.openLink(link.text);
    }

    function onTouchMove(event: TouchEvent): void {
        if (!touchActive || !startPoint) return;
        if (event.touches.length !== 1) return;
        const t = event.touches[0];
        if (!t) return;
        if (
            Math.abs(t.clientX - startPoint.clientX) > MOVE_TOLERANCE_PX ||
            Math.abs(t.clientY - startPoint.clientY) > MOVE_TOLERANCE_PX
        ) {
            moved = true;
            dropTimer();
        }
        if (!selectionActive) return;
        event.preventDefault();
        event.stopPropagation();
        const cell = cellAt(t.clientX, t.clientY, true);
        if (!cell) return;
        const row0 = term.buffer.active.viewportY + cell.row1 - 1;
        const focusIndex = cellIndex(
            Math.min(cell.col1 - 1, term.cols - 1),
            row0,
            term.cols,
        );
        const from = focusIndex <= wordStartIndex ? focusIndex : wordStartIndex;
        const to = focusIndex >= wordEndIndex ? focusIndex : wordEndIndex;
        const range = selectionRange(from, to, term.cols);
        if (
            lastRange &&
            lastRange.col === range.col &&
            lastRange.row === range.row &&
            lastRange.length === range.length
        )
            return;
        term.select(range.col, range.row, range.length);
        lastRange = range;
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

    function onTouchCancel(): void {
        dropTimer();
        touchActive = false;
        touchGestureActive = false;
        clear();
    }

    container.addEventListener('touchcancel', onTouchCancel, {
        capture: true,
        passive: true,
    });

    return {
        isSelecting: () => selectionActive || touchGestureActive,
        hasSelection: () => selectionActive,
        clear,
        dispose: () => {
            dropTimer();
            detachDocumentClear();
            detachScroll();
            container.removeEventListener('touchstart', onTouchStart, {
                capture: true,
            });
            container.removeEventListener('touchend', onTouchEnd, {
                capture: true,
            });
            container.removeEventListener('touchmove', onTouchMove, {
                capture: true,
            });
            container.removeEventListener('touchcancel', onTouchCancel, {
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
