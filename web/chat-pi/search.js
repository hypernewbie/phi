function segmentText(segment) {
    switch (segment.kind) {
        case 'text':
        case 'thinking':
        case 'toolResult':
            return segment.kind === 'toolResult'
                ? segment.content
                : segment.text;
        case 'toolCall': {
            const args = JSON.stringify(segment.args);
            return `${segment.name}${args === '{}' ? '' : ` ${args}`}`;
        }
        case 'unsupported':
            return '';
    }
}
export function flatTextFromMessage(message) {
    return message.segments.map(segmentText).filter(Boolean).join('\n');
}
export function buildSearchCorpus(source) {
    const messages = source.slice(0, source.length);
    const toolCallIndexes = new Map();
    messages.forEach((message, index) => {
        for (const segment of message.segments) {
            if (segment.kind === 'toolCall')
                toolCallIndexes.set(segment.id, index);
        }
    });
    return messages.flatMap((message, offset) => {
        const flatText = flatTextFromMessage(message);
        const pairedIndex =
            message.role === 'toolResult' && message.toolCallId
                ? toolCallIndexes.get(message.toolCallId)
                : undefined;
        return flatText
            ? [
                  {
                      bufferIndex: pairedIndex ?? offset,
                      role: message.role,
                      flatText,
                  },
              ]
            : [];
    });
}
function searchSnippet(text, start, end) {
    const context = 60;
    const before = Math.floor(context / 2);
    const after = context - before;
    const from = Math.max(0, start - before);
    const to = Math.min(text.length, end + after);
    return text.slice(from, to);
}
export function findSearchMatches(corpus, query) {
    if (!query) return [];
    const needle = query.toLocaleLowerCase();
    const matches = [];
    const nextOccurrence = new Map();
    for (const entry of corpus) {
        const haystack = entry.flatText.toLocaleLowerCase();
        let from = 0;
        let occurrence = nextOccurrence.get(entry.bufferIndex) ?? 0;
        while (from <= haystack.length - needle.length) {
            const start = haystack.indexOf(needle, from);
            if (start < 0) break;
            const end = start + query.length;
            matches.push({
                ...entry,
                start,
                end,
                occurrence,
                snippet: searchSnippet(entry.flatText, start, end),
            });
            occurrence += 1;
            from = start + Math.max(needle.length, 1);
        }
        nextOccurrence.set(entry.bufferIndex, occurrence);
    }
    return matches;
}
export function createPiSearchController(options) {
    const bar = document.createElement('div');
    bar.className = 'pi-search-bar hidden';
    bar.setAttribute('role', 'search');
    const input = document.createElement('input');
    input.type = 'search';
    input.setAttribute('data-pi-search-input', '');
    input.setAttribute('aria-label', 'Search Pi transcript');
    input.autocomplete = 'off';
    const count = document.createElement('span');
    count.setAttribute('data-pi-search-count', '');
    count.setAttribute('aria-live', 'polite');
    count.textContent = '0 / 0';
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.setAttribute('data-pi-search-prev', '');
    previous.setAttribute('aria-label', 'Previous search match');
    previous.textContent = '↑';
    const next = document.createElement('button');
    next.type = 'button';
    next.setAttribute('data-pi-search-next', '');
    next.setAttribute('aria-label', 'Next search match');
    next.textContent = '↓';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.setAttribute('data-pi-search-close', '');
    closeButton.setAttribute('aria-label', 'Close transcript search');
    closeButton.textContent = '×';
    bar.append(input, count, previous, next, closeButton);
    const contentBody = options.root.querySelector('.review-content-body');
    if (contentBody) options.root.insertBefore(bar, contentBody);
    else options.root.appendChild(bar);
    let source = {
        length: 0,
        slice: () => [],
    };
    let corpus = [];
    let matches = [];
    let activeMatch = 0;
    let query = '';
    let debounceTimer = null;
    const isOpen = () => !bar.classList.contains('hidden');
    const updateCount = () => {
        count.textContent = matches.length
            ? `${activeMatch + 1} / ${matches.length}`
            : '0 / 0';
        previous.disabled = matches.length === 0;
        next.disabled = matches.length === 0;
    };
    const revealActive = () => {
        options.clearSearchMarks();
        if (!isOpen() || matches.length === 0) return;
        const match = matches[activeMatch];
        options.revealMessage(match.bufferIndex);
        options.markSearchMatch(match.bufferIndex, query, match.occurrence);
    };
    const refresh = () => {
        matches = findSearchMatches(corpus, query);
        activeMatch = Math.min(activeMatch, Math.max(0, matches.length - 1));
        updateCount();
        revealActive();
    };
    const move = (direction) => {
        if (matches.length === 0) return;
        activeMatch =
            (activeMatch + direction + matches.length) % matches.length;
        updateCount();
        revealActive();
    };
    const open = () => {
        bar.classList.remove('hidden');
        updateCount();
        input.focus({ preventScroll: true });
        revealActive();
    };
    const close = () => {
        if (!isOpen()) return false;
        bar.classList.add('hidden');
        options.clearSearchMarks();
        return true;
    };
    input.addEventListener('input', () => {
        query = input.value;
        activeMatch = 0;
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            debounceTimer = null;
            refresh();
        }, 120);
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            move(event.shiftKey ? -1 : 1);
        }
    });
    previous.addEventListener('click', () => move(-1));
    next.addEventListener('click', () => move(1));
    closeButton.addEventListener('click', () => close());
    return {
        setSource(nextSource) {
            source = nextSource;
            corpus = buildSearchCorpus(source);
            if (isOpen()) refresh();
        },
        toggle() {
            if (isOpen()) {
                close();
                return false;
            }
            open();
            return true;
        },
        open,
        close,
        isOpen,
        destroy() {
            if (debounceTimer !== null) clearTimeout(debounceTimer);
            options.clearSearchMarks();
            bar.remove();
        },
    };
}
