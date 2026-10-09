import { resetTerminalState } from './terminal-state.js';

const MAX_CHECKPOINT_BYTES = 2 << 20;
const LIVE_SCROLLBACK_ROWS = 10000;
const HISTORY_MIN_STEP_BYTES = 4096;
export const HISTORY_BOOK_BYTES = 64 << 10;

export const terminalHistoryMethods = {
    _updateHistoryButton(tabInfo) {
        const button = tabInfo.loadHistoryBtn;
        if (!button) return;
        const buffer = tabInfo.term?.buffer?.active;
        // Scrolling only reveals this affordance. Fetching an older book
        // requires a click, even at the very first retained row.
        const visible = !tabInfo.isDead && !tabInfo.finalizing &&
            tabInfo._historyOmitted && tabInfo.ws?.mode === 'hot' &&
            (tabInfo._historyBrowsing || buffer?.type === 'normal') &&
            buffer?.viewportY <= tabInfo.term.rows;
        const loading = Boolean(tabInfo._historyLoading);
        button.classList.toggle('hidden', !visible);
        const disabled = !visible || loading;
        const tabIndex = visible ? 0 : -1;
        const busy = String(loading);
        const hidden = String(!visible);
        const title = loading ? 'Loading older history…' : 'Load older history';
        const icon = loading ? '…' : '\u2191';
        // Live output often leaves these unchanged. Avoid rewriting hidden
        // button text and attributes on every parsed terminal batch.
        if (button.disabled !== disabled) button.disabled = disabled;
        if (button.tabIndex !== tabIndex) button.tabIndex = tabIndex;
        if (button.getAttribute('aria-busy') !== busy) button.setAttribute('aria-busy', busy);
        if (button.getAttribute('aria-hidden') !== hidden) button.setAttribute('aria-hidden', hidden);
        if (button.title !== title) button.title = title;
        if (button.textContent !== icon) button.textContent = icon;
    },

    // New servers own the parser. A book starts from an exact parser state,
    // never a guessed byte boundary; the recording still owns every byte.
    async _fetchTerminalState(paneId, epoch, through, signal) {
        const response = await fetch(`/api/terminals/${encodeURIComponent(paneId)}/state?epoch=${epoch}&through=${through}&kind=ansi-v1`, { cache: 'no-store', signal });
        if (!response.ok) {
            if ([400, 404, 409, 413].includes(response.status)) {
                const error = new Error(`Terminal history unavailable (${response.status}); the requested book was not skipped.`);
                error.historyPermanent = true;
                throw error;
            }
            return null;
        }
        const body = new Uint8Array(await response.arrayBuffer());
        if (body.length < 4) return null;
        const size = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
        if (size > 4096 || size + 4 > body.length) return null;
        const header = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + size)));
        const c = header.ckpt;
        const bytes = body.subarray(4 + size);
        const frontier = through === 'latest' ? header.head : through;
        if (!Number.isSafeInteger(frontier) || frontier < 0 || header.epoch !== epoch || header.head !== frontier || !Number.isSafeInteger(header.oldest) || header.oldest < 0 || header.oldest > frontier ||
            !c || c.kind !== 'ansi-v1' || c.through !== frontier || c.len !== bytes.length || bytes.length > MAX_CHECKPOINT_BYTES ||
            !Number.isInteger(c.cols) || c.cols <= 0 || c.cols > 65535 || !Number.isInteger(c.rows) || c.rows <= 0 || c.rows > 65535) return null;
        return { ...c, bytes, oldest: header.oldest };
    },

    async _historyRead(tabInfo, read, signal) {
        let delay = 250;
        for (;;) {
            if (signal.aborted) throw signal.reason || new Error('History request canceled');
            try {
                const result = await read(signal);
                if (result) { tabInfo._historyError = null; return result; }
            } catch (error) {
                if (signal.aborted || error.historyPermanent) throw error;
            }
            if (!tabInfo._historyError) {
                tabInfo._historyError = 'History connection interrupted; retrying the requested book.';
                this.app?.showToast?.(tabInfo._historyError, { type: 'warning' });
            }
            // Retry the same span until success or explicit cancellation. A
            // transient failure never advances the page or discards its book.
            await new Promise((resolve, reject) => {
                const abort = () => { clearTimeout(timer); reject(signal.reason); };
                const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
                signal.addEventListener('abort', abort, { once: true });
            });
            delay = Math.min(5000, delay * 2);
        }
    },

    _cancelHistoryRequest(tabInfo) {
        tabInfo._historyRequest?.abort();
        // The task's finally clears flags only while it still owns this slot.
        // Clearing the slot here would strand _historyLoading on cancellation.
    },

    async _loadStateHistory(tabInfo, latest = false) {
        if (tabInfo.finalizing) return;
        if (tabInfo._historyLoading) {
            if (!latest) return;
            this._cancelHistoryRequest(tabInfo);
            await tabInfo._historyTask?.catch(() => {});
        }
        const request = new AbortController();
        tabInfo._historyRequest = request;
        tabInfo._historyLoading = true;
        this._updateHistoryButton(tabInfo);
        const epoch = tabInfo.paneEpoch;
        const current = () => !request.signal.aborted && !tabInfo.finalizing && tabInfo.paneEpoch === epoch;
        const task = (async () => {
            let pty, gate, finishGate;
            let reset = false;
            try {
                if (tabInfo._bootstrapGate) await tabInfo._bootstrapGate;
                if (!current()) return;
                const oldest = tabInfo.paneOldest ?? 0;
                const head = tabInfo.ws.lastFrameEnd ?? tabInfo.drainedSeq;
                const previousEnd = tabInfo._historyWindowEnd ?? head;
                const anchor = this._oldestHistoryAnchor(tabInfo);
                const end = latest ? head : !tabInfo._historyBrowsing ? head
                    : anchor && anchor.through > oldest && anchor.through < previousEnd ? anchor.through
                    : Math.max(oldest, previousEnd - HISTORY_MIN_STEP_BYTES);
                const from = latest ? end : Math.max(oldest, end - HISTORY_BOOK_BYTES);
                // Do not hold the socket while fetching/retrying. Resident
                // live delivery remains bounded; the current view stays intact.
                const state = await this._historyRead(tabInfo, signal => this._fetchTerminalState(tabInfo.paneId, epoch, latest ? 'latest' : from, signal), request.signal);
                const range = from < end ? await this._historyRead(tabInfo, signal => this._fetchRecordingRangeOnce(tabInfo.paneId, from, end, epoch, signal), request.signal) : null;
                if (!current()) return;
                pty = tabInfo.ws;
                pty.hold();
                tabInfo._bootstrapGen = (tabInfo._bootstrapGen ?? 0) + 1;
                tabInfo._gapInFlight = false;
                gate = new Promise(resolve => { finishGate = resolve; });
                tabInfo._bootstrapGate = gate;
                await this._drainSettled(tabInfo);
                if (!current()) return;
                if (!latest && !tabInfo._historyLiveState) tabInfo._historyLiveState = { epoch, head, through: tabInfo.drainedSeq, cols: tabInfo.term.cols, rows: tabInfo.term.rows };
                this._clearHistoryAnchors(tabInfo);
                tabInfo._historyBrowsing = !latest;
                tabInfo._historyParsing = true;
                resetTerminalState(tabInfo.term); reset = true;
                tabInfo.term.resize(state.cols, state.rows);
                pty.decoder = new TextDecoder('utf-8');
                tabInfo._streamDecoder = pty.decoder;
                this._writeAttachCheckpoint(tabInfo, pty, state);
                await this._drainSettled(tabInfo);
                if (!current()) return;
                // The state cursor is the exact source boundary. Retaining
                // its row marker makes adjacent books overlap without guessing
                // a byte-to-row ratio or parsing the book in tiny chunks.
                this._recordHistoryAnchor(tabInfo, from);
                if (range && !await this._parseRecordingRange(tabInfo, range, current, undefined, pty)) return;
                tabInfo._historyWindowStart = from;
                tabInfo._historyWindowEnd = end;
                tabInfo._historyOmitted = from > oldest || (tabInfo.term.buffer.active.baseY ?? 0) >= LIVE_SCROLLBACK_ROWS;
                // An older page owns its parser, not the live socket's decoder
                // or frontier. Subsequent live bytes are intentionally unpainted.
                if (!latest) {
                    // Archive interaction is local. Do not forward recorded
                    // mouse tracking into the live application's coordinates.
                    const mouse = tabInfo.term._core?.mouseStateService;
                    if (mouse) mouse.activeProtocol = 'NONE';
                    pty.decoder = new TextDecoder('utf-8');
                    tabInfo._streamDecoder = pty.decoder;
                    tabInfo.queuedSeq = pty.lastFrameEnd ?? head;
                    tabInfo.drainedSeq = tabInfo._historyLiveState.through;
                    tabInfo.userFollowBottom = false;
                    tabInfo.term.scrollToTop();
                } else {
                    // Frames delivered while the request was in flight remain
                    // in the recording. Recover just that small concurrent tail.
                    const frontier = state.through;
                    const caughtUp = Math.max(pty.lastFrameEnd ?? frontier, frontier);
                    tabInfo.queuedSeq = frontier; tabInfo.drainedSeq = frontier;
                    pty.adoptState(frontier);
                    if (!await this._bootstrapDelta(tabInfo, frontier, caughtUp)) throw new Error('Concurrent live tail unavailable');
                    tabInfo._historyWindowStart = frontier;
                    tabInfo._historyWindowEnd = caughtUp;
                    tabInfo._historyLiveState = null;
                    tabInfo.userFollowBottom = true;
                    tabInfo.term.scrollToBottom();
                }
                tabInfo.fitAddon?.fit?.();
                if (tabInfo._historyBrowsing) tabInfo.scrollToBottomBtn?.classList.remove('hidden');
                this._refreshTerminalScreen(tabInfo);
            } catch (error) {
                if (current()) {
                    tabInfo._historyError = error.message;
                    this.app?.showToast?.(error.message, { type: 'error', title: 'Terminal history' });
                    if (reset) { try { pty?.ws?.close(); } catch (_e) {} }
                }
            } finally {
                if (tabInfo._historyRequest === request) {
                    tabInfo._historyRequest = null;
                    tabInfo._historyLoading = false;
                    tabInfo._historyParsing = false;
                    this._updateHistoryButton(tabInfo);
                }
                if (tabInfo._bootstrapGate === gate) tabInfo._bootstrapGate = null;
                finishGate?.();
                if (current() && tabInfo.ws === pty) {
                    pty.release();
                    this._queuePanelFit(tabInfo, { forceResize: true });
                }
            }
        })();
        tabInfo._historyTask = task;
        await task;
        if (tabInfo._historyTask === task) tabInfo._historyTask = null;
    },
};
