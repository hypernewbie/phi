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
    it('/skill: and /template allowed', () => {
        expect(dispatchComposer('/skill:commit').op).toBe('prompt');
        expect(dispatchComposer('/template sum').op).toBe('prompt');
    });
    it('raw extension rejected', () => {
        expect(dispatchComposer('/status').kind).toBe('rejected');
    });
});
