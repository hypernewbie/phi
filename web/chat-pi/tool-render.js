/* Φ phi — Generic Pi tool-call renderer for the chat-pi overlay.
       Mirrors the DOM structure of pi's HTML-export template.js
       renderToolCall (read/write/edit/ls/default cases; MIT-licensed,
       Mario Zechner / earendil-works — see tool-render.LICENSE) so the
       vendored web/vendor/pi-template.css styles (.tool-header,
       .tool-name, .tool-path, .line-numbers, .line-count, .tool-output)
       apply unchanged. Unlike bash-render.ts this file is phi-authored:
       DOM is built with createElement/textContent only, and the
       expandable-output body is shared with bash via
       expandableOutputElement. */
import { expandableOutputElement } from './bash-render.js';
/** Vendored from upstream template.js:558-569 — shortens /Users/x → ~/. */
function shortenPath(p) {
    if (p.startsWith('/Users/')) {
        const parts = p.split('/');
        if (parts.length > 2) return `~${p.slice(`/Users/${parts[2]}`.length)}`;
    }
    if (p.startsWith('/home/')) {
        const parts = p.split('/');
        if (parts.length > 2) return `~${p.slice(`/home/${parts[2]}`.length)}`;
    }
    return p;
}
function str(value) {
    return typeof value === 'string' ? value : null;
}
/**
 * Accept only the non-error edit-result metadata supported by Pi's display
 * renderer. Keeping this check at the DOM boundary prevents arbitrary tool
 * metadata from changing the render path.
 */
export function validatedToolDiff(result) {
    if (!result || result.isError) return undefined;
    const details = result.message.details;
    if (
        details === null ||
        typeof details !== 'object' ||
        Array.isArray(details)
    )
        return undefined;
    const diff = details.diff;
    return typeof diff === 'string' ? diff : undefined;
}
function el(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function truncate(text, max = 80) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/** Vendored from Pi's diff.js:1-13. */
function parseDiffLine(line) {
    const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
    if (!match) return null;
    return {
        prefix: match[1],
        lineNum: match[2],
        content: match[3],
    };
}
/** Vendored from Pi's diff.js:16-18. */
function replaceDiffTabs(text) {
    return text.replace(/\t/g, '   ');
}
function diffWordsSafely(oldContent, newContent) {
    if (typeof window === 'undefined') return null;
    const diff = window.Diff;
    if (!diff || typeof diff.diffWords !== 'function') return null;
    try {
        return diff.diffWords(oldContent, newContent);
    } catch {
        return null;
    }
}
function appendDiffFragment(row, value, changed) {
    if (!value) return;
    const fragment = document.createElement('span');
    if (changed) fragment.className = 'diff-word-change';
    fragment.textContent = value;
    row.appendChild(fragment);
}
function appendPlainDiffRow(container, className, text) {
    const row = document.createElement('div');
    row.className = className;
    row.textContent = text;
    container.appendChild(row);
}
function appendParsedDiffRow(container, parsed, className) {
    appendPlainDiffRow(
        container,
        className,
        `${parsed.prefix}${parsed.lineNum} ${replaceDiffTabs(parsed.content)}`,
    );
}
/** Vendored from Pi's diff.js:21-55, with DOM-native inverse spans. */
function appendIntraLineDiffRows(container, removed, added) {
    const wordDiff = diffWordsSafely(
        replaceDiffTabs(removed.content),
        replaceDiffTabs(added.content),
    );
    if (!wordDiff) return false;
    const removedRow = document.createElement('div');
    removedRow.className = 'diff-removed';
    const addedRow = document.createElement('div');
    addedRow.className = 'diff-added';
    const removedPrefix = document.createElement('span');
    removedPrefix.textContent = `-${removed.lineNum} `;
    const addedPrefix = document.createElement('span');
    addedPrefix.textContent = `+${added.lineNum} `;
    removedRow.appendChild(removedPrefix);
    addedRow.appendChild(addedPrefix);
    let isFirstRemoved = true;
    let isFirstAdded = true;
    for (const part of wordDiff) {
        if (part.removed) {
            let value = part.value;
            if (isFirstRemoved) {
                const leadingWs = value.match(/^(\s*)/)?.[1] || '';
                value = value.slice(leadingWs.length);
                appendDiffFragment(removedRow, leadingWs, false);
                isFirstRemoved = false;
            }
            appendDiffFragment(removedRow, value, true);
        } else if (part.added) {
            let value = part.value;
            if (isFirstAdded) {
                const leadingWs = value.match(/^(\s*)/)?.[1] || '';
                value = value.slice(leadingWs.length);
                appendDiffFragment(addedRow, leadingWs, false);
                isFirstAdded = false;
            }
            appendDiffFragment(addedRow, value, true);
        } else {
            appendDiffFragment(removedRow, part.value, false);
            appendDiffFragment(addedRow, part.value, false);
        }
    }
    container.append(removedRow, addedRow);
    return true;
}
/** Vendored from Pi's diff.js:59-132, adapted to semantic DOM rows. */
function appendDiffRows(container, diffText) {
    const lines = diffText.split('\n');
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        const parsed = parseDiffLine(line);
        if (!parsed) {
            appendPlainDiffRow(container, 'diff-context', line);
            index++;
            continue;
        }
        if (parsed.prefix === '-') {
            const removedLines = [];
            while (index < lines.length) {
                const candidate = parseDiffLine(lines[index]);
                if (!candidate || candidate.prefix !== '-') break;
                removedLines.push(candidate);
                index++;
            }
            const addedLines = [];
            while (index < lines.length) {
                const candidate = parseDiffLine(lines[index]);
                if (!candidate || candidate.prefix !== '+') break;
                addedLines.push(candidate);
                index++;
            }
            if (removedLines.length === 1 && addedLines.length === 1) {
                if (
                    appendIntraLineDiffRows(
                        container,
                        removedLines[0],
                        addedLines[0],
                    )
                )
                    continue;
            }
            for (const removedLine of removedLines)
                appendParsedDiffRow(container, removedLine, 'diff-removed');
            for (const addedLine of addedLines)
                appendParsedDiffRow(container, addedLine, 'diff-added');
            continue;
        }
        if (parsed.prefix === '+') {
            appendParsedDiffRow(container, parsed, 'diff-added');
        } else {
            appendParsedDiffRow(container, parsed, 'diff-context');
        }
        index++;
    }
}
/** Header subject line per tool (path / pattern / agent …), upstream-shaped. */
function appendHeader(wrapper, name, args) {
    const header = el('div', 'tool-header');
    header.appendChild(el('span', 'tool-name', name));
    const addPath = (raw, extra) => {
        header.appendChild(el('span', 'tool-path', shortenPath(raw)));
        if (extra) header.appendChild(extra);
    };
    switch (name) {
        case 'read': {
            const filePath = str(args.file_path ?? args.path);
            if (filePath === null) {
                header.appendChild(el('span', 'tool-error', '[invalid arg]'));
                break;
            }
            let extra = null;
            const offset = args.offset;
            const limit = args.limit;
            if (offset !== undefined || limit !== undefined) {
                const startLine = typeof offset === 'number' ? offset : 1;
                const endLine =
                    typeof limit === 'number' ? startLine + limit - 1 : null;
                extra = el(
                    'span',
                    'line-numbers',
                    `:${startLine}${endLine ? `-${endLine}` : ''}`,
                );
            }
            addPath(filePath || '', extra);
            break;
        }
        case 'write': {
            const filePath = str(args.file_path ?? args.path);
            if (filePath === null) {
                header.appendChild(el('span', 'tool-error', '[invalid arg]'));
                break;
            }
            addPath(filePath || '');
            const content = str(args.content);
            if (content) {
                const lines = content.split('\n');
                if (lines.length > 10)
                    header.appendChild(
                        el('span', 'line-count', `(${lines.length} lines)`),
                    );
            }
            break;
        }
        case 'edit': {
            const filePath = str(args.file_path ?? args.path);
            if (filePath === null) {
                header.appendChild(el('span', 'tool-error', '[invalid arg]'));
                break;
            }
            addPath(filePath || '');
            break;
        }
        case 'ls': {
            const dirPath = str(args.path);
            if (dirPath === null) {
                header.appendChild(el('span', 'tool-error', '[invalid arg]'));
                break;
            }
            addPath(dirPath || '.');
            if (typeof args.limit === 'number') {
                header.appendChild(
                    el('span', 'line-count', `(limit ${args.limit})`),
                );
            }
            break;
        }
        case 'grep':
        case 'find': {
            const pattern = str(args.pattern ?? args.query);
            if (pattern) header.appendChild(el('span', 'tool-path', pattern));
            else if (typeof args.path === 'string') addPath(args.path || '.');
            break;
        }
        case 'subagent': {
            const agent = str(args.agent);
            const action = str(args.action);
            const task = str(args.task);
            const subject = agent
                ? action
                    ? `${action} · ${agent}`
                    : agent
                : task
                  ? truncate(task.split('\n')[0])
                  : action;
            if (subject) header.appendChild(el('span', 'tool-path', subject));
            break;
        }
        default: {
            const id = str(args.id ?? args.sessionId);
            if (id) header.appendChild(el('span', 'tool-path', truncate(id)));
            break;
        }
    }
    wrapper.appendChild(header);
}
/**
 * Renders a `.tool-execution` block for any non-bash tool, matching the
 * upstream HTML export structure per tool family:
 *   read/ls   → expandable result output
 *   write     → content preview, then plain result line
 *   edit      → Pi TUI-style diff rows when validated metadata is present,
 *                otherwise a plain pre result
 *   default   → args JSON pre while useful, then expandable result
 */
export function renderToolExecution(input) {
    const { id, name, args, status, output, diff } = input;
    const wrapper = document.createElement('div');
    wrapper.className = `tool-execution ${status}${status === 'error' ? ' folded' : ''}`;
    wrapper.id = `tool-call-${id}`;
    appendHeader(wrapper, name, args);
    const resultText = output?.trim() ?? '';
    const appendPlainOutput = (text) => {
        const body = el('div', 'tool-output');
        body.appendChild(el('div', '', text));
        wrapper.appendChild(body);
    };
    switch (name) {
        case 'read':
        case 'ls': {
            if (resultText) {
                const inner = expandableOutputElement(
                    resultText,
                    name === 'read' ? 10 : 20,
                );
                if (inner) wrapper.appendChild(inner);
            }
            break;
        }
        case 'write': {
            const content = str(args.content);
            if (content) {
                const inner = expandableOutputElement(content, 10);
                if (inner) wrapper.appendChild(inner);
            }
            if (resultText) appendPlainOutput(resultText);
            break;
        }
        case 'edit': {
            if (status === 'success' && diff !== undefined) {
                const body = el('div', 'tool-diff');
                appendDiffRows(body, diff);
                wrapper.appendChild(body);
            } else if (resultText) {
                const body = el('div', 'tool-output');
                body.appendChild(el('pre', '', resultText));
                wrapper.appendChild(body);
            }
            break;
        }
        default: {
            // Upstream fallback: show the call args as JSON, then the
            // result text expandably once it lands.
            if (Object.keys(args).length > 0) {
                const body = el('div', 'tool-output');
                body.appendChild(el('pre', '', JSON.stringify(args, null, 2)));
                wrapper.appendChild(body);
            }
            if (resultText) {
                const inner = expandableOutputElement(resultText, 10);
                if (inner) wrapper.appendChild(inner);
            }
            break;
        }
    }
    if (
        status === 'pending' &&
        wrapper.querySelector('.tool-output') === null
    ) {
        const running = el('div', 'tool-output', 'running…');
        wrapper.appendChild(running);
    }
    const header = wrapper.querySelector('.tool-header');
    if (header) {
        const toggle = () => {
            // Error blocks render folded (CSS hides the body via `.folded`);
            // the header click unfolds them. Non-error blocks keep the
            // vendored expandable preview toggle.
            if (status === 'error') {
                wrapper.classList.toggle('folded');
                return;
            }
            wrapper
                .querySelectorAll('.tool-output.expandable')
                .forEach((el) => {
                    el.classList.toggle('expanded');
                });
        };
        header.setAttribute('role', 'button');
        header.setAttribute('tabindex', '0');
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
            }
        });
    }
    return wrapper;
}
