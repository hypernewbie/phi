import { MessageBuffer } from './message-buffer.js';
import { createReviewTranscriptView } from '../review-transcript.js';
function dotClassFor(state) {
    // paused/stopped/rejected/unknown all fall through to the gray dot.
    switch (state) {
        case 'running':
            return 'dot-running';
        case 'complete':
            return 'dot-complete';
        case 'failed':
            return 'dot-failed';
        default:
            return 'dot-queued';
    }
}
function truncateLabel(label) {
    return label.length > 24 ? `${label.slice(0, 23)}…` : label;
}
/** Hide the shared strip regardless of pane ownership (used when the
 * active tab has no chat handle, e.g. plain terminal tabs). */
export function hideSubagentStrip() {
    document.getElementById('subagent-strip')?.classList.add('hidden');
}
export function createSubagentStrip(isActive, onClick) {
    const root =
        document.getElementById('subagent-strip') ??
        document.createElement('div');
    const hide = () => {
        root.classList.add('hidden');
        root.replaceChildren();
    };
    const renderChip = (run) => {
        const label =
            typeof run.label === 'string' && run.label ? run.label : run.id;
        const chip = document.createElement('button');
        chip.className = 'subagent-chip';
        const dot = document.createElement('span');
        dot.className = `dot ${dotClassFor(run.state)}`;
        const text = document.createElement('span');
        text.className = 'subagent-chip-label';
        text.textContent = truncateLabel(label);
        chip.append(dot, text);
        const parts = [label, run.state, run.activity?.currentTool].filter(
            (part) => typeof part === 'string' && part !== '',
        );
        if (parts.length > 0) chip.title = parts.join(' · ');
        chip.addEventListener('click', () => onClick(run.id, label));
        return chip;
    };
    const update = (snapshot) => {
        if (!isActive()) return;
        const runs =
            snapshot != null &&
            typeof snapshot === 'object' &&
            Array.isArray(snapshot.runs)
                ? snapshot.runs
                : [];
        const top = runs.filter(
            (run) =>
                run != null &&
                typeof run === 'object' &&
                typeof run.id === 'string',
        );
        if (top.length === 0) {
            hide();
            return;
        }
        const frag = document.createDocumentFragment();
        for (const run of top) frag.append(renderChip(run));
        root.replaceChildren(frag);
        root.classList.remove('hidden');
    };
    return { root, update, hide, destroy: hide };
}
function isRecord(value) {
    return value !== null && typeof value === 'object';
}
function validTranscriptMessages(value) {
    if (!Array.isArray(value)) return [];
    return value.filter(
        (message) =>
            isRecord(message) &&
            typeof message.role === 'string' &&
            Object.hasOwn(message, 'content'),
    );
}
function transcriptSteps(value) {
    if (!isRecord(value) || !Array.isArray(value.steps)) return [];
    return value.steps.flatMap((step) => {
        if (!isRecord(step)) return [];
        return [
            {
                label: typeof step.label === 'string' ? step.label : '',
                messages: validTranscriptMessages(step.messages),
            },
        ];
    });
}
/**
 * Create the inline snapshot viewer for one pane's pi-subagents runs.
 * The viewer owns only its overlay DOM; the primary chat view remains mounted
 * underneath so closing the overlay returns to the live conversation.
 */
export function createSubagentViewer(container, client, cwd) {
    let wrapper = null;
    let header = null;
    let title = null;
    let closeButton = null;
    let rail = null;
    let main = null;
    let view = null;
    let activeRunId = null;
    let requestToken = 0;
    let viewerGeneration = 0;
    const openRuns = new Map();
    const payloads = new Map();
    const clearError = () => {
        const error = header?.querySelector('.subagent-viewer-error');
        error?.remove();
    };
    const showError = (error) => {
        clearError();
        if (!header || !closeButton) return;
        const message = document.createElement('div');
        message.className = 'subagent-viewer-error';
        message.textContent =
            error instanceof Error
                ? error.message
                : String(error ?? 'Failed to load subagent transcript');
        header.insertBefore(message, closeButton);
    };
    function close() {
        requestToken++;
        viewerGeneration++;
        wrapper?.remove();
        wrapper = null;
        header = null;
        title = null;
        closeButton = null;
        rail = null;
        main = null;
        view = null;
        activeRunId = null;
        openRuns.clear();
        payloads.clear();
    }
    const renderRail = () => {
        if (!rail) return;
        rail.replaceChildren();
        const primary = document.createElement('button');
        primary.type = 'button';
        primary.className = 'subagent-rail-primary';
        primary.textContent = 'Primary';
        primary.addEventListener('click', close);
        rail.appendChild(primary);
        for (const [runId, label] of openRuns) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'subagent-rail-run';
            if (runId === activeRunId) button.classList.add('active');
            button.textContent = label;
            button.title = label;
            button.addEventListener('click', () => open(runId, label));
            rail.appendChild(button);
        }
    };
    const ensureViewer = () => {
        if (wrapper) return;
        wrapper = document.createElement('div');
        wrapper.className = 'subagent-viewer';
        header = document.createElement('div');
        header.className = 'subagent-viewer-header';
        title = document.createElement('span');
        title.className = 'subagent-viewer-title';
        title.textContent = 'Subagent transcript';
        closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'subagent-viewer-close';
        closeButton.setAttribute('aria-label', 'Close subagent transcript');
        closeButton.title = 'Return to Primary';
        closeButton.textContent = '×';
        closeButton.addEventListener('click', close);
        header.append(title, closeButton);
        const body = document.createElement('div');
        body.className = 'subagent-viewer-body';
        rail = document.createElement('aside');
        rail.className = 'subagent-rail';
        main = document.createElement('main');
        main.className = 'subagent-viewer-main';
        body.append(rail, main);
        wrapper.append(header, body);
        container.appendChild(wrapper);
        view = createReviewTranscriptView(main, {
            title: 'Subagent transcript',
            coder: cwd,
            mode: 'structured',
            windowSize: 100,
            pageSize: 50,
        });
    };
    const renderPayload = (runId, payload) => {
        if (runId !== activeRunId || !view) return;
        clearError();
        const groups = [];
        const messages = [];
        for (const step of transcriptSteps(payload)) {
            if (step.messages.length === 0) continue;
            if (step.label)
                groups.push({ label: step.label, start: messages.length });
            messages.push(...step.messages);
        }
        if (messages.length === 0) {
            view.showEmpty();
            return;
        }
        const buffer = new MessageBuffer();
        const snapshot = {
            lastSeq: messages.length,
            messages,
        };
        buffer.applySnapshot(snapshot);
        view.setStructuredMessages(
            buffer.getStructuredTranscript(),
            '',
            buffer.getToolResultMap(),
        );
        for (const group of [...groups].reverse()) {
            const target = view.transcript.querySelector(
                `[data-pi-message-index="${group.start}"]`,
            );
            if (!target) continue;
            const stepHeader = document.createElement('div');
            stepHeader.className = 'subagent-step-header';
            stepHeader.textContent = group.label;
            target.parentElement?.insertBefore(stepHeader, target);
        }
    };
    function open(runId, label) {
        if (!runId) return;
        ensureViewer();
        openRuns.set(runId, label || runId);
        activeRunId = runId;
        if (title) title.textContent = label || runId;
        renderRail();
        const token = ++requestToken;
        const generation = viewerGeneration;
        if (payloads.has(runId)) {
            renderPayload(runId, payloads.get(runId));
            return;
        }
        void client
            .call('subagentTranscript', undefined, { runId })
            .then((payload) => {
                if (generation !== viewerGeneration || !wrapper) return;
                payloads.set(runId, payload);
                if (token !== requestToken || activeRunId !== runId) return;
                renderPayload(runId, payload);
            })
            .catch((error) => {
                if (
                    generation !== viewerGeneration ||
                    token !== requestToken ||
                    activeRunId !== runId
                )
                    return;
                showError(error);
            });
    }
    return {
        open,
        close,
        isOpen: () => wrapper?.isConnected === true,
        destroy: close,
    };
}
