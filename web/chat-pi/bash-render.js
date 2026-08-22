/* Φ phi — Vendored from @earendil-works/pi-coding-agent/dist/core/export-html/template.js
       (MIT-licensed, Mario Zechner / earendil-works). See
       web-src/chat-pi/bash-render.LICENSE.
       Source: template.js:928-944 (bash case in renderToolCall) plus the
       formatExpandableOutput helper at template.js:848-906 and the
       replaceTabs helper at template.js:812-814.
       JS → TS adaptation: use `escapeHtml` from web-src/util.ts, return
       an HTMLElement directly (caller decides where to attach), and
       expose a typed BashCallInput shape. The DOM structure
       (.tool-execution {status}, .tool-command, .tool-output, expandable
       collapse) is preserved verbatim so the vendored CSS at
       web/vendor/pi-template.css resolves to the same look as upstream. */
import { escapeHtml } from '../util.js';
const PREVIEW_LINES = 20;
/**
 * Parse the vendored expandable-output HTML into a DOM element.
 * Exported for tool-render.ts so every tool block shares the exact
 * upstream `.tool-output` structure the vendored CSS targets.
 */
export function expandableOutputElement(
    text,
    maxLines = PREVIEW_LINES,
    previewFromTail = false,
) {
    const html = formatExpandableOutput(text, maxLines, previewFromTail);
    const parsed = new DOMParser().parseFromString(
        `<div>${html}</div>`,
        'text/html',
    );
    const inner = parsed.body.firstElementChild?.firstElementChild;
    return inner instanceof HTMLElement ? inner : null;
}
/** Vendored from upstream template.js:812 — replaces tabs with 3 spaces. */
function replaceTabs(text) {
    return text.replace(/\t/g, '   ');
}
/**
 * Vendored from upstream template.js:848-906 (formatExpandableOutput with
 * no language hint). Plain-text output variant. Builds preview/full pre
 * blocks when output > PREVIEW_LINES; otherwise a single non-expandable block.
 */
function formatExpandableOutput(text, maxLines, previewFromTail = false) {
    text = replaceTabs(text);
    const lines = text.split('\n');
    const displayLines = previewFromTail
        ? lines.slice(-maxLines)
        : lines.slice(0, maxLines);
    const remaining = lines.length - maxLines;
    if (remaining > 0) {
        let out =
            '<div class="tool-output expandable" onclick="if(window.getSelection().toString())return;this.classList.toggle(\'expanded\')">';
        out += '<div class="output-preview">';
        for (const line of displayLines) {
            out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
        }
        const hint = previewFromTail
            ? `... ${remaining} more lines (↵ to expand)`
            : `... (${remaining} more lines, ↵ to expand)`;
        out += `<div class="expand-hint" data-remaining="${remaining}">${hint}</div></div>`;
        out += '<div class="output-full">';
        for (const line of lines) {
            out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
        }
        out += `<div class="expand-hint" data-remaining="${remaining}">(↵ to collapse)</div>`;
        out += '</div></div>';
        return out;
    }
    let out = '<div class="tool-output">';
    for (const line of lines) {
        out += `<div>${escapeHtml(replaceTabs(line))}</div>`;
    }
    out += '</div>';
    return out;
}
/**
 * Renders a `.tool-execution` block matching the upstream HTML export
 * format. Vendored from template.js:928-944 (bash case). Status maps to
 * the `.tool-execution.{pending|success|error}` class triplet.
 */
export function renderBashExecution(input) {
    const { id, command, output, status } = input;
    const safeId = escapeHtml(id);
    const wrapper = document.createElement('div');
    wrapper.className = `tool-execution ${status}${status === 'error' ? ' folded' : ''}`;
    wrapper.id = `tool-call-${safeId}`;
    const head = document.createElement('div');
    head.className = 'tool-command';
    head.textContent = `$ ${command || '...'}`;
    wrapper.appendChild(head);
    const syncHints = () => {
        const expandable = wrapper.querySelector('.tool-output.expandable');
        const expanded = expandable?.classList.contains('expanded') ?? false;
        wrapper.querySelectorAll('.expand-hint').forEach((hint) => {
            const remaining = hint.getAttribute('data-remaining');
            if (remaining === null) return;
            hint.textContent = expanded
                ? '(↵ to collapse)'
                : `... ${remaining} more lines (↵ to expand)`;
        });
    };
    const toggle = () => {
        // Error blocks render folded (CSS hides the body via `.folded`);
        // the header click unfolds them. Non-error blocks keep the
        // vendored expandable preview toggle.
        if (status === 'error') {
            wrapper.classList.toggle('folded');
            return;
        }
        const target = wrapper.querySelector('.tool-output.expandable');
        if (!target) return;
        target.classList.toggle('expanded');
        syncHints();
    };
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
        }
    });
    if (status === 'pending' && (!output || output.trim() === '')) {
        const running = document.createElement('div');
        running.className = 'tool-output';
        running.textContent = 'running…';
        wrapper.appendChild(running);
        return wrapper;
    }
    if (output && output.trim() !== '') {
        // formatExpandableOutput returns HTML with `escapeHtml` applied to
        // every line; expandableOutputElement parses it via DOMParser
        // instead of innerHTML to satisfy the no-innerHTML lint while
        // preserving the upstream `.tool-output` / `.output-preview` /
        // `.output-full` structure.
        const inner = expandableOutputElement(
            output.trim(),
            PREVIEW_LINES,
            true,
        );
        if (inner) wrapper.appendChild(inner);
    }
    const details = input.details;
    if (
        status === 'error' &&
        details &&
        typeof details === 'object' &&
        typeof details.exitCode === 'number'
    ) {
        const footer = document.createElement('div');
        footer.className = 'tool-status-footer';
        footer.textContent = `(exit ${details.exitCode})`;
        wrapper.appendChild(footer);
    }
    const expandable = wrapper.querySelector('.tool-output.expandable');
    if (expandable) {
        expandable.addEventListener('click', () => {
            void Promise.resolve().then(syncHints);
        });
    }
    return wrapper;
}
