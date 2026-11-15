/* Φ phi — compact Pi provider and thinking marks */
import { PROVIDER_MARK_URLS } from './model-icon-data.js';
// Asset ID on the left; the aliases that identify it on the right.
const PROVIDER_ALIASES = new Map([
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
// A brand may start a segment, but only at a word boundary or before a
// version digit: qwen3.8 is Qwen, while gpt-* and xiaomi stay unknown.
const PREFIX_BOUNDARY = /[\s\-_.:@0-9]/;
const ALIASES_BY_LENGTH = [...PROVIDER_ALIASES.keys()].sort((a, b) => b.length - a.length);
function markForSegment(segment) {
    for (const alias of ALIASES_BY_LENGTH) {
        if (!segment.startsWith(alias))
            continue;
        if (segment.length > alias.length &&
            !PREFIX_BOUNDARY.test(segment[alias.length]))
            continue;
        return PROVIDER_ALIASES.get(alias) ?? null;
    }
    return null;
}
export function providerMarkFor(model) {
    if (typeof model !== 'string')
        return null;
    const value = model.trim().toLowerCase();
    if (!value)
        return null;
    const parts = value.split('/').map((part) => part.trim());
    if (parts.some((part) => part === ''))
        return null;
    // The provider is the first segment. A known provider wins even when the
    // model belongs to another vendor (openrouter is OpenRouter, not the
    // model it forwards). A provider prefix also covers openai-codex and
    // kimi-coding.
    const provider = markForSegment(parts[0]);
    if (provider)
        return { id: provider };
    // The provider has no mark: read the model ID from that provider. Only
    // the first model segment is the vendor; deeper segments are routing.
    if (parts.length < 2)
        return null;
    const id = markForSegment(parts[1]);
    return id ? { id } : null;
}
export function providerMarkUrlFor(id) {
    return Object.hasOwn(PROVIDER_MARK_URLS, id)
        ? PROVIDER_MARK_URLS[id]
        : null;
}
// One size table is the only source for the brain ladder. `max` and the
// unknown fallback keep the 16 px slot; larger levels do not resize it.
const THINKING_GLYPHS = {
    off: { glyph: '🧠', tier: 'off', size: 5 },
    minimal: { glyph: '🧠', tier: 'minimal', size: 11 },
    low: { glyph: '🧠', tier: 'low', size: 13 },
    medium: { glyph: '🧠', tier: 'medium', size: 14 },
    high: { glyph: '🧠', tier: 'high', size: 15 },
    xhigh: { glyph: '🧠', tier: 'xhigh', size: 16 },
    max: { glyph: '🌌', tier: 'max', size: 16 },
    unknown: { glyph: '🧠', tier: 'unknown', size: 16 },
};
export function thinkingGlyphFor(level) {
    const key = typeof level === 'string' ? level.trim().toLowerCase() : '';
    const row = Object.hasOwn(THINKING_GLYPHS, key)
        ? THINKING_GLYPHS[key]
        : THINKING_GLYPHS.unknown;
    return { ...row };
}
