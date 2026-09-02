import type { ControlClient } from './client.js';
import { MessageBuffer } from './message-buffer.js';
import type { InboundMessage, Snapshot } from './message-buffer.js';
import { createReviewTranscriptView } from '../review-transcript.js';
import type { ReviewTranscriptView } from '../review-transcript.js';

/**
 * pi-subagents fleet strip: clickable run chips below the chat input
 * bar. The strip is a single shared DOM element (#subagent-strip); only
 * the ACTIVE tab's pane may write it, enforced by the isActive gate so
 * background panes keep streaming events without repainting.
 */

export interface FleetRun {
    id: string;
    kind?: string;
    label?: string;
    state?: string;
    activity?: { currentTool?: string };
    children?: unknown;
}

export interface SubagentStrip {
    root: HTMLElement;
    update(snapshot: unknown): void;
    hide(): void;
    destroy(): void;
}

function dotClassFor(state: unknown): string {
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

function truncateLabel(label: string): string {
    return label.length > 24 ? `${label.slice(0, 23)}…` : label;
}

/** Hide the shared strip regardless of pane ownership (used when the
 * active tab has no chat handle, e.g. plain terminal tabs). */
export function hideSubagentStrip(): void {
    document.getElementById('subagent-strip')?.classList.add('hidden');
}

export function createSubagentStrip(
    isActive: () => boolean,
    onClick: (runId: string, label: string) => void,
): SubagentStrip {
    const root =
        document.getElementById('subagent-strip') ??
        document.createElement('div');

    const hide = () => {
        root.classList.add('hidden');
        root.replaceChildren();
    };

    const renderChip = (run: FleetRun) => {
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
            (part): part is string => typeof part === 'string' && part !== '',
        );
        if (parts.length > 0) chip.title = parts.join(' · ');
        chip.addEventListener('click', () => onClick(run.id, label));
        return chip;
    };

    const update = (snapshot: unknown) => {
        if (!isActive()) return;
        const runs =
            snapshot != null &&
            typeof snapshot === 'object' &&
            Array.isArray((snapshot as { runs?: unknown }).runs)
                ? ((snapshot as { runs: unknown[] }).runs as FleetRun[])
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

export interface SubagentViewer {
    open(runId: string, label: string): void;
    close(): void;
    isOpen(): boolean;
    destroy(): void;
}

type TranscriptStep = {
    label: string;
    messages: InboundMessage[];
};

type TranscriptGroup = {
    label: string;
    start: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

function validTranscriptMessages(value: unknown): InboundMessage[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
        (message): message is InboundMessage =>
            isRecord(message) &&
            typeof message.role === 'string' &&
            Object.hasOwn(message, 'content'),
    );
}

function transcriptSteps(value: unknown): TranscriptStep[] {
    if (!isRecord(value) || !Array.isArray(value.steps)) return [];
    return value.steps.flatMap((step): TranscriptStep[] => {
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
export function createSubagentViewer(
    container: HTMLElement,
    client: ControlClient,
    cwd: string,
): SubagentViewer {
    let wrapper: HTMLElement | null = null;
    let header: HTMLElement | null = null;
    let title: HTMLElement | null = null;
    let closeButton: HTMLButtonElement | null = null;
    let rail: HTMLElement | null = null;
    let main: HTMLElement | null = null;
    let view: ReviewTranscriptView | null = null;
    let activeRunId: string | null = null;
    let requestToken = 0;
    let viewerGeneration = 0;
    const openRuns = new Map<string, string>();
    const payloads = new Map<string, unknown>();

    const clearError = (): void => {
        const error = header?.querySelector('.subagent-viewer-error');
        error?.remove();
    };

    const showError = (error: unknown): void => {
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

    function close(): void {
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

    const renderRail = (): void => {
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

    const ensureViewer = (): void => {
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

    const renderPayload = (runId: string, payload: unknown): void => {
        if (runId !== activeRunId || !view) return;
        clearError();
        const groups: TranscriptGroup[] = [];
        const messages: InboundMessage[] = [];
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
        const snapshot: Snapshot = {
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
            const target = view.transcript.querySelector<HTMLElement>(
                `[data-pi-message-index="${group.start}"]`,
            );
            if (!target) continue;
            const stepHeader = document.createElement('div');
            stepHeader.className = 'subagent-step-header';
            stepHeader.textContent = group.label;
            target.parentElement?.insertBefore(stepHeader, target);
        }
    };

    function open(runId: string, label: string): void {
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
            .call<unknown>('subagentTranscript', undefined, { runId })
            .then((payload) => {
                if (generation !== viewerGeneration || !wrapper) return;
                payloads.set(runId, payload);
                if (token !== requestToken || activeRunId !== runId) return;
                renderPayload(runId, payload);
            })
            .catch((error: unknown) => {
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
        isOpen: (): boolean => wrapper?.isConnected === true,
        destroy: close,
    };
}
