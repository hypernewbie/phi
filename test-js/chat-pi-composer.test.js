import { describe, it, expect } from 'vitest';
import { dispatchComposer } from '../web/chat-pi/composer.js';

describe('composer', () => {
    it('plain text -> prompt (trimmed)', () => {
        expect(dispatchComposer('  hello  ', false)).toEqual({
            kind: 'prompt',
            op: 'prompt',
            message: 'hello',
        });
    });
    it('busy -> steer', () => {
        expect(dispatchComposer('more', true)).toEqual({
            kind: 'prompt',
            op: 'prompt',
            message: 'more',
            streamingBehavior: 'steer',
        });
    });
    it('/skill: and /template allowed', () => {
        expect(dispatchComposer('/skill:commit', false).op).toBe('prompt');
        expect(dispatchComposer('/template sum', false).op).toBe('prompt');
    });
    it('raw extension rejected', () => {
        expect(dispatchComposer('/status', false).kind).toBe('rejected');
    });
});
