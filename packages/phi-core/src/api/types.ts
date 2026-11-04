// Shared API seam types. Core owns URL building, parsing, decoding,
// and outcome mapping; the platform adapter (Stage 6) owns HTTP policy
// (headers, credentials, deadlines, body limits). Wire field names stay
// snake_case, verbatim from the Go server.

// Core compiles with lib ES2022 and no DOM/node types, so the
// built-in AbortSignal type does not exist here. Core only passes
// the signal through to the transport; this structural minimum
// accepts a real AbortSignal from the adapter.
export interface AbortSignalLike {
    readonly aborted: boolean;
}

export interface ApiRequest {
    readonly method: 'GET' | 'POST';
    // Path + query, always starting with '/'. No origin: the
    // adapter owns the upstream target (Stage 6).
    readonly path: string;
    readonly body?: string;
    readonly signal: AbortSignalLike;
    readonly bearer?: string;
}

export type TransportResult =
    | { kind: 'response'; status: number; text: string }
    | { kind: 'network-failure' }
    | { kind: 'cancelled' };

export type ApiTransport = (request: ApiRequest) => Promise<TransportResult>;

// Session mirrors pkg/session.Session. The legacy validator treats
// cwd/coder/session_path as optional strings; id/title/time_updated
// are required.
export interface Session {
    readonly id: string;
    readonly title: string;
    readonly cwd?: string;
    readonly coder?: string;
    readonly session_path?: string;
    readonly time_updated: string;
}

export type SessionsOutcome =
    | { kind: 'ok'; sessions: Session[] }
    | { kind: 'auth-required' }
    | { kind: 'unsupported-coder' }
    | { kind: 'invalid-response' }
    | { kind: 'unavailable' }
    | { kind: 'cancelled' };

export type RenameOutcome =
    | { kind: 'ok' }
    | { kind: 'unchanged' }
    | { kind: 'auth-required' }
    | { kind: 'unavailable' }
    | { kind: 'cancelled' };

export interface Capabilities {
    readonly list: boolean;
    readonly transcript: boolean;
    readonly rename: boolean;
    readonly pi_rpc: boolean;
}

export interface Preset {
    readonly name: string;
    readonly value: string;
}

// CoderDescriptor mirrors pkg/coders.CoderDescriptor: the allowlisted
// browser DTO. Never carries command/args/env/default_cwd/
// session_source; unknown wire fields are dropped at decode.
export interface CoderDescriptor {
    readonly id: string;
    readonly order?: number;
    readonly name: string;
    readonly short_label: string;
    readonly logo?: string;
    readonly sidebar_visible: boolean;
    readonly is_shell: boolean;
    readonly input_mode: 'staged' | 'direct';
    readonly presets?: Preset[];
    readonly capabilities: Capabilities;
    readonly model_switch_disabled: boolean;
    readonly opencode_mode?: 'tui' | 'mini' | 'legacy';
    readonly opencode_mini_presets?: Preset[];
    readonly pi_mode?: string;
}

export type CoderRegistry = Map<string, CoderDescriptor>;

export type CodersOutcome =
    | { kind: 'ok'; descriptors: CoderDescriptor[] }
    | { kind: 'auth-required' }
    | { kind: 'invalid-response' }
    | { kind: 'unavailable' }
    | { kind: 'cancelled' };
