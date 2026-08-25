import { describe, it, expect } from 'vitest';
import { dispatchComposer } from '../web/chat-pi/composer.js';

describe('composer', () => {
    it('idle plain text becomes a trimmed prompt queue item', () => {
        expect(dispatchComposer('  hello  ')).toEqual({
            kind: 'queue',
            message: 'hello',
            delivery: 'prompt',
        });
    });

    it('busy Enter steers and Alt+Enter follows up', () => {
        expect(dispatchComposer('steer me', { busy: true })).toEqual({
            kind: 'queue',
            message: 'steer me',
            delivery: 'steer',
        });
        expect(
            dispatchComposer('follow me', { busy: true, followUp: true }),
        ).toEqual({
            kind: 'queue',
            message: 'follow me',
            delivery: 'followUp',
        });
    });

    it('/skill: and /template remain allowed', () => {
        expect(dispatchComposer('/skill:commit').kind).toBe('queue');
        expect(dispatchComposer('/template').kind).toBe('queue');
        expect(dispatchComposer('/template sum').kind).toBe('queue');
    });

    it('raw extension rejected', () => {
        expect(dispatchComposer('/status').kind).toBe('rejected');
    });
});
