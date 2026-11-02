import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import net, { type Server, type Socket } from 'node:net';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const PROTOCOL_VERSION = 1;
const MAX_SOCKET_PATH_BYTES = 100;
const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024;
const MAX_QUEUED_BYTES = 256 * 1024;
const MAX_ID_BYTES = 128;
const MAX_PENDING_REQUESTS = 8;
const MAX_HANDSHAKES = 2;
const AUTH_TIMEOUT_MS = 2_000;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export type StreamDeckRelayRequest =
  | { id: string; op: 'getState' }
  | { id: string; op: 'bindCurrent' }
  | {
      id: string;
      op: 'selectTab';
      epoch: string;
      profileId: string;
      paneId: string;
    }
  | {
      id: string;
      op: 'stepThinking';
      epoch: string;
      paneId: string;
      steps: number;
    };

export interface StreamDeckRelayRequestContext {
  /** Invalidated on client disconnect, replacement, disable, or restart. */
  isCurrent(): boolean;
}

export interface StreamDeckRelayOptions {
  /** Canonical user home; the relay uses only `$HOME/.phi/streamdeck`. */
  homeDir: string;
  /** Set only after Electron's existing primary-instance lock succeeds. */
  primaryInstance: boolean;
  handleRequest(
    request: StreamDeckRelayRequest,
    context: StreamDeckRelayRequestContext,
  ): unknown | Promise<unknown>;
}

interface EndpointDescriptor {
  version: number;
  socketPath: string;
  instance: string;
  capability: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  kind: 'directory' | 'file' | 'socket';
}

interface RelayClient {
  socket: Socket;
  input: Buffer;
  handshakeTimer: NodeJS.Timeout | null;
  handshaking: boolean;
  authenticated: boolean;
  epoch: number;
  pendingIds: Set<string>;
  pendingSnapshot: string | null;
}

function errnoIs(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function statOrNull(filePath: string): Stats | null {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return null;
    throw error;
  }
}

function identityOf(stat: Stats): FileIdentity {
  let kind: FileIdentity['kind'];
  if (stat.isDirectory()) kind = 'directory';
  else if (stat.isFile()) kind = 'file';
  else if (stat.isSocket()) kind = 'socket';
  else throw new Error('unsupported relay path type');
  return {
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    mode: stat.mode & 0o777,
    kind,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.kind === right.kind
  );
}

function checkOwnerAndMode(
  stat: Stats,
  kind: FileIdentity['kind'],
  uid: number,
  mode: number,
  label: string,
): FileIdentity {
  const identity = identityOf(stat);
  if (
    identity.kind !== kind ||
    identity.uid !== uid ||
    identity.mode !== mode
  ) {
    throw new Error(`${label} has unsafe type, owner, or mode`);
  }
  return identity;
}

function isWellFormedUnicode(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function boundedString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    isWellFormedUnicode(value) &&
    Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactFields(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === required.length &&
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key))
  );
}

function parseRequest(value: unknown): StreamDeckRelayRequest | null {
  if (
    !record(value) ||
    value.v !== PROTOCOL_VERSION ||
    !boundedString(value.id)
  ) {
    return null;
  }
  switch (value.op) {
    case 'getState':
    case 'bindCurrent':
      return exactFields(value, ['v', 'id', 'op'])
        ? { id: value.id, op: value.op }
        : null;
    case 'selectTab':
      return exactFields(value, [
        'v',
        'id',
        'op',
        'epoch',
        'profileId',
        'paneId',
      ]) &&
        boundedString(value.epoch) &&
        boundedString(value.profileId) &&
        boundedString(value.paneId)
        ? {
            id: value.id,
            op: value.op,
            epoch: value.epoch,
            profileId: value.profileId,
            paneId: value.paneId,
          }
        : null;
    case 'stepThinking':
      return exactFields(value, [
        'v',
        'id',
        'op',
        'epoch',
        'paneId',
        'steps',
      ]) &&
        boundedString(value.epoch) &&
        boundedString(value.paneId) &&
        typeof value.steps === 'number' &&
        Number.isSafeInteger(value.steps)
        ? {
            id: value.id,
            op: value.op,
            epoch: value.epoch,
            paneId: value.paneId,
            steps: value.steps,
          }
        : null;
    default:
      return null;
  }
}

function closeServer(server: Server | null): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Default-off, same-user Unix-socket relay transport. Constructing this class
 * has no filesystem or listener side effects; Desktop starts it only after the
 * persisted preference is enabled and the primary-instance lock is held.
 */
export class StreamDeckRelay {
  private readonly options: StreamDeckRelayOptions;
  private transition: Promise<void> = Promise.resolve();
  private state: 'stopped' | 'starting' | 'running' | 'stopping' = 'stopped';
  private server: Server | null = null;
  private readonly clients = new Set<RelayClient>();
  private authenticatedClient: RelayClient | null = null;
  private handshakes = 0;
  private epoch = 0;
  private descriptor: EndpointDescriptor | null = null;
  private socketPath = '';
  private descriptorPath = '';
  private ownedSocket: FileIdentity | null = null;
  private ownedDescriptor: FileIdentity | null = null;
  private readonly ownedDirectories: Array<{ path: string; id: FileIdentity }> =
    [];

  constructor(options: StreamDeckRelayOptions) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this.state === 'running';
  }

  start(): Promise<void> {
    return this.enqueue(() => this.startInternal());
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.stopInternal());
  }

  /** Send only the newest state while the plugin is backpressured. */
  publishSnapshot(snapshot: unknown): boolean {
    const client = this.authenticatedClient;
    if (!client || !this.isCurrentClient(client)) return false;
    let frame: string;
    try {
      const encoded = JSON.stringify(snapshot);
      if (
        encoded === undefined ||
        Buffer.byteLength(encoded, 'utf8') > MAX_SNAPSHOT_BYTES
      ) {
        client.socket.destroy();
        return false;
      }
      frame = `{"v":${PROTOCOL_VERSION},"kind":"state","state":${encoded}}\n`;
    } catch {
      client.socket.destroy();
      return false;
    }
    if (client.socket.writableNeedDrain || client.pendingSnapshot !== null) {
      if (
        client.socket.writableLength + Buffer.byteLength(frame, 'utf8') >
        MAX_QUEUED_BYTES
      ) {
        client.socket.destroy();
        return false;
      }
      client.pendingSnapshot = frame;
      return true;
    }
    return this.writeFrame(client, frame);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.transition.then(operation, operation);
    this.transition = result.catch(() => {});
    return result;
  }

  private async startInternal(): Promise<void> {
    if (this.state === 'running') return;
    if (this.state !== 'stopped')
      throw new Error('relay transition in progress');
    if (this.options.primaryInstance !== true) {
      throw new Error('relay requires the primary Desktop instance');
    }
    if (process.platform !== 'darwin') {
      throw new Error('Stream Deck relay currently supports macOS only');
    }
    const uid = process.getuid?.();
    if (uid === undefined)
      throw new Error('relay requires a Unix user identity');
    this.state = 'starting';
    try {
      const home = path.resolve(this.options.homeDir);
      if (realpathSync(home) !== home)
        throw new Error('home path is not canonical');
      const homeStat = lstatSync(home);
      if (
        homeStat.isSymbolicLink() ||
        !homeStat.isDirectory() ||
        homeStat.uid !== uid
      ) {
        throw new Error('home directory has unsafe type or owner');
      }
      const phiDir = path.join(home, '.phi');
      this.ensureDirectory(phiDir, uid, null);
      const relayDir = path.join(phiDir, 'streamdeck');
      this.ensureDirectory(relayDir, uid, DIRECTORY_MODE);
      this.socketPath = path.join(relayDir, 'relay.sock');
      this.descriptorPath = path.join(relayDir, 'relay.json');
      if (
        !path.isAbsolute(this.socketPath) ||
        Buffer.byteLength(this.socketPath, 'utf8') > MAX_SOCKET_PATH_BYTES
      ) {
        throw new Error('relay socket path exceeds the supported byte limit');
      }
      await this.removeStaleEndpoint(uid);

      const descriptor: EndpointDescriptor = {
        version: PROTOCOL_VERSION,
        socketPath: this.socketPath,
        instance: randomBytes(16).toString('hex'),
        capability: randomBytes(32).toString('hex'),
      };
      this.descriptor = descriptor;
      const server = net.createServer((socket) => this.accept(socket));
      this.server = server;
      server.on('error', () => {
        if (this.state === 'running') void this.stop().catch(() => {});
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => reject(error);
        server.once('error', onError);
        server.listen(this.socketPath, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
      const socketStat = lstatSync(this.socketPath);
      const createdSocket = identityOf(socketStat);
      if (createdSocket.kind !== 'socket' || createdSocket.uid !== uid) {
        throw new Error('relay socket has unsafe type or owner');
      }
      this.ownedSocket = createdSocket;
      chmodSync(this.socketPath, FILE_MODE);
      const securedSocket = checkOwnerAndMode(
        lstatSync(this.socketPath),
        'socket',
        uid,
        FILE_MODE,
        'relay socket',
      );
      if (
        securedSocket.dev !== createdSocket.dev ||
        securedSocket.ino !== createdSocket.ino
      ) {
        throw new Error('relay socket changed during permission setup');
      }
      this.ownedSocket = securedSocket;
      this.state = 'running';
      this.publishDescriptor(descriptor, uid);
    } catch (error) {
      await this.stopInternal();
      throw error;
    }
  }

  private ensureDirectory(
    directory: string,
    uid: number,
    exactMode: number | null,
  ): void {
    let created = false;
    try {
      mkdirSync(directory, { mode: DIRECTORY_MODE });
      created = true;
    } catch (error) {
      if (!errnoIs(error, 'EEXIST')) throw error;
    }
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid) {
      throw new Error('relay directory has unsafe type or owner');
    }
    const identity = identityOf(stat);
    if (created) this.ownedDirectories.push({ path: directory, id: identity });
    if (created) chmodSync(directory, exactMode ?? DIRECTORY_MODE);
    const checked = lstatSync(directory);
    if (
      checked.dev !== identity.dev ||
      checked.ino !== identity.ino ||
      checked.uid !== uid
    ) {
      throw new Error('relay directory changed during permission setup');
    }
    const mode = checked.mode & 0o777;
    if (
      (exactMode !== null && mode !== exactMode) ||
      (exactMode === null && (mode & 0o022) !== 0)
    ) {
      throw new Error('relay directory has unsafe permissions');
    }
    if (created) {
      const owned = this.ownedDirectories.at(-1);
      if (owned?.path === directory) owned.id = identityOf(checked);
    }
  }

  private async removeStaleEndpoint(uid: number): Promise<void> {
    const descriptorStat = statOrNull(this.descriptorPath);
    const socketStat = statOrNull(this.socketPath);
    if (!descriptorStat && !socketStat) return;
    if (!descriptorStat && socketStat) {
      const socketId = checkOwnerAndMode(
        socketStat,
        'socket',
        uid,
        FILE_MODE,
        'existing relay socket',
      );
      const probe = await this.probeSocket(this.socketPath);
      const latestSocket = statOrNull(this.socketPath);
      if (
        !latestSocket ||
        !sameIdentity(socketId, identityOf(latestSocket)) ||
        probe !== 'refused'
      ) {
        throw new Error(
          'existing relay endpoint is live or uncertain; leaving it untouched',
        );
      }
      unlinkSync(this.socketPath);
      return;
    }
    if (!descriptorStat || !socketStat) {
      throw new Error(
        'uncertain existing relay endpoint; leaving it untouched',
      );
    }
    const descriptorId = checkOwnerAndMode(
      descriptorStat,
      'file',
      uid,
      FILE_MODE,
      'existing relay descriptor',
    );
    if (descriptorStat.size > 4096)
      throw new Error('existing relay descriptor is oversized');
    const socketId = checkOwnerAndMode(
      socketStat,
      'socket',
      uid,
      FILE_MODE,
      'existing relay socket',
    );
    const previous = this.parseDescriptor(
      readFileSync(this.descriptorPath, 'utf8'),
    );
    if (previous.socketPath !== this.socketPath) {
      throw new Error(
        'existing relay descriptor points to an unexpected socket',
      );
    }
    const probe = await this.probeSocket(this.socketPath);
    const latestDescriptor = statOrNull(this.descriptorPath);
    const latestSocket = statOrNull(this.socketPath);
    if (
      !latestDescriptor ||
      !latestSocket ||
      !sameIdentity(descriptorId, identityOf(latestDescriptor)) ||
      !sameIdentity(socketId, identityOf(latestSocket))
    ) {
      throw new Error('relay endpoint changed during stale check');
    }
    if (probe !== 'refused') {
      throw new Error(
        'existing relay endpoint is live or uncertain; leaving it untouched',
      );
    }
    // Remove discovery first so a crash during cleanup leaves the
    // recoverable socket-only shape, not an ambiguous descriptor-only one.
    unlinkSync(this.descriptorPath);
    unlinkSync(this.socketPath);
  }

  private parseDescriptor(contents: string): EndpointDescriptor {
    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch {
      throw new Error('existing relay descriptor is malformed');
    }
    if (
      !record(value) ||
      !exactFields(value, [
        'version',
        'socketPath',
        'instance',
        'capability',
      ]) ||
      value.version !== PROTOCOL_VERSION ||
      value.socketPath !== this.socketPath ||
      typeof value.instance !== 'string' ||
      !/^[0-9a-f]{32}$/.test(value.instance) ||
      typeof value.capability !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.capability)
    ) {
      throw new Error('existing relay descriptor is invalid');
    }
    return {
      version: value.version,
      socketPath: value.socketPath,
      instance: value.instance,
      capability: value.capability,
    };
  }

  private probeSocket(
    socketPath: string,
  ): Promise<'live' | 'refused' | 'uncertain'> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ path: socketPath });
      let settled = false;
      const finish = (result: 'live' | 'refused' | 'uncertain'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => finish('uncertain'), 250);
      socket.once('connect', () => finish('live'));
      socket.once('error', (error: NodeJS.ErrnoException) =>
        finish(error.code === 'ECONNREFUSED' ? 'refused' : 'uncertain'),
      );
    });
  }

  private publishDescriptor(descriptor: EndpointDescriptor, uid: number): void {
    const tempPath = `${this.descriptorPath}.tmp-${descriptor.instance}`;
    let fd: number | null = null;
    let tempId: FileIdentity | null = null;
    try {
      fd = openSync(tempPath, 'wx', FILE_MODE);
      writeFileSync(fd, `${JSON.stringify(descriptor)}\n`, 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      chmodSync(tempPath, FILE_MODE);
      tempId = checkOwnerAndMode(
        lstatSync(tempPath),
        'file',
        uid,
        FILE_MODE,
        'temporary relay descriptor',
      );
      linkSync(tempPath, this.descriptorPath);
      this.ownedDescriptor = checkOwnerAndMode(
        lstatSync(this.descriptorPath),
        'file',
        uid,
        FILE_MODE,
        'relay descriptor',
      );
    } finally {
      if (fd !== null) closeSync(fd);
      if (tempId) this.unlinkIfOwned(tempPath, tempId);
    }
  }

  private accept(socket: Socket): void {
    if (this.state !== 'running' || this.handshakes >= MAX_HANDSHAKES) {
      socket.destroy();
      return;
    }
    const client: RelayClient = {
      socket,
      input: Buffer.alloc(0),
      handshakeTimer: null,
      handshaking: true,
      authenticated: false,
      epoch: 0,
      pendingIds: new Set(),
      pendingSnapshot: null,
    };
    this.clients.add(client);
    this.handshakes += 1;
    client.handshakeTimer = setTimeout(() => socket.destroy(), AUTH_TIMEOUT_MS);
    socket.setNoDelay(true);
    socket.on('data', (chunk: Buffer) => this.readData(client, chunk));
    socket.on('drain', () => this.flushSnapshot(client));
    socket.on('error', () => {});
    socket.on('close', () => this.clientClosed(client));
  }

  private readData(client: RelayClient, chunk: Buffer): void {
    if (client.socket.destroyed) return;
    if (chunk.byteLength > MAX_REQUEST_BYTES * (MAX_PENDING_REQUESTS + 1)) {
      client.socket.destroy();
      return;
    }
    client.input = Buffer.concat([client.input, chunk]);
    for (;;) {
      const newline = client.input.indexOf(0x0a);
      if (newline < 0) {
        if (client.input.byteLength > MAX_REQUEST_BYTES)
          client.socket.destroy();
        return;
      }
      if (newline + 1 > MAX_REQUEST_BYTES) {
        client.socket.destroy();
        return;
      }
      const line = client.input.subarray(0, newline);
      client.input = client.input.subarray(newline + 1);
      if (line.byteLength === 0 || !this.handleLine(client, line)) return;
    }
  }

  private handleLine(client: RelayClient, line: Buffer): boolean {
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(line),
      );
    } catch {
      client.socket.destroy();
      return false;
    }
    if (!client.authenticated) return this.authenticate(client, value);
    const request = parseRequest(value);
    if (!request || !this.isCurrentClient(client)) {
      client.socket.destroy();
      return false;
    }
    if (client.pendingIds.has(request.id)) {
      client.socket.destroy();
      return false;
    }
    if (client.pendingIds.size >= MAX_PENDING_REQUESTS) {
      this.writeFrame(
        client,
        `${JSON.stringify({
          v: PROTOCOL_VERSION,
          id: request.id,
          ok: false,
          error: { code: 'BUSY', started: false },
        })}\n`,
      );
      return !client.socket.destroyed;
    }
    this.dispatch(client, request);
    return true;
  }

  private authenticate(client: RelayClient, value: unknown): boolean {
    const descriptor = this.descriptor;
    if (
      !descriptor ||
      !record(value) ||
      !exactFields(value, ['v', 'kind', 'instance', 'capability']) ||
      value.v !== PROTOCOL_VERSION ||
      value.kind !== 'auth' ||
      value.instance !== descriptor.instance ||
      typeof value.capability !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.capability)
    ) {
      client.socket.destroy();
      return false;
    }
    const provided = Buffer.from(value.capability, 'hex');
    const expected = Buffer.from(descriptor.capability, 'hex');
    if (!timingSafeEqual(provided, expected) || this.authenticatedClient) {
      client.socket.destroy();
      return false;
    }
    if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
    client.handshakeTimer = null;
    client.handshaking = false;
    this.handshakes -= 1;
    client.authenticated = true;
    client.epoch = ++this.epoch;
    this.authenticatedClient = client;
    this.writeFrame(
      client,
      `${JSON.stringify({ v: PROTOCOL_VERSION, kind: 'ready' })}\n`,
    );
    return !client.socket.destroyed;
  }

  private dispatch(client: RelayClient, request: StreamDeckRelayRequest): void {
    client.pendingIds.add(request.id);
    const connectionEpoch = client.epoch;
    const context: StreamDeckRelayRequestContext = {
      isCurrent: () =>
        this.state === 'running' &&
        this.epoch === connectionEpoch &&
        this.authenticatedClient === client &&
        !client.socket.destroyed,
    };
    void Promise.resolve()
      .then(() => this.options.handleRequest(request, context))
      .then((result) => {
        if (!context.isCurrent()) return;
        const encoded = JSON.stringify(result);
        if (
          encoded === undefined ||
          Buffer.byteLength(encoded, 'utf8') > MAX_SNAPSHOT_BYTES
        ) {
          client.socket.destroy();
          return;
        }
        const frame = `{"v":${PROTOCOL_VERSION},"id":${JSON.stringify(request.id)},"ok":true,"result":${encoded}}\n`;
        this.writeFrame(client, frame);
      })
      .catch(() => {
        if (!context.isCurrent()) return;
        this.writeFrame(
          client,
          `${JSON.stringify({
            v: PROTOCOL_VERSION,
            id: request.id,
            ok: false,
            error: { code: 'UNAVAILABLE' },
          })}\n`,
        );
      })
      .finally(() => {
        client.pendingIds.delete(request.id);
      });
  }

  private writeFrame(client: RelayClient, frame: string): boolean {
    if (!this.isCurrentClient(client)) return false;
    const bytes = Buffer.byteLength(frame, 'utf8');
    const pendingBytes = client.pendingSnapshot
      ? Buffer.byteLength(client.pendingSnapshot, 'utf8')
      : 0;
    if (
      bytes > MAX_SNAPSHOT_BYTES ||
      client.socket.writableLength + pendingBytes + bytes > MAX_QUEUED_BYTES
    ) {
      client.socket.destroy();
      return false;
    }
    client.socket.write(frame);
    return true;
  }

  private flushSnapshot(client: RelayClient): void {
    if (!this.isCurrentClient(client) || !client.pendingSnapshot) return;
    const latest = client.pendingSnapshot;
    client.pendingSnapshot = null;
    this.writeFrame(client, latest);
  }

  private isCurrentClient(client: RelayClient): boolean {
    return (
      this.state === 'running' &&
      client.authenticated &&
      this.authenticatedClient === client &&
      client.epoch === this.epoch &&
      !client.socket.destroyed
    );
  }

  private clientClosed(client: RelayClient): void {
    if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
    if (client.handshaking) {
      client.handshaking = false;
      this.handshakes = Math.max(0, this.handshakes - 1);
    }
    if (this.authenticatedClient === client) {
      this.authenticatedClient = null;
      this.epoch += 1;
    }
    this.clients.delete(client);
  }

  private async stopInternal(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopping';
    this.epoch += 1;
    for (const client of this.clients) client.socket.destroy();
    this.authenticatedClient = null;
    const server = this.server;
    await closeServer(server);
    this.server = null;
    this.handshakes = 0;
    this.clients.clear();
    const socketPath = this.socketPath;
    const descriptorPath = this.descriptorPath;
    if (descriptorPath && this.ownedDescriptor) {
      this.unlinkIfOwned(descriptorPath, this.ownedDescriptor);
    }
    if (socketPath && this.ownedSocket)
      this.unlinkIfOwned(socketPath, this.ownedSocket);
    this.ownedDescriptor = null;
    this.ownedSocket = null;
    this.descriptor = null;
    this.removeCreatedDirectories();
    this.socketPath = '';
    this.descriptorPath = '';
    this.state = 'stopped';
  }

  private unlinkIfOwned(filePath: string, expected: FileIdentity): void {
    try {
      const current = lstatSync(filePath);
      if (sameIdentity(expected, identityOf(current))) unlinkSync(filePath);
    } catch {
      // Leave a missing or replaced path untouched.
    }
  }

  private removeCreatedDirectories(): void {
    for (const entry of this.ownedDirectories.splice(0).reverse()) {
      try {
        const current = lstatSync(entry.path);
        if (
          sameIdentity(entry.id, identityOf(current)) &&
          current.isDirectory()
        ) {
          rmdirSync(entry.path);
        }
      } catch {
        // A replaced or nonempty directory is not ours to remove.
      }
    }
  }
}
