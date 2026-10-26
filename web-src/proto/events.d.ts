import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
export declare const protobufPackage = "phi.websocket.events.v1";
export declare const protobufFileName = "events.proto";
/**
 * Notification is the listen-only events endpoint's whole message. One
 * WebSocket binary message on /ws/md-events carries one Notification.
 * Pane clients receive the same message wrapped in
 * TerminalServerFrame.notification, so both endpoints share the payload
 * type without sharing an envelope.
 */
export interface Notification {
    kind: {
        $case: "markdownChanged";
        value: MarkdownChanged;
    } | {
        $case: "syncChanged";
        value: SyncChanged;
    } | {
        $case: "shutdown";
        value: ServerShutdown;
    } | undefined;
}
/**
 * MarkdownChanged fires when a watched markdown directory changes on
 * disk. An absent or empty dir refreshes anyway (one cheap fetch).
 */
export interface MarkdownChanged {
    dir?: string | undefined;
}
/**
 * SyncChanged fires when a sync-board message is upserted or deleted.
 * Action keeps the existing "upsert"/"delete" values. The embedded
 * message preserves key, value, and millisecond timestamps; deletes
 * carry no message.
 */
export interface SyncChanged {
    action?: string | undefined;
    key?: string | undefined;
    msg: SyncMessageState | undefined;
}
export interface SyncMessageState {
    key?: string | undefined;
    value?: string | undefined;
    createdAtUnixMs?: bigint | undefined;
    updatedAtUnixMs?: bigint | undefined;
}
/**
 * ServerShutdown announces restart/update/shutdown. An absent or empty
 * reason means a plain shutdown.
 */
export interface ServerShutdown {
    reason?: string | undefined;
}
export declare const Notification: MessageFns<Notification>;
export declare const MarkdownChanged: MessageFns<MarkdownChanged>;
export declare const SyncChanged: MessageFns<SyncChanged>;
export declare const SyncMessageState: MessageFns<SyncMessageState>;
export declare const ServerShutdown: MessageFns<ServerShutdown>;
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
