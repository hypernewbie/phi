import { renderMarkdownSafe, highlightCodeIn } from './md-render.js';
import { assistantErrorText } from './chat-pi/render.js';
import { renderBashExecution } from './chat-pi/bash-render.js';
import {
    renderToolExecution,
    validatedToolDiff,
} from './chat-pi/tool-render.js';
import { renderQueuePanel } from './chat-pi/queue.js';
/** Wrap a structured array as a source-compatible view without conversion. */
function arrayAsSource(messages) {
    return {
        get length() {
            return messages.length;
        },
        slice(start, end) {
            const safeStart = Math.min(Math.max(start, 0), messages.length);
            const safeEnd = Math.min(
                Math.max(end ?? messages.length, safeStart),
                messages.length,
            );
            return messages.slice(safeStart, safeEnd);
        },
    };
}
/** Coerce call-site arrays or sources into the view's internal source. */
function asSource(messages) {
    if (typeof messages.slice === 'function') {
        return messages;
    }
    return arrayAsSource(messages);
}
const DEFAULT_WINDOW_SIZE = 1000;
const DEFAULT_PAGE_SIZE = 50;
const SCROLL_NEAR_TOP_PX = 16;
const SCROLL_NEAR_BOTTOM_PX = 16;
// Shared by snapScroll's at-bottom detection and the jump button's
// visibility sync so "is at bottom" means the same thing everywhere.
const SNAP_ZONE_PX = 24;
function roleLabel(role) {
    if (role === 'user') return 'User';
    if (role === 'assistant') return 'Assistant';
    if (role === 'toolResult') return 'Tool Output';
    return role.charAt(0).toUpperCase() + role.slice(1);
}
function appendThinkingText(target, text) {
    const pattern = /\*\*(.+?)\*\*/gs;
    let lastIndex = 0;
    let match;
    while (true) {
        match = pattern.exec(text);
        if (match === null) break;
        if (match.index > lastIndex) {
            target.appendChild(
                document.createTextNode(text.slice(lastIndex, match.index)),
            );
        }
        const strong = document.createElement('strong');
        strong.textContent = match[1];
        target.appendChild(strong);
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
        target.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
}
// ─── Legacy bubble renderer (kept verbatim for sessions.ts) ──────────
function createBubble(message, copyText, plainText = false) {
    const bubble = document.createElement('div');
    bubble.className = `review-bubble role-${message.role}`;
    const header = document.createElement('div');
    header.className = 'review-bubble-header';
    const roleSpan = document.createElement('span');
    roleSpan.textContent = roleLabel(message.role);
    header.appendChild(roleSpan);
    if (copyText && !plainText) {
        const copyButton = document.createElement('button');
        copyButton.className = 'copy-bubble-btn';
        copyButton.title = 'Copy message markdown';
        const icon = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'svg',
        );
        icon.setAttribute('class', 'icon');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        const rect = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'rect',
        );
        rect.setAttribute('x', '9');
        rect.setAttribute('y', '9');
        rect.setAttribute('width', '13');
        rect.setAttribute('height', '13');
        rect.setAttribute('rx', '2');
        const path = document.createElementNS(
            'http://www.w3.org/2000/svg',
            'path',
        );
        path.setAttribute(
            'd',
            'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
        );
        icon.append(rect, path);
        const copyLabel = document.createElement('span');
        copyLabel.textContent = 'Copy';
        copyButton.append(icon, copyLabel);
        copyButton.addEventListener('click', () => {
            copyText(message.text);
            const label = copyButton.querySelector('span');
            if (label) label.textContent = 'Copied!';
            copyButton.classList.add('copied');
            setTimeout(() => {
                if (label) label.textContent = 'Copy';
                copyButton.classList.remove('copied');
            }, 2000);
        });
        header.appendChild(copyButton);
    }
    bubble.appendChild(header);
    const content = document.createElement('div');
    content.className = 'review-bubble-content';
    if (plainText) {
        content.textContent = message.text;
    } else {
        const parsed = new DOMParser().parseFromString(
            renderMarkdownSafe(message.text),
            'text/html',
        );
        content.replaceChildren(...parsed.body.childNodes);
        highlightCodeIn(content);
    }
    bubble.appendChild(content);
    return bubble;
}
// ─── Structured renderer (Pi-TUI blocks) ─────────────────────────────
/** Stable cache key for one rendered message and its paired tool state. */
function cacheKeyFor(msg, toolResults, toolDiffs) {
    const parts = [msg.role];
    // Envelope markers (Milestone 2) belong in the key so a settled
    // envelope and a clean follow-up share no cached block — the
    // error row must rebuild when stopReason/errorMessage change.
    parts.push(`s:${msg.stopReason ?? ''}`);
    parts.push(`e:${msg.errorMessage ?? ''}`);
    for (const seg of msg.segments) {
        switch (seg.kind) {
            case 'text':
                parts.push(`t:${seg.text}`);
                break;
            case 'thinking':
                parts.push(`T:${seg.text}`);
                break;
            case 'toolCall': {
                const result = toolResults.get(seg.id);
                const diff = toolDiffs.get(seg.id);
                parts.push(
                    `c:${seg.id}:${seg.name}:${JSON.stringify(seg.args)}:${result ? `${result.isError}:${extractTextFromToolResult(result.message)}` : 'pending'}:d:${diff === undefined ? 'none' : JSON.stringify(diff)}`,
                );
                break;
            }
            case 'toolResult':
                parts.push(`r:${seg.toolCallId}:${seg.content}`);
                break;
            case 'unsupported':
                parts.push(`u:${seg.label}`);
                break;
        }
    }
    return parts.join('|');
}
function unsupportedToolResultLabel(item) {
    if (item && typeof item === 'object') {
        const type = item.type;
        if (typeof type === 'string' && type) return type;
    }
    return 'unknown content';
}
function extractTextFromToolResult(message) {
    const content = message.content;
    if (typeof content === 'string') return content;
    const textForItem = (item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
            const record = item;
            const type = record.type;
            if (
                (type === undefined || type === 'text') &&
                typeof record.text === 'string'
            ) {
                return record.text;
            }
        }
        return `Unsupported content: ${unsupportedToolResultLabel(item)}`;
    };
    if (Array.isArray(content)) {
        return content.map(textForItem).filter(Boolean).join('\n');
    }
    if (content && typeof content === 'object') return textForItem(content);
    return '';
}
function collectValidatedToolDiffs(messages, toolResults) {
    const diffs = new Map();
    for (const message of messages) {
        for (const segment of message.segments) {
            if (segment.kind !== 'toolCall' || segment.name !== 'edit')
                continue;
            const diff = validatedToolDiff(toolResults.get(segment.id));
            if (diff !== undefined) diffs.set(segment.id, diff);
        }
    }
    return diffs;
}
function buildUnsupportedContentBlock(label) {
    const div = document.createElement('div');
    div.className = 'pi-unsupported-content';
    div.textContent = `Unsupported content: ${label}`;
    return div;
}
function buildAssistantMessageBlock(msg, toolResults, toolDiffs, copyText) {
    const block = document.createElement('div');
    block.className = 'assistant-message';
    let copyTextAggregate = '';
    let hasToolCalls = false;
    for (const seg of msg.segments) {
        if (seg.kind === 'text') {
            const textDiv = document.createElement('div');
            // `markdown-content` opts the parsed markdown into the vendored
            // Pi export styles (pre overflow-x, img max-width, p/h/list
            // spacing). Without it, long lines and images render past the
            // message box. Mirrors Pi's own exporter, which emits
            // `assistant-text markdown-content`.
            textDiv.className = 'assistant-text markdown-content';
            copyTextAggregate += seg.text;
            const parsed = new DOMParser().parseFromString(
                renderMarkdownSafe(seg.text),
                'text/html',
            );
            textDiv.replaceChildren(...parsed.body.childNodes);
            highlightCodeIn(textDiv);
            block.appendChild(textDiv);
        } else if (seg.kind === 'thinking') {
            const thinkDiv = document.createElement('div');
            thinkDiv.className = 'thinking-block';
            const thinkText = document.createElement('div');
            thinkText.className = 'thinking-text';
            appendThinkingText(thinkText, seg.text);
            thinkDiv.appendChild(thinkText);
            block.appendChild(thinkDiv);
        } else if (seg.kind === 'unsupported') {
            block.appendChild(buildUnsupportedContentBlock(seg.label));
        } else if (seg.kind === 'toolCall') {
            hasToolCalls = true;
            const result = toolResults.get(seg.id);
            // Per-tool error propagation for stopReason error/aborted.
            // When a tool call has no paired result AND the envelope
            // carries an error/abort marker, render the tool block with
            // status='error' and the BARE error text as its output (no
            // "Error: " prefix — pi's interactive-mode.js:2622–2633
            // overwrites errorMessage before the per-tool loop and
            // shows it verbatim in the output slot).
            let status = result
                ? result.isError
                    ? 'error'
                    : 'success'
                : 'pending';
            let output = result
                ? extractTextFromToolResult(result.message)
                : '';
            if (
                !result &&
                (msg.stopReason === 'error' || msg.stopReason === 'aborted')
            ) {
                status = 'error';
                output = mapAbortErrorText(msg.errorMessage);
            }
            const diff = toolDiffs.get(seg.id);
            if (seg.name === 'bash') {
                const cmd =
                    typeof seg.args.command === 'string'
                        ? seg.args.command
                        : '';
                block.appendChild(
                    renderBashExecution({
                        id: seg.id,
                        command: cmd,
                        status,
                        output,
                        ...(result?.message.details !== undefined
                            ? { details: result.message.details }
                            : {}),
                    }),
                );
                copyTextAggregate += `\n\`\`\`bash\n${cmd}\n\`\`\``;
            } else {
                block.appendChild(
                    renderToolExecution({
                        id: seg.id,
                        name: seg.name,
                        args: seg.args,
                        status,
                        output,
                        ...(diff !== undefined ? { diff } : {}),
                    }),
                );
                copyTextAggregate += `\n\`\`\`json\n${JSON.stringify(seg.args, null, 2)}\n\`\`\``;
            }
        }
    }
    // Milestone 3: append a red error row after the partial content
    // when the contract calls for it. Per the behaviour table:
    //   stopReason="length" — always (even with pending tool calls)
    //   stopReason="error"|"aborted" — only when no tool calls
    //     (per-tool propagation owns the surface otherwise)
    const errorText = assistantErrorText(msg);
    if (errorText && (msg.stopReason === 'length' || !hasToolCalls)) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'assistant-error error-text';
        errorDiv.textContent = errorText;
        block.appendChild(errorDiv);
    }
    if (copyText && copyTextAggregate.trim()) {
        const btn = document.createElement('button');
        btn.className = 'copy-link-btn';
        btn.title = 'Copy message';
        btn.textContent = '⧉';
        btn.addEventListener('click', () => {
            copyText(copyTextAggregate.trim());
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 2000);
        });
        block.appendChild(btn);
    }
    return block;
}
/**
 * Map pi's raw "Request was aborted" sentinel to the user-facing
 * "Operation aborted" before using it as a per-tool output slot.
 * Mirrors the mapping in assistantErrorText (interactive-mode.js
 * overwrites errorMessage with the sentinel before the per-tool
 * loop); parity requires the same rewrite here.
 */
function mapAbortErrorText(raw) {
    if (typeof raw === 'string' && raw === 'Request was aborted')
        return 'Operation aborted';
    return typeof raw === 'string' && raw ? raw : '';
}
function buildUserMessageBlock(segments, copyText) {
    const block = document.createElement('div');
    block.className = 'user-message';
    // Render every valid text segment in source order. The previous
    // single-segment path used `.find` and silently dropped the rest;
    // structured user messages can carry multiple text segments (e.g.
    // interrupted + resumed input) and all must surface in the DOM.
    for (const seg of segments) {
        if (seg.kind === 'unsupported') {
            block.appendChild(buildUnsupportedContentBlock(seg.label));
            continue;
        }
        const div = document.createElement('div');
        // Same `markdown-content` opt-in as the assistant path; Pi's
        // exporter wraps user text in a bare `markdown-content` div.
        div.className = 'user-text markdown-content';
        const parsed = new DOMParser().parseFromString(
            renderMarkdownSafe(seg.text),
            'text/html',
        );
        div.replaceChildren(...parsed.body.childNodes);
        highlightCodeIn(div);
        block.appendChild(div);
    }
    // Predictable copy text: segments concatenated in source order with no
    // separator, then trimmed. Mirrors the assistant aggregator's no-sep
    // behaviour so a downstream notepad sees the same joined source.
    const copyAggregate = segments
        .filter((s) => s.kind === 'text')
        .map((s) => s.text)
        .join('')
        .trim();
    if (copyText && copyAggregate) {
        const btn = document.createElement('button');
        btn.className = 'copy-link-btn';
        btn.title = 'Copy message';
        btn.textContent = '⧉';
        btn.addEventListener('click', () => {
            copyText(copyAggregate);
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 2000);
        });
        block.appendChild(btn);
    }
    return block;
}
// ─── Public factory ──────────────────────────────────────────────────
export function createReviewTranscriptView(root, options) {
    root.replaceChildren();
    // Vendored Pi export CSS resets live behind `.pi-export-scope`. Only
    // the structured chat-pi view depends on that scope; the legacy
    // sessions.ts bubble renderer must keep the host page's own CSS
    // untouched, so the class is opt-in via `mode: 'structured'`.
    if (options.mode === 'structured') {
        root.classList.add('pi-export-scope');
    }
    const header = document.createElement('div');
    header.className = 'review-header-bar';
    const left = document.createElement('div');
    left.className = 'review-header-left';
    const title = document.createElement('span');
    title.className = 'review-header-title';
    title.textContent = options.title;
    const coder = document.createElement('span');
    coder.className = 'review-header-coder';
    coder.textContent = options.coder;
    left.append(title, coder);
    header.appendChild(left);
    let refreshButton = null;
    let status = null;
    if (options.refresh) {
        refreshButton = document.createElement('button');
        refreshButton.className = 'review-refresh-btn';
        refreshButton.title = 'Refresh Transcript';
        refreshButton.textContent = 'Refresh';
        header.appendChild(refreshButton);
    } else if (options.status) {
        status = document.createElement('span');
        status.className = 'review-header-coder';
        status.textContent = options.status;
        header.appendChild(status);
    }
    root.appendChild(header);
    const contentBody = document.createElement('div');
    contentBody.className = 'review-content-body';
    root.appendChild(contentBody);
    const transcript = document.createElement('div');
    transcript.className = 'review-chat-wrapper';
    contentBody.appendChild(transcript);
    const queuePanel = document.createElement('div');
    queuePanel.className = 'pi-queue-panel hidden';
    contentBody.appendChild(queuePanel);
    const connectionState = document.createElement('div');
    connectionState.className = 'pi-rpc-connection-state';
    connectionState.setAttribute('aria-live', 'polite');
    connectionState.classList.add('hidden');
    root.appendChild(connectionState);
    const dialogHost = document.createElement('div');
    dialogHost.className = 'pi-extension-dialog-host';
    root.appendChild(dialogHost);
    let activeHeader = null;
    let activeTop = null;
    let activeBottom = null;
    if (options.mode === 'structured') {
        activeHeader = document.createElement('div');
        activeHeader.className = 'pi-active-turn';
        const working = document.createElement('span');
        working.className = 'pi-working-label';
        working.textContent = 'Pi is working';
        const dots = document.createElement('span');
        dots.className = 'pi-working-dots';
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('span');
            dot.className = 'pi-working-dot';
            dot.setAttribute('aria-hidden', 'true');
            dots.appendChild(dot);
        }
        const hint = document.createElement('span');
        hint.className = 'pi-working-hint';
        hint.textContent = 'Esc to interrupt';
        activeHeader.append(working, dots, hint);
        // Keep the working row outside the transcript flex column and
        // directly above the chat input bar, which lives below this root.
        // The transcript viewport ends above this status row, while pins
        // remain overlays of the actual scroll viewport.
        root.append(activeHeader);
        activeHeader.classList.add('hidden');
        activeTop = document.createElement('div');
        activeTop.className =
            'pi-active-prompt-overlay pi-active-prompt-top hidden';
        activeBottom = document.createElement('div');
        activeBottom.className =
            'pi-active-prompt-overlay pi-active-prompt-bottom hidden';
        contentBody.append(activeTop, activeBottom);
    }
    const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    // ── Jump-to-bottom (structured mode only) ──
    // Reuses the terminal's `.scroll-to-bottom-btn` styles (web/style.css)
    // so the chat and terminal buttons read as one pattern. Hidden while
    // the DOM window is at the newest page AND scrolled to bottom.
    let jumpBtn = null;
    if (options.mode === 'structured') {
        jumpBtn = document.createElement('button');
        jumpBtn.className = 'scroll-to-bottom-btn hidden';
        jumpBtn.setAttribute('aria-label', 'Jump to bottom');
        jumpBtn.textContent = '↓';
        contentBody.appendChild(jumpBtn);
        jumpBtn.addEventListener('click', () => {
            const newestStart = Math.max(
                0,
                structuredMessages.length - windowSize,
            );
            if (currentStart < newestStart) {
                currentStart = newestStart;
                rebuildStructuredWindow({
                    appendPartial: latestPartial,
                    partialStreaming: latestPartial !== '',
                });
            }
            transcript.scrollTop = transcript.scrollHeight;
            syncJumpButton();
        });
    }
    function syncJumpButton() {
        if (!jumpBtn) return;
        const newestStart = Math.max(0, structuredMessages.length - windowSize);
        const atBottom =
            transcript.scrollHeight -
                transcript.scrollTop -
                transcript.clientHeight <=
            SNAP_ZONE_PX;
        jumpBtn.classList.toggle(
            'hidden',
            currentStart >= newestStart && atBottom,
        );
    }
    // ── Structured-mode state ──
    let structuredMessages = {
        length: 0,
        slice: () => [],
    };
    let toolResults = new Map();
    // Latest streaming partial, stashed on every setStructuredMessages
    // paint. Window slides (appendNewer, jump button) rebuild outside it
    // and would otherwise drop the live tail for one paint.
    let latestPartial = '';
    let latestThinking = '';
    const liveToolOutputs = new Map();
    let queueItems = [];
    let piQueue = { steering: [], followUp: [] };
    let queueActions = {};
    let activeTurn = null;
    // Milestone 3: persistent (within-view) red error row. Phi treats
    // it as ephemeral: it is not in the snapshot/persist surface and
    // is re-applied from this view state on every rebuild. Setting
    // null clears any stale row.
    let ephemeralErrorText = null;
    let currentStart = 0; // index into structuredMessages of the first rendered
    const cache = new Map();
    function clearActivePromptMarkers(block) {
        delete block.dataset.piActivePromptIndex;
        delete block.dataset.piOptimisticPrompt;
    }
    const startBadge = document.createElement('div');
    startBadge.className = 'review-start-badge';
    startBadge.textContent = 'Start of loaded history';
    startBadge.style.display = 'none';
    transcript.appendChild(startBadge);
    function rebuildStructuredWindow(opts) {
        const end = Math.min(
            structuredMessages.length,
            currentStart + windowSize,
        );
        const slice = structuredMessages.slice(currentStart, end);
        const toolDiffs = collectValidatedToolDiffs(slice, toolResults);
        const fragment = document.createDocumentFragment();
        // Tool calls render their result inline (bash-render /
        // tool-render), so a paired toolResult message would duplicate the
        // output as a dim assistant block. Collect rendered call ids once
        // and skip their result messages; orphaned results (call outside
        // the window) still fall through to the dim block.
        const renderedCallIds = new Set();
        for (const msg of slice) {
            for (const seg of msg.segments) {
                if (seg.kind === 'toolCall') renderedCallIds.add(seg.id);
            }
        }
        const retainedKeys = new Set();
        for (const [index, msg] of slice.entries()) {
            if (
                msg.role === 'toolResult' &&
                msg.toolCallId &&
                renderedCallIds.has(msg.toolCallId)
            ) {
                continue;
            }
            // The global message index prevents two identical messages from
            // sharing one DOM node; paired result state makes a pending tool
            // call rebuild when its result arrives.
            const key = `${currentStart + index}:${cacheKeyFor(msg, toolResults, toolDiffs)}`;
            retainedKeys.add(key);
            const cached = cache.get(key);
            const block = cached ?? buildAssistantOrUserBlock(msg, toolDiffs);
            clearActivePromptMarkers(block);
            block.dataset.piMessageIndex = String(currentStart + index);
            block.dataset.bufferIndex = String(currentStart + index);
            if (!cached) cache.set(key, block);
            fragment.appendChild(block);
        }
        for (const key of cache.keys()) {
            if (!retainedKeys.has(key)) cache.delete(key);
        }
        for (const [toolCallId, output] of liveToolOutputs) {
            applyLiveToolOutputToHost(fragment, toolCallId, output);
        }
        // Thinking is temporary and stays outside the settled message/cache
        // source. It renders before the live assistant partial.
        if (latestThinking) {
            fragment.appendChild(buildLiveThinkingBlock(latestThinking));
        }
        // Virtual "live" assistant message appended when streaming. It
        // lives outside the slice so `currentStart` and the persisted
        // buffer are unaffected. The block is rebuilt every paint (cheap
        // — just a single text segment with no markdown or tool calls)
        // and never enters the cache.
        if (opts.partialStreaming && opts.appendPartial) {
            const live = buildLiveAssistantBlock(opts.appendPartial);
            fragment.appendChild(live);
        }
        // Milestone 3: persistent (within-view) red error row. Phi
        // treats the row as ephemeral: not in the snapshot/persist
        // surface, re-applied from view state on every repaint. Best-
        // effort placement at the end of the rendered window — a live
        // partial that streams in afterwards may sit above the row
        // until the next rebuild, by design.
        if (ephemeralErrorText) {
            fragment.appendChild(buildEphemeralErrorBlock(ephemeralErrorText));
        }
        transcript.replaceChildren(startBadge, fragment);
        startBadge.style.display = currentStart === 0 ? 'block' : 'none';
        syncActivePromptMarkers();
        syncActiveTurn();
    }
    function buildEphemeralErrorBlock(text) {
        const div = document.createElement('div');
        div.className = 'pi-ephemeral-error error-text';
        div.textContent = text;
        return div;
    }
    function syncActivePromptMarkers() {
        for (const block of transcript.querySelectorAll(
            '[data-pi-active-prompt-index]',
        )) {
            delete block.dataset.piActivePromptIndex;
        }
        for (const block of transcript.querySelectorAll(
            '[data-pi-optimistic-message]',
        )) {
            block.remove();
        }
        if (!activeTurn?.active) return;
        if (typeof activeTurn.promptOrigin === 'number') {
            const block = transcript.querySelector(
                `[data-pi-message-index="${activeTurn.promptOrigin}"]`,
            );
            if (block)
                block.dataset.piActivePromptIndex = String(
                    activeTurn.promptOrigin,
                );
            return;
        }
        const pending = activeTurn.outgoing ?? [
            {
                text: activeTurn.promptText,
                stateLabel: activeTurn.stateLabel,
            },
        ];
        for (const item of pending) {
            const optimistic = buildUserMessageBlock(
                [
                    {
                        kind: 'text',
                        text: `${item.stateLabel}: ${item.text}`,
                    },
                ],
                undefined,
            );
            optimistic.dataset.piOptimisticMessage = 'true';
            if (item.text === activeTurn.promptText)
                optimistic.dataset.piOptimisticPrompt = 'true';
            transcript.appendChild(optimistic);
        }
    }
    function syncActiveTurn() {
        if (!activeHeader || !activeTop || !activeBottom) return;
        const state = activeTurn;
        // Milestone 3: retry indicator alone keeps the working row
        // visible. Overlay/marker pins remain gated on `active` —
        // they describe the user's prompt in flight, not provider
        // bookkeeping.
        const showHeader = !!state?.active || !!state?.retry;
        activeHeader.classList.toggle('hidden', !showHeader);
        activeTop.classList.add('hidden');
        activeBottom.classList.add('hidden');
        // Retry indicator swaps the working label to
        // "Retrying · attempt N of M"; dots + Esc hint stay unchanged.
        // The label is updated BEFORE the active-only early return so
        // a retry-only state (active=false, retry={...}) still mutates
        // the visible text on the just-shown working row.
        const retry = state?.retry;
        if (
            retry &&
            Number.isFinite(retry.attempt) &&
            Number.isFinite(retry.maxAttempts)
        ) {
            const working = activeHeader.querySelector('.pi-working-label');
            if (working)
                working.textContent = `Retrying · attempt ${retry.attempt} of ${retry.maxAttempts}`;
        } else {
            const working = activeHeader.querySelector('.pi-working-label');
            if (working) working.textContent = 'Pi is working';
        }
        if (!state?.active) return;
        activeHeader.setAttribute(
            'aria-label',
            `${state.stateLabel}. Esc to interrupt`,
        );
        const source =
            typeof state.promptOrigin === 'number'
                ? transcript.querySelector(
                      `[data-pi-active-prompt-index="${state.promptOrigin}"]`,
                  )
                : transcript.querySelector(
                      '[data-pi-optimistic-prompt="true"]',
                  );
        let placement = null;
        if (
            typeof state.promptOrigin === 'number' &&
            (state.promptOrigin < currentStart ||
                state.promptOrigin >= currentStart + windowSize)
        ) {
            placement = state.promptOrigin < currentStart ? 'top' : 'bottom';
        } else if (source) {
            const viewport = transcript.getBoundingClientRect();
            const rect = source.getBoundingClientRect();
            if (rect.bottom <= viewport.top) placement = 'top';
            else if (rect.top >= viewport.bottom) placement = 'bottom';
        } else if (state.promptOrigin === 'optimistic') {
            placement = 'bottom';
        }
        const target =
            placement === 'top'
                ? activeTop
                : placement === 'bottom'
                  ? activeBottom
                  : null;
        if (!target) return;
        target.replaceChildren();
        const bubble = buildUserMessageBlock(
            [
                {
                    kind: 'text',
                    text: `${state.stateLabel}: ${state.promptText}`,
                },
            ],
            undefined,
        );
        bubble.classList.add('pi-active-prompt-copy');
        target.appendChild(bubble);
        target.classList.remove('hidden');
    }
    /** Build the streaming virtual assistant block (not cached). */
    function buildLiveAssistantBlock(partial) {
        const block = document.createElement('div');
        block.className = 'assistant-message pi-streaming';
        const text = document.createElement('div');
        text.className = 'assistant-text pi-partial';
        text.textContent = partial;
        block.appendChild(text);
        return block;
    }
    /**
     * Locate the streaming live block if it is currently rendered inside
     * the transcript. The block is always appended as the last child of
     * `transcript` by `rebuildStructuredWindow`, so the live block is the
     * last descendant matching `.pi-streaming`.
     */
    function findLiveAssistantBlock() {
        return transcript.querySelector(
            ':scope > .assistant-message.pi-streaming',
        );
    }
    /**
     * Update only the streaming live block. Never rebuilds the
     * transcript or runs markdown / tool-result lookup. An empty
     * `partial` removes the live block if present; otherwise the block
     * is lazily created or its `.pi-partial` text content is mutated.
     *
     * Bottom-stick: when the user was at the bottom before the update,
     * the view re-anchors to the bottom; otherwise the scroll position
     * is preserved so a reader who scrolled up keeps their place.
     *
     * Updates `latestPartial` so subsequent window slides
     * (prependOlder / appendNewer / jump) can re-create the live block
     * with the latest text.
     */
    /** Build the temporary thinking block (not cached or persisted). */
    function buildLiveThinkingBlock(text) {
        const block = document.createElement('div');
        block.className = 'thinking-block pi-live-thinking';
        const content = document.createElement('div');
        content.className = 'thinking-text';
        content.textContent = text;
        block.appendChild(content);
        return block;
    }
    /** Build the streaming virtual assistant block (not cached). */
    function findLiveThinkingBlock() {
        return transcript.querySelector(':scope > .pi-live-thinking');
    }
    function applyLiveToolOutputToHost(host, id, output) {
        const wrapper = Array.from(
            host.querySelectorAll('.tool-execution'),
        ).find((candidate) => candidate.id === `tool-call-${id}`);
        if (!wrapper) return null;
        wrapper.classList.add('pi-live-tool');
        let live = wrapper.querySelector('.pi-live-tool-output');
        if (!output) {
            if (live) live.remove();
            wrapper.classList.remove('pi-live-tool');
            return null;
        }
        if (!live) {
            live =
                Array.from(wrapper.querySelectorAll('.tool-output')).find(
                    (candidate) => candidate.textContent === 'running…',
                ) ?? null;
            if (live) live.classList.add('pi-live-tool-output');
        }
        if (!live) {
            live = document.createElement('div');
            live.className = 'tool-output pi-live-tool-output';
            wrapper.appendChild(live);
        }
        live.textContent = output;
        return live;
    }
    /**
     * Update only the streaming live block. Never rebuilds the
     * transcript or runs markdown / tool-result lookup. An empty
     * `partial` removes the live block if present; otherwise the block
     * is lazily created or its `.pi-partial` text content is mutated.
     *
     * Bottom-stick: when the user was at the bottom before the update,
     * the view re-anchors to the bottom; otherwise the scroll position
     * is preserved so a reader who scrolled up keeps their place.
     *
     * Updates `latestPartial` so subsequent window slides
     * (prependOlder / appendNewer / jump) can re-create the live block
     * with the latest text.
     */
    function setStructuredThinking(text) {
        latestThinking = text;
        const existing = findLiveThinkingBlock();
        if (text === '') {
            if (existing) existing.remove();
            syncJumpButton();
            return;
        }
        const wasAtBottom =
            transcript.scrollHeight -
                transcript.scrollTop -
                transcript.clientHeight <=
            SNAP_ZONE_PX;
        if (existing) {
            const content = existing.querySelector('.thinking-text');
            if (content) content.textContent = text;
        } else {
            const live = buildLiveThinkingBlock(text);
            const partial = findLiveAssistantBlock();
            if (partial) transcript.insertBefore(live, partial);
            else transcript.appendChild(live);
        }
        if (wasAtBottom) transcript.scrollTop = transcript.scrollHeight;
        syncJumpButton();
    }
    function setLiveToolOutput(id, text) {
        if (text === '') liveToolOutputs.delete(id);
        else liveToolOutputs.set(id, text);
        const wasAtBottom =
            transcript.scrollHeight -
                transcript.scrollTop -
                transcript.clientHeight <=
            SNAP_ZONE_PX;
        applyLiveToolOutputToHost(transcript, id, text);
        if (wasAtBottom) transcript.scrollTop = transcript.scrollHeight;
        syncJumpButton();
    }
    function renderQueueState() {
        if (options.mode !== 'structured') return;
        renderQueuePanel(queuePanel, queueItems, piQueue, queueActions);
    }
    function setStructuredPartial(partial) {
        latestPartial = partial;
        const existing = findLiveAssistantBlock();
        if (partial === '') {
            if (existing) existing.remove();
            syncJumpButton();
            return;
        }
        const wasAtBottom =
            transcript.scrollHeight -
                transcript.scrollTop -
                transcript.clientHeight <=
            SNAP_ZONE_PX;
        if (existing) {
            const textNode = existing.querySelector(
                '.assistant-text.pi-partial',
            );
            if (textNode) textNode.textContent = partial;
        } else {
            const live = buildLiveAssistantBlock(partial);
            transcript.appendChild(live);
        }
        if (wasAtBottom) {
            transcript.scrollTop = transcript.scrollHeight;
        }
        syncJumpButton();
    }
    function buildAssistantOrUserBlock(msg, toolDiffs) {
        if (msg.role === 'user') {
            const texts = msg.segments.filter((s) => s.kind === 'text');
            if (texts.length > 0) {
                return buildUserMessageBlock(texts, options.copyText);
            }
            // No text segment for user (rare): emit empty user block.
            const empty = document.createElement('div');
            empty.className = 'user-message';
            return empty;
        }
        if (msg.role === 'toolResult') {
            // Standalone toolResult messages without a paired call: render
            // as a dim assistant block. Pairing lives in the assistant
            // branch above (bash-render takes the result inline).
            const text = msg.segments
                .filter((s) => s.kind === 'text')
                .map((s) => (s.kind === 'text' ? s.text : ''))
                .join('\n');
            const block = document.createElement('div');
            block.className = 'assistant-message';
            const textDiv = document.createElement('div');
            textDiv.className = 'assistant-text';
            textDiv.textContent = text;
            block.appendChild(textDiv);
            return block;
        }
        return buildAssistantMessageBlock(
            msg,
            toolResults,
            toolDiffs,
            options.copyText,
        );
    }
    function clearSearchMarks() {
        for (const mark of transcript.querySelectorAll(
            'mark[data-pi-active-match]',
        )) {
            mark.replaceWith(document.createTextNode(mark.textContent ?? ''));
        }
        transcript.normalize();
    }
    function markSearchMatch(index, query, occurrence = 0) {
        clearSearchMarks();
        if (!query) return false;
        const block = Array.from(
            transcript.querySelectorAll('[data-buffer-index]'),
        ).find((candidate) => candidate.dataset.bufferIndex === String(index));
        if (!block) return false;
        const needle = query.toLocaleLowerCase();
        const textNodes = [];
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
            const parent = node.parentElement;
            if (
                node.nodeValue &&
                parent &&
                !parent.closest('button, mark, .pi-unsupported-content')
            ) {
                textNodes.push(node);
            }
            node = walker.nextNode();
        }
        let seen = 0;
        for (const textNode of textNodes) {
            const text = textNode.nodeValue ?? '';
            const lower = text.toLocaleLowerCase();
            let cursor = 0;
            while (cursor <= lower.length - needle.length) {
                const match = lower.indexOf(needle, cursor);
                if (match < 0) break;
                if (seen === occurrence) {
                    const fragment = document.createDocumentFragment();
                    if (match > 0)
                        fragment.appendChild(
                            document.createTextNode(text.slice(0, match)),
                        );
                    const mark = document.createElement('mark');
                    mark.dataset.piActiveMatch = 'true';
                    mark.textContent = text.slice(match, match + query.length);
                    fragment.appendChild(mark);
                    const after = match + query.length;
                    if (after < text.length)
                        fragment.appendChild(
                            document.createTextNode(text.slice(after)),
                        );
                    textNode.replaceWith(fragment);
                    block.scrollIntoView?.({
                        block: 'center',
                        inline: 'nearest',
                    });
                    return true;
                }
                seen += 1;
                cursor = match + Math.max(needle.length, 1);
            }
        }
        return false;
    }
    function revealMessage(index) {
        if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= structuredMessages.length
        )
            return false;
        const newestStart = Math.max(0, structuredMessages.length - windowSize);
        if (index < currentStart || index >= currentStart + windowSize) {
            const snap = snapScroll();
            currentStart = Math.max(
                0,
                Math.min(index - Math.floor(windowSize / 2), newestStart),
            );
            rebuildStructuredWindow({
                appendPartial: latestPartial,
                partialStreaming: latestPartial !== '',
            });
            applyScrollAnchor(snap, transcript.scrollHeight - snap.preHeight);
        }
        const block = Array.from(
            transcript.querySelectorAll('[data-buffer-index]'),
        ).find((candidate) => candidate.dataset.bufferIndex === String(index));
        block?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        syncJumpButton();
        return block !== undefined;
    }
    function snapScroll() {
        // Snap-to-bottom detection uses a slightly more generous threshold
        // than the scroll-near-top prepending trigger so the view sticks
        // to the bottom under hand jitter but still detaches when the
        // user scrolls up by more than ~one row.
        const wasAtBottom =
            transcript.scrollHeight -
                transcript.scrollTop -
                transcript.clientHeight <=
            SNAP_ZONE_PX;
        return {
            wasAtBottom,
            preHeight: transcript.scrollHeight,
        };
    }
    function applyScrollAnchor(snap, delta) {
        if (snap.wasAtBottom) {
            transcript.scrollTop = transcript.scrollHeight;
        } else {
            transcript.scrollTop = Math.max(0, transcript.scrollTop + delta);
        }
    }
    // ── Scroll handler (forward-references the view's prependOlder) ──
    const onScroll = () => {
        if (transcript.scrollTop <= SCROLL_NEAR_TOP_PX) {
            view.prependOlder(pageSize);
        } else if (
            transcript.scrollHeight -
                transcript.scrollTop -
                transcript.clientHeight <=
            SCROLL_NEAR_BOTTOM_PX
        ) {
            view.appendNewer(pageSize);
        }
        syncJumpButton();
        syncActiveTurn();
    };
    transcript.addEventListener('scroll', onScroll);
    // ── Public surface ──
    const view = {
        root,
        title,
        contentBody,
        transcript,
        dialogHost,
        status,
        refreshButton,
        setMessages(messages, partial = '') {
            // Legacy path — unchanged from prior implementation.
            if (!transcript.isConnected)
                contentBody.replaceChildren(transcript);
            transcript.replaceChildren(startBadge);
            for (const message of messages) {
                transcript.appendChild(createBubble(message, options.copyText));
            }
            if (partial) {
                transcript.appendChild(
                    createBubble(
                        { role: 'assistant', text: `${partial}▌` },
                        undefined,
                        true,
                    ),
                );
            }
            startBadge.style.display = 'none';
            transcript.scrollTop = transcript.scrollHeight;
        },
        showEmpty() {
            if (!transcript.isConnected)
                contentBody.replaceChildren(transcript);
            transcript.replaceChildren(startBadge);
            startBadge.style.display = 'none';
            const empty = document.createElement('div');
            empty.className = 'review-empty';
            empty.textContent = 'No messages found in this session.';
            transcript.appendChild(empty);
        },
        setStructuredMessages(messages, partial, results) {
            const source = asSource(messages);
            const previousTotal = structuredMessages.length;
            const previousNewestStart = Math.max(0, previousTotal - windowSize);
            const wasAtNewest = currentStart === previousNewestStart;
            structuredMessages = source;
            toolResults = results;
            latestPartial = partial;
            latestThinking = '';
            for (const id of liveToolOutputs.keys()) {
                if (results.has(id)) liveToolOutputs.delete(id);
            }
            const newestStart = Math.max(0, source.length - windowSize);
            if (wasAtNewest || source.length < previousTotal) {
                currentStart = newestStart;
            } else {
                currentStart = Math.min(currentStart, newestStart);
            }
            const snap = snapScroll();
            rebuildStructuredWindow({
                appendPartial: partial,
                partialStreaming: partial !== '',
            });
            const delta = transcript.scrollHeight - snap.preHeight;
            applyScrollAnchor(snap, delta);
            syncJumpButton();
        },
        setStructuredPartial(partial) {
            setStructuredPartial(partial);
        },
        setStructuredThinking(text) {
            setStructuredThinking(text);
        },
        setLiveToolOutput(id, text) {
            setLiveToolOutput(id, text);
        },
        setConnectionState(state) {
            connectionState.replaceChildren();
            if (!state || state === 'connected') {
                connectionState.classList.add('hidden');
                return;
            }
            connectionState.classList.remove('hidden');
            const message = document.createElement('span');
            message.textContent =
                state === 'unavailable'
                    ? 'Session unavailable — draft preserved'
                    : state === 'reconnecting'
                      ? 'Reconnecting…'
                      : state;
            connectionState.appendChild(message);
        },
        announceDialog(message) {
            connectionState.replaceChildren();
            connectionState.classList.remove('hidden');
            const announcement = document.createElement('span');
            announcement.textContent = message;
            connectionState.appendChild(announcement);
        },
        revealMessage(index) {
            return revealMessage(index);
        },
        clearSearchMarks() {
            clearSearchMarks();
        },
        markSearchMatch(index, query, occurrenceStart) {
            return markSearchMatch(index, query, occurrenceStart);
        },
        setQueueState(
            items,
            authoritative = { steering: [], followUp: [] },
            actions = {},
        ) {
            queueItems = items;
            piQueue = authoritative;
            queueActions = actions;
            renderQueueState();
        },
        setActiveTurn(state) {
            activeTurn = state;
            syncActivePromptMarkers();
            syncActiveTurn();
        },
        setEphemeralError(text) {
            // Milestone 3: toggle the persistent (within-view) red
            // error row. Phi treats the row as ephemeral: not in the
            // snapshot/persist surface. The row survives the next
            // repaint because rebuildStructuredWindow re-appends it
            // from view state.
            ephemeralErrorText = text;
            // Mutate the DOM directly when a transcript is already
            // rendered; otherwise the next rebuild will pick the
            // updated state up. Avoids a full repaint for the
            // common case where only the row toggles.
            const existing = transcript.querySelector('.pi-ephemeral-error');
            if (text === null) {
                if (existing) existing.remove();
                return;
            }
            if (existing) {
                existing.textContent = text;
                return;
            }
            transcript.appendChild(buildEphemeralErrorBlock(text));
        },
        prependOlder(count) {
            if (currentStart === 0) return false;
            const newStart = Math.max(0, currentStart - count);
            if (newStart === currentStart) return false;
            const preHeight = transcript.scrollHeight;
            currentStart = newStart;
            rebuildStructuredWindow({
                appendPartial: latestPartial,
                partialStreaming: latestPartial !== '',
            });
            const delta = transcript.scrollHeight - preHeight;
            transcript.scrollTop = Math.max(0, transcript.scrollTop + delta);
            syncJumpButton();
            return true;
        },
        appendNewer(count) {
            if (count <= 0) return false;
            const newestStart = Math.max(
                0,
                structuredMessages.length - windowSize,
            );
            if (currentStart >= newestStart) return false;
            const newStart = Math.min(newestStart, currentStart + count);
            if (newStart === currentStart) return false;
            // Boundary-top anchoring: tag the current last rendered block
            // before the rebuild. Cache keys use the GLOBAL message index
            // and paired tool state, so the tagged node survives the
            // rebuild via cache reuse (same index → same cached DOM node).
            // The anchor must be a settled block: the live partial
            // (`.pi-streaming`) is rebuilt from scratch every paint and
            // never survives the slide, so skip it when it is last.
            let anchor = transcript.lastElementChild;
            while (
                anchor &&
                (!(anchor instanceof HTMLElement) ||
                    anchor.classList.contains('pi-streaming'))
            ) {
                anchor = anchor.previousElementSibling;
            }
            if (anchor instanceof HTMLElement) anchor.dataset.appendAnchor = '';
            currentStart = newStart;
            rebuildStructuredWindow({
                appendPartial: latestPartial,
                partialStreaming: latestPartial !== '',
            });
            const restored = anchor instanceof HTMLElement ? anchor : null;
            // Containment against the transcript, not isConnected: the
            // view may legitimately run detached (tests; pre-mount paint).
            if (restored && transcript.contains(restored)) {
                // Place the previously-last message at the viewport top so
                // the newly revealed page flows beneath it — the reading
                // continuation. Far-from-bottom position also prevents the
                // scroll event from re-triggering appendNewer (no cascade).
                const tr = transcript.getBoundingClientRect().top;
                transcript.scrollTop =
                    restored.getBoundingClientRect().top -
                    tr +
                    transcript.scrollTop;
                delete restored.dataset.appendAnchor;
            }
            syncJumpButton();
            return true;
        },
    };
    return view;
}
