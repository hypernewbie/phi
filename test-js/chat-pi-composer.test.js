import { describe, it, expect } from 'vitest';
import { dispatchComposer } from '../web/chat-pi/composer.js';

describe('composer', () => {
    it('plain text -> prompt (trimmed), always steer', () => {
        expect(dispatchComposer('  hello  ')).toEqual({
            kind: 'prompt',
            op: 'prompt',
            message: 'hello',
            streamingBehavior: 'steer',
        });
    });
    it('slash commands are sent raw without steer semantics', () => {
        expect(dispatchComposer('/clear')).toEqual({
            kind: 'raw',
            op: 'prompt',
            message: '/clear',
        });
        expect(dispatchComposer('/skill:commit').kind).toBe('raw');
        expect(dispatchComposer('/template sum').kind).toBe('raw');
    });
});
