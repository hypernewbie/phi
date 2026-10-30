import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { Notification } from "./events.js";
export declare const protobufPackage = "phi.websocket.terminal.v1";
export declare const protobufFileName = "terminal.proto";
export interface TerminalClientFrame {
    payload: {
        $case: "input";
        value: Uint8Array;
    } | {
        $case: "resize";
        value: TerminalResize;
    } | {
        $case: "ping";
        value: TerminalPing;
    } | undefined;
}
export interface TerminalResize {
    cols?: number | undefined;
    rows?: number | undefined;
}
export interface TerminalPing {
}
export interface TerminalServerFrame {
    payload: {
        $case: "attach";
        value: TerminalAttach;
    } | {
        $case: "output";
        value: TerminalOutput;
    } | {
        $case: "pong";
        value: TerminalPong;
    } | {
        $case: "exit";
        value: TerminalExit;
    } | {
        $case: "dropNotice";
        value: TerminalDropNotice;
    } | {
        $case: "title";
        value: TerminalTitle;
    } | {
        $case: "bridgeState";
        value: TerminalBridgeState;
    } | {
        $case: "settlement";
        value: TerminalSettlement;
    } | {
        $case: "notification";
        value: Notification;
    } | undefined;
}
export interface TerminalAttach {
    epoch?: bigint | undefined;
    oldest?: bigint | undefined;
    head?: bigint | undefined;
    checkpoint: TerminalCheckpoint | undefined;
    replayFrom?: bigint | undefined;
}
export interface TerminalCheckpoint {
    kind?: string | undefined;
    through?: bigint | undefined;
    cols?: number | undefined;
    rows?: number | undefined;
    data: Uint8Array;
    eventCursor?: string | undefined;
}
export interface TerminalOutput {
    start?: bigint | undefined;
    data: Uint8Array;
}
export interface TerminalPong {
}
export interface TerminalExit {
    code?: number | undefined;
}
/**
 * TerminalDropNotice is the slow-client warning. It renders beside the
 * byte stream, so sequence accounting is untouched.
 */
export interface TerminalDropNotice {
}
/**
 * TerminalTitle carries one Pi session-title push. Revision is capped
 * server-side below 2^53, so it always fits a safe JS integer.
 */
export interface TerminalTitle {
    paneId?: string | undefined;
    sessionId?: string | undefined;
    title?: string | undefined;
    revision?: bigint | undefined;
}
/**
 * TerminalBridgeState is one Pi-bridge view push. Absent booleans differ
 * from false: the UI adopts a flipped value only when the key arrives.
 * Identifiers stay exact uint64 on the wire; the UI keeps decimal
 * strings, so adapters convert at the boundary.
 */
export interface TerminalBridgeState {
    state?: string | undefined;
    reason?: string | undefined;
    generation?: bigint | undefined;
    telemetryRevision?: bigint | undefined;
    lastRun?: bigint | undefined;
    lastOutcome?: string | undefined;
    running?: boolean | undefined;
    connected?: boolean | undefined;
    model?: string | undefined;
    capabilities: string[];
    paneId?: string | undefined;
    thinkingLevel?: string | undefined;
    contextTokens?: number | undefined;
    contextWindow?: number | undefined;
    contextPercent?: number | undefined;
    compactIdle?: boolean | undefined;
    compactQueued?: boolean | undefined;
    compactActive?: boolean | undefined;
    compactPending?: boolean | undefined;
    processId?: string | undefined;
    runId?: bigint | undefined;
    contextRevision?: bigint | undefined;
    reloadIdle?: boolean | undefined;
    reloadQueued?: boolean | undefined;
    reloadActive?: boolean | undefined;
    reloadCompactPending?: boolean | undefined;
    reloadPending?: boolean | undefined;
    reloadHighWater?: bigint | undefined;
}
/** TerminalSettlement reports one observed Pi run outcome. */
export interface TerminalSettlement {
    generation?: bigint | undefined;
    run?: bigint | undefined;
    outcome?: string | undefined;
    paneId?: string | undefined;
}
export declare const TerminalClientFrame: MessageFns<TerminalClientFrame>;
export declare const TerminalResize: MessageFns<TerminalResize>;
export declare const TerminalPing: MessageFns<TerminalPing>;
export declare const TerminalServerFrame: MessageFns<TerminalServerFrame>;
export declare const TerminalAttach: MessageFns<TerminalAttach>;
export declare const TerminalCheckpoint: MessageFns<TerminalCheckpoint>;
export declare const TerminalOutput: MessageFns<TerminalOutput>;
export declare const TerminalPong: MessageFns<TerminalPong>;
export declare const TerminalExit: MessageFns<TerminalExit>;
export declare const TerminalDropNotice: MessageFns<TerminalDropNotice>;
export declare const TerminalTitle: MessageFns<TerminalTitle>;
export declare const TerminalBridgeState: MessageFns<TerminalBridgeState>;
export declare const TerminalSettlement: MessageFns<TerminalSettlement>;
type Builtin = Date | Function | Uint8Array | string | number | boolean | bigint | undefined;
export type DeepPartial<T> = T extends bigint ? string | number | bigint : T extends Builtin ? T : T extends globalThis.Array<infer U> ? globalThis.Array<DeepPartial<U>> : T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>> : T extends {
    $case: string;
    value: unknown;
} ? {
    $case: T["$case"];
    value?: DeepPartial<T["value"]>;
} : T extends {} ? {
    [K in keyof T]?: DeepPartial<T[K]>;
} : Partial<T>;
type KeysOfUnion<T> = T extends T ? keyof T : never;
export type Exact<P, I extends P> = P extends Builtin ? P : P & {
    [K in keyof P]: Exact<P[K], I[K]>;
} & {
    [K in Exclude<keyof I, KeysOfUnion<P>>]: never;
};
export interface MessageFns<T> {
    encode(message: T, writer?: BinaryWriter): BinaryWriter;
    decode(input: BinaryReader | Uint8Array, length?: number): T;
    create<I extends Exact<DeepPartial<T>, I>>(base?: I): T;
    fromPartial<I extends Exact<DeepPartial<T>, I>>(object: I): T;
}
export {};
