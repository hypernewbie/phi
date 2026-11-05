import { TerminalServerFrame } from '../web/proto/terminal.js';
import type {
    MessageFns,
    TerminalServerFrame as ServerMessage,
} from '../web-src/proto/terminal.js';

const ServerCodec = TerminalServerFrame as unknown as MessageFns<ServerMessage>;

// For unauthenticated, isolated live fixtures. Discover the baseline through
// the same v3 attach as a client; never inspect journal files or guess an epoch.
export async function terminalHead(url: string, pane: string) {
    const socket = new WebSocket(
        `${url.replace(/^http/, 'ws')}/ws/pane/${encodeURIComponent(pane)}`,
        'phi.terminal.protobuf.v3',
    );
    socket.binaryType = 'arraybuffer';
    let timer: ReturnType<typeof setTimeout>;
    try {
        return await new Promise<{
            epoch: number;
            oldest: number;
            head: number;
            floorEventCursor: string;
            eventCursor: string;
        }>((resolve, reject) => {
            timer = setTimeout(
                () => reject(new Error('terminal attach timed out')),
                10_000,
            );
            socket.addEventListener('error', () =>
                reject(new Error('terminal attach failed')),
            );
            socket.addEventListener('message', ({ data }) => {
                const frame = ServerCodec.decode(
                    new Uint8Array(data as ArrayBuffer),
                );
                if (frame.payload?.$case !== 'attach') return;
                const attach = frame.payload.value;
                if (!attach.eventCursor || !attach.floorEventCursor) {
                    reject(new Error('terminal attach has no v3 window'));
                    return;
                }
                resolve({
                    epoch: Number(attach.epoch),
                    oldest: Number(attach.oldest),
                    head: Number(attach.head),
                    floorEventCursor: attach.floorEventCursor,
                    eventCursor: attach.eventCursor,
                });
            });
        });
    } finally {
        clearTimeout(timer!);
        socket.close();
    }
}

// Read one finite snapshot, including marker-only pages. Test callers can
// inspect bytes or text without accidentally decoding the envelope as output.
export async function readReplay(url: string, pane: string) {
    const fence = await terminalHead(url, pane);
    const chunks: Buffer[] = [];
    let from = fence.oldest;
    let after = fence.floorEventCursor;
    for (;;) {
        const params = new URLSearchParams({
            epoch: String(fence.epoch),
            from: String(from),
            through: String(fence.head),
            through_event_cursor: fence.eventCursor,
        });
        if (after) params.set('after_event_cursor', after);
        const response = await fetch(
            `${url}/api/terminals/${encodeURIComponent(pane)}/replay?${params}`,
            {
                signal: AbortSignal.timeout(30_000),
            },
        );
        if (!response.ok) throw new Error(`replay failed: ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer());
        const size = body.readUInt32BE(0);
        const header = JSON.parse(
            body.subarray(4, 4 + size).toString('utf8'),
        ) as {
            epoch: number;
            start: number;
            end: number;
            event_cursor: string;
        };
        const data = body.subarray(4 + size);
        if (
            header.epoch !== fence.epoch ||
            header.start !== from ||
            data.length !== header.end - from
        )
            throw new Error('invalid replay span');
        chunks.push(data);
        if (
            header.end === fence.head &&
            header.event_cursor === fence.eventCursor
        )
            return { ...fence, data: Buffer.concat(chunks) };
        if (header.end === from && header.event_cursor === after)
            throw new Error('replay made no progress');
        from = header.end;
        after = header.event_cursor;
    }
}

// Small protocol fixtures use an empty resize timeline. Bytes still have a
// certified baseline and finite cursor, just like a real v2 response.
export function replayAttach(
    epoch: number,
    head: number,
    cols = 80,
    rows = 24,
) {
    return {
        epoch: BigInt(epoch),
        oldest: 0n,
        head: BigInt(head),
        initialCols: cols,
        initialRows: rows,
        eventCursor: `v1.${epoch}.${head}.0`,
    };
}

// v3 attach after eviction: the certified window starts at `floor`, and the
// geometry at that floor can differ from the head geometry. A client must
// adopt the head geometry and treat bytes below `floor` as lost.
export function replayAttachWithFloor(
    epoch: number,
    floor: number,
    head: number,
    headCols = 80,
    headRows = 24,
    floorCols = headCols,
    floorRows = headRows,
) {
    return {
        ...replayAttach(epoch, head, headCols, headRows),
        oldest: BigInt(floor),
        floorCols,
        floorRows,
        headCols,
        headRows,
        floorEventCursor: `v1.${epoch}.${floor}.0`,
    };
}

export function replayEnvelope(
    data: Buffer,
    epoch = 1,
    cols = 80,
    rows = 24,
    start = 0,
    through = start + data.length,
) {
    const end = start + data.length;
    const header = Buffer.from(
        JSON.stringify({
            epoch,
            start,
            end,
            through,
            resizes: [],
            event_cursor: `v1.${epoch}.${end}.0`,
            through_event_cursor: `v1.${epoch}.${through}.0`,
            initial_cols: cols,
            initial_rows: rows,
        }),
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    return Buffer.concat([length, header, data]);
}
