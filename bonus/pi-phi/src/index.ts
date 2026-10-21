// Phi's maintained Pi integration extension: lifecycle bell over a
// local IPC bridge. The wire contract, validation, bounded-queue
// helpers, lifecycle runtime, and extension factory.

export {
    PROTOCOL_VERSION,
    CAPABILITY_LIFECYCLE,
    MAX_MESSAGE_BYTES,
    MAX_QUEUED_MESSAGES,
    MAX_QUEUED_BYTES,
    BLOCKED_SEND_TIMEOUT_MS,
    MAX_JOURNAL_RECORDS,
    negotiateCapabilities,
    isKnownCapability,
} from './protocol.js';
export { parseTarget, InvalidTargetError } from './endpoint.js';
export type { IpcTargetKind, ParsedTarget } from './endpoint.js';
export { BoundedQueue } from './queue.js';
export type { SizedMessage } from './queue.js';
export { createExtension, default } from './extension.js';
