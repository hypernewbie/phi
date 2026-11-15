/* Φ phi — compact Pi provider and thinking marks */

import { PROVIDER_MARK_URLS } from './model-icon-data.js';

// Compact Pi pills show one icon instead of a model or thinking label.
// Matching stays lexical: the bridge sends provider-qualified IDs and the
// RPC wire sends display names, so a brand prefix is the only evidence the
// browser has. No DOM, network, or asset loading belongs in this module.

export interface ProviderMark {
    /** Always one of the vendored asset IDs below. */
    id: string;
}

export interface ThinkingGlyph {
    glyph: string;
    tier:
        | 'off'
        | 'minimal'
        | 'low'
        | 'medium'
        | 'high'
        | 'xhigh'
        | 'max'
        | 'unknown';
    size: number;
}

// Asset ID on the left; the aliases that identify it on the right.
const PROVIDER_ALIASES: ReadonlyMap<string, string> = new Map([
    ['deepseek', 'deepseek'],
    ['deepseek-ai', 'deepseek'],
    ['openai', 'openai'],
    ['azure-openai', 'openai'],
    ['azure', 'openai'],
    ['anthropic', 'anthropic'],
    ['claude', 'anthropic'],
    ['google', 'gemini'],
    ['gemini', 'gemini'],
    ['google-vertex', 'gemini'],
    ['vertex', 'gemini'],
    ['xai', 'xai'],
    ['grok', 'xai'],
    ['qwen', 'qwen'],
    ['alibaba', 'qwen'],
    ['dashscope', 'qwen'],
    ['moonshot', 'kimi'],
    ['kimi', 'kimi'],
    ['minimax', 'minimax'],
    ['zhipu', 'zhipu'],
    ['zai', 'zhipu'],
    ['glm', 'zhipu'],
    ['z-ai', 'zhipu'],
    ['mistral', 'mistral'],
    ['mistralai', 'mistral'],
    ['meta', 'meta'],
    ['meta-llama', 'meta'],
    ['llama', 'meta'],
    ['nvidia', 'nvidia'],
    ['cerebras', 'cerebras'],
    ['bytedance', 'bytedance'],
    ['doubao', 'bytedance'],
    ['volcengine', 'bytedance'],
    ['baidu', 'baidu'],
    ['ernie', 'baidu'],
    ['tencent', 'tencent'],
    ['hunyuan', 'tencent'],
    ['cohere', 'cohere'],
    ['perplexity', 'perplexity'],
    ['huggingface', 'huggingface'],
    ['hf', 'huggingface'],
    ['githubcopilot', 'githubcopilot'],
    ['github', 'githubcopilot'],
    ['copilot', 'githubcopilot'],
    ['openrouter', 'openrouter'],
    ['groq', 'groq'],
]);

// Routers pass their vendor through the remaining path segments.
const ROUTER_ALIASES = new Set(['openrouter', 'router']);

// A brand may start a segment, but only at a word boundary: gpt-* must not
// become OpenAI, and xiaomi must not become xAI.
const PREFIX_BOUNDARY = /[\s\-_.:@]/;

const ALIASES_BY_LENGTH = [...PROVIDER_ALIASES.keys()].sort(
    (a, b) => b.length - a.length,
);

function markForSegment(segment: string): string | null {
    for (const alias of ALIASES_BY_LENGTH) {
        if (!segment.startsWith(alias)) continue;
        if (
            segment.length > alias.length &&
            !PREFIX_BOUNDARY.test(segment[alias.length])
        )
            continue;
        return PROVIDER_ALIASES.get(alias) ?? null;
    }
    return null;
}

export function providerMarkFor(
    model: string | null | undefined,
): ProviderMark | null {
    if (typeof model !== 'string') return null;
    const value = model.trim().toLowerCase();
    if (!value) return null;
    if (!value.includes('/')) {
        const id = markForSegment(value);
        return id ? { id } : null;
    }
    const segments = value.split('/').map((part) => part.trim());
    if (segments.some((part) => part === '')) return null;
    const first = segments[0];
    if (ROUTER_ALIASES.has(first)) {
        // The router itself is the fallback, never the vendor of a model it
        // only forwards.
        for (let index = 1; index < segments.length; index += 1) {
            const id = markForSegment(segments[index]);
            if (id && id !== 'openrouter') return { id };
        }
        return first === 'openrouter' ? { id: 'openrouter' } : null;
    }
    const direct = markForSegment(first);
    if (direct) return { id: direct };
    // An unknown vendor can still pass a known model vendor.
    for (let index = 1; index < segments.length; index += 1) {
        const id = markForSegment(segments[index]);
        if (id) return { id };
    }
    return null;
}

export function providerMarkUrlFor(id: string): string | null {
    return Object.hasOwn(PROVIDER_MARK_URLS, id)
        ? PROVIDER_MARK_URLS[id]
        : null;
}

// One size table is the only source for the brain ladder. `max` and the
// unknown fallback keep the 16 px slot; larger levels do not resize it.
const THINKING_GLYPHS: Readonly<Record<string, ThinkingGlyph>> = {
    off: { glyph: '🧠', tier: 'off', size: 5 },
    minimal: { glyph: '🧠', tier: 'minimal', size: 11 },
    low: { glyph: '🧠', tier: 'low', size: 13 },
    medium: { glyph: '🧠', tier: 'medium', size: 14 },
    high: { glyph: '🧠', tier: 'high', size: 15 },
    xhigh: { glyph: '🧠', tier: 'xhigh', size: 16 },
    max: { glyph: '🌌', tier: 'max', size: 16 },
    unknown: { glyph: '🧠', tier: 'unknown', size: 16 },
};

export function thinkingGlyphFor(
    level: string | null | undefined,
): ThinkingGlyph {
    const key = typeof level === 'string' ? level.trim().toLowerCase() : '';
    const row = Object.hasOwn(THINKING_GLYPHS, key)
        ? THINKING_GLYPHS[key]
        : THINKING_GLYPHS.unknown;
    return { ...row };
}
