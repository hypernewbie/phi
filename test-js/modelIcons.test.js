// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    providerMarkFor,
    providerMarkUrlFor,
    thinkingGlyphFor,
} from '../web/model-icons.js';

// The compact pill has no words to explain a wrong icon, so the mapping is
// tested directly: explicit providers win, routers defer to the vendor in
// the path, and unknown names keep the robot.

const FAMILIES = {
    deepseek: ['deepseek', 'deepseek-ai'],
    openai: ['openai', 'azure-openai', 'azure'],
    anthropic: ['anthropic', 'claude'],
    gemini: ['google', 'gemini', 'google-vertex', 'vertex'],
    xai: ['xai', 'grok'],
    qwen: ['qwen', 'alibaba', 'dashscope'],
    kimi: ['moonshot', 'kimi'],
    minimax: ['minimax'],
    zhipu: ['zhipu', 'zai', 'glm', 'z-ai'],
    mistral: ['mistral', 'mistralai'],
    meta: ['meta', 'meta-llama', 'llama'],
    nvidia: ['nvidia'],
    cerebras: ['cerebras'],
    bytedance: ['bytedance', 'doubao', 'volcengine'],
    baidu: ['baidu', 'ernie'],
    tencent: ['tencent', 'hunyuan'],
    cohere: ['cohere'],
    perplexity: ['perplexity'],
    huggingface: ['huggingface', 'hf'],
    githubcopilot: ['githubcopilot', 'github', 'copilot'],
    openrouter: ['openrouter'],
    groq: ['groq'],
};

describe('providerMarkFor', () => {
    it.each([
        ['deepseek', 'deepseek'],
        ['DeepSeek', 'deepseek'],
        ['  DeepSeek V3  ', 'deepseek'],
        ['deepseek-chat', 'deepseek'],
        ['deepseek-reasoner', 'deepseek'],
        ['deepseek-ai/DeepSeek-V3', 'deepseek'],
        ['kimi-coding/k3', 'kimi'],
        ['kimi-coding/kimi-for-coding', 'kimi'],
        ['opencode-go/qwen3.8-max', 'qwen'],
        ['qwen3.8-max', 'qwen'],
        ['qwen2.5-coder', 'qwen'],
        ['minimax/MiniMax-M3', 'minimax'],
        ['zai/glm-5', 'zhipu'],
        ['openrouter/deepseek/deepseek-chat', 'deepseek'],
        ['unknown/deepseek/deepseek-chat', 'deepseek'],
    ])('maps %j to %s', (model, id) => {
        expect(providerMarkFor(model)).toEqual({ id });
    });

    it.each([
        ['', null],
        ['   ', null],
        [null, null],
        [undefined, null],
        ['notdeepseek/model', null],
        ['mydeepseekbackup', null],
        ['deepseekbackup', null],
        ['xiaomi/mimo', null],
        ['router/vendor/model-0', null],
        ['constructor/toString', null],
        ['/deepseek', null],
        ['deepseek/', null],
        ['deepseek//model', null],
        ['unknown', null],
        // Display names are not evidence: no OpenAI or DeepSeek guess.
        ['Ambiguous Model 9000', null],
        ['gpt-5', null],
        ['o3-mini', null],
    ])('keeps the robot for %j', (model, id) => {
        expect(providerMarkFor(model)).toBe(id);
    });

    it.each(Object.entries(FAMILIES))('maps every %s alias', (id, aliases) => {
        for (const alias of aliases) {
            expect(providerMarkFor(alias), alias).toEqual({ id });
            expect(providerMarkFor(`${alias}/model`), alias).toEqual({
                id,
            });
            expect(providerMarkFor(`${alias}-model`), alias).toEqual({
                id,
            });
        }
    });

    it.each([
        ['githubcopilot/gpt-5', 'githubcopilot'],
        ['groq/deepseek-r1', 'groq'],
        ['openrouter/anthropic/claude-sonnet-4', 'anthropic'],
        ['openrouter/openai/gpt-5', 'openai'],
        ['moonshot/kimi-k2', 'kimi'],
        ['meta-llama/llama-4', 'meta'],
        // A direct provider wins over a model name in its path.
        ['google/deepseek', 'gemini'],
        ['amazon/claude', 'anthropic'],
        // Router paths prefer the vendor, and only then the router.
        ['openrouter/xai/grok-4', 'xai'],
        ['openrouter/google/gemini-2.5', 'gemini'],
        // Unknown paths read left to right.
        ['custom/mistral/groq', 'mistral'],
        ['proxy/xai/llama', 'xai'],
        ['openrouter/vendor/model-0', 'openrouter'],
        ['openrouter/model-0', 'openrouter'],
        ['openrouter/constructor/toString', 'openrouter'],
    ])('resolves %j to %s', (model, id) => {
        expect(providerMarkFor(model)).toEqual({ id });
    });

    it('ships one nonempty local SVG for every canonical mark', () => {
        const dir = join(process.cwd(), 'web/vendor/model-icons');
        const files = readdirSync(dir)
            .filter((name) => name.endsWith('.svg'))
            .map((name) => name.replace(/\.svg$/, ''))
            .sort();
        expect(files).toEqual(Object.keys(FAMILIES).sort());
        for (const id of Object.keys(FAMILIES)) {
            const svg = readFileSync(join(dir, `${id}.svg`), 'utf8');
            expect(svg.length, id).toBeGreaterThan(0);
            expect(svg, id).toContain('<svg');
            expect(svg, id).toContain('currentColor');
        }
    });

    it('inlines every vendored mark as a data URL', () => {
        const dir = join(process.cwd(), 'web/vendor/model-icons');
        for (const id of Object.keys(FAMILIES)) {
            const url = providerMarkUrlFor(id);
            expect(url, id).toMatch(/^data:image\/svg\+xml;utf8,/);
            const encoded = url.slice('data:image/svg+xml;utf8,'.length);
            expect(decodeURIComponent(encoded), id).toBe(
                readFileSync(join(dir, `${id}.svg`), 'utf8'),
            );
        }
        expect(providerMarkUrlFor('missing')).toBeNull();
    });

    it('accepts every documented prefix boundary', () => {
        for (const suffix of [
            ' V3',
            '-chat',
            '_chat',
            '.chat',
            ':chat',
            '@chat',
            '3',
            '3.8-max',
        ])
            expect(providerMarkFor(`deepseek${suffix}`)).toEqual({
                id: 'deepseek',
            });
    });

    it('is case- and whitespace-insensitive inside slash paths', () => {
        expect(providerMarkFor(' DeepSeek / DeepSeek-V3 ')).toEqual({
            id: 'deepseek',
        });
    });
});

describe('thinkingGlyphFor', () => {
    it.each([
        ['off', '🧠', 'off', 5],
        ['minimal', '🧠', 'minimal', 11],
        ['low', '🧠', 'low', 13],
        ['medium', '🧠', 'medium', 14],
        ['high', '🧠', 'high', 15],
        ['xhigh', '🧠', 'xhigh', 16],
        ['max', '🌌', 'max', 16],
        ['unknown', '🧠', 'unknown', 16],
    ])('renders %s as %s at %i px', (level, glyph, tier, size) => {
        expect(thinkingGlyphFor(level)).toEqual({ glyph, tier, size });
    });

    it.each([
        ['  MAX  ', 'max'],
        ['High', 'high'],
        ['', 'unknown'],
        ['   ', 'unknown'],
        [null, 'unknown'],
        [undefined, 'unknown'],
        ['turbo', 'unknown'],
    ])('normalizes %j to the %s tier', (level, tier) => {
        expect(thinkingGlyphFor(level).tier).toBe(tier);
        const row = thinkingGlyphFor(level);
        expect(row.size).toBe(
            tier === 'off'
                ? 5
                : tier === 'minimal'
                  ? 11
                  : tier === 'low'
                    ? 13
                    : tier === 'medium'
                      ? 14
                      : tier === 'high'
                        ? 15
                        : 16,
        );
        expect(row.glyph).toBe(tier === 'max' ? '🌌' : '🧠');
    });

    it('does not leak a shared row to callers', () => {
        const first = thinkingGlyphFor('max');
        first.size = 99;
        expect(thinkingGlyphFor('max').size).toBe(16);
    });
});
