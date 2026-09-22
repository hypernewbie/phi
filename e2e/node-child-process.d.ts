import type { EventEmitter } from 'node:events';

// TypeScript's bundled Node 26 declarations model ChildProcess as merely
// implementing EventEmitter. Surface the inherited event methods for editor
// servers; Node's runtime and the project's pinned Node 24 declarations both
// provide them.
declare module 'node:child_process' {
    interface ChildProcess {
        on: EventEmitter['on'];
        once: EventEmitter['once'];
    }
}
