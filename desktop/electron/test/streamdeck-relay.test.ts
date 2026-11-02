// @vitest-environment node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net, { type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StreamDeckRelay,
  type StreamDeckRelayRequest,
} from '../src/streamdeck-relay.js';

interface Descriptor {
  version: number;
  socketPath: string;
  instance: string;
  capability: string;
}

function makeRoot(): string {
  const base = process.platform === 'darwin' ? '/private/tmp' : tmpdir();
  return mkdtempSync(join(realpathSync(base), 'sd.'));
}

function descriptorFor(home: string): Descriptor {
  const value: unknown = JSON.parse(
    readFileSync(join(home, '.phi', 'streamdeck', 'relay.json'), 'utf8'),
  );
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('version' in value) ||
    typeof value.version !== 'number' ||
    !('socketPath' in value) ||
    typeof value.socketPath !== 'string' ||
    !('instance' in value) ||
    typeof value.instance !== 'string' ||
    !('capability' in value) ||
    typeof value.capability !== 'string'
  ) {
    throw new Error('invalid test relay descriptor');
  }
  return {
    version: value.version,
    socketPath: value.socketPath,
    instance: value.instance,
    capability: value.capability,
  };
}

class Frames {
  private input = Buffer.alloc(0);
  private readonly queue: unknown[] = [];
  private readonly waiters: Array<{
    resolve(value: unknown): void;
    reject(error: Error): void;
  }> = [];

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.input = Buffer.concat([this.input, chunk]);
      for (;;) {
        const newline = this.input.indexOf(0x0a);
        if (newline < 0) return;
        const line = this.input.subarray(0, newline);
        this.input = this.input.subarray(newline + 1);
        const value: unknown = JSON.parse(line.toString('utf8'));
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(value);
        else this.queue.push(value);
      }
    });
    socket.on('error', (error) => this.rejectWaiters(error));
    socket.on('close', () => this.rejectWaiters(new Error('socket closed')));
  }

  next(): Promise<unknown> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.socket.destroyed)
      return Promise.reject(new Error('socket closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('timed out waiting for a relay frame'));
      }, 2_000);
      const waiter = {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.waiters.push(waiter);
    });
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const onError = (error: Error): void => reject(error);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

function send(socket: Socket, value: unknown): void {
  socket.write(`${JSON.stringify(value)}\n`);
}

function authFrame(descriptor: Descriptor, capability = descriptor.capability) {
  return {
    v: descriptor.version,
    kind: 'auth',
    instance: descriptor.instance,
    capability,
  };
}

describe('StreamDeckRelay default-off and host gate', () => {
  it('has no filesystem side effects until explicitly started', () => {
    const root = makeRoot();
    const home = join(root, 'home');
    mkdirSync(home, { mode: 0o700 });
    const relay = new StreamDeckRelay({
      homeDir: home,
      primaryInstance: true,
      handleRequest: () => null,
    });
    expect(relay.isRunning).toBe(false);
    expect(lstatSync(home).isDirectory()).toBe(true);
    expect(() => lstatSync(join(home, '.phi'))).toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  it('refuses to start before the primary-instance lock without creating files', async () => {
    const root = makeRoot();
    const home = join(root, 'home');
    mkdirSync(home, { mode: 0o700 });
    const relay = new StreamDeckRelay({
      homeDir: home,
      primaryInstance: false,
      handleRequest: () => null,
    });
    await expect(relay.start()).rejects.toThrow(/primary Desktop instance/);
    expect(() => lstatSync(join(home, '.phi'))).toThrow();
    rmSync(root, { recursive: true, force: true });
  });
});

describe.skipIf(process.platform !== 'darwin')(
  'StreamDeckRelay Unix socket protocol',
  () => {
    let root: string;
    let home: string;
    let relay: StreamDeckRelay | null;

    beforeEach(() => {
      root = makeRoot();
      home = join(root, 'home');
      mkdirSync(home, { mode: 0o700 });
      chmodSync(home, 0o700);
      relay = null;
    });

    afterEach(async () => {
      await relay?.stop();
      rmSync(root, { recursive: true, force: true });
    });

    function makeRelay(
      handleRequest: (
        request: StreamDeckRelayRequest,
        context: { isCurrent(): boolean },
      ) => unknown | Promise<unknown> = (request) => ({ op: request.op }),
    ): StreamDeckRelay {
      relay = new StreamDeckRelay({
        homeDir: home,
        primaryInstance: true,
        handleRequest,
      });
      return relay;
    }

    async function authenticatedClient(
      target = relay,
    ): Promise<{ socket: Socket; frames: Frames; descriptor: Descriptor }> {
      if (!target) throw new Error('relay is not set up');
      await target.start();
      const descriptor = descriptorFor(home);
      const socket = await connect(descriptor.socketPath);
      const frames = new Frames(socket);
      send(socket, authFrame(descriptor));
      expect(await frames.next()).toEqual({ v: 1, kind: 'ready' });
      return { socket, frames, descriptor };
    }

    it('publishes private discovery only after listening and removes only its own endpoint', async () => {
      const target = makeRelay();
      await target.start();
      const directory = join(home, '.phi', 'streamdeck');
      const directoryStat = lstatSync(directory);
      const socketPath = join(directory, 'relay.sock');
      const socketStat = lstatSync(socketPath);
      const descriptorPath = join(directory, 'relay.json');
      const descriptorStat = lstatSync(descriptorPath);
      const descriptor = descriptorFor(home);

      expect(target.isRunning).toBe(true);
      expect(directoryStat.isDirectory()).toBe(true);
      expect(directoryStat.mode & 0o777).toBe(0o700);
      expect(directoryStat.uid).toBe(process.getuid?.());
      expect(socketStat.isSocket()).toBe(true);
      expect(socketStat.mode & 0o777).toBe(0o600);
      expect(socketStat.uid).toBe(process.getuid?.());
      expect(descriptorStat.isFile()).toBe(true);
      expect(descriptorStat.mode & 0o777).toBe(0o600);
      expect(descriptorStat.uid).toBe(process.getuid?.());
      expect(descriptor.socketPath).toBe(socketPath);
      expect(descriptor.capability).toMatch(/^[0-9a-f]{64}$/);

      await target.stop();
      expect(target.isRunning).toBe(false);
      expect(() => lstatSync(socketPath)).toThrow();
      expect(() => lstatSync(descriptorPath)).toThrow();
      expect(() => lstatSync(join(home, '.phi'))).toThrow();
    });

    it.each([false, true])(
      'recovers an owner-validated stale socket (descriptor present: %s)',
      async (withDescriptor) => {
        const phiDir = join(home, '.phi');
        const directory = join(phiDir, 'streamdeck');
        const socketPath = join(directory, 'relay.sock');
        mkdirSync(phiDir, { mode: 0o700 });
        mkdirSync(directory, { mode: 0o700 });
        chmodSync(phiDir, 0o700);
        chmodSync(directory, 0o700);

        const staleDescriptor: Descriptor = {
          version: 1,
          socketPath,
          instance: '0'.repeat(32),
          capability: '0'.repeat(64),
        };
        const child = spawn(
          process.execPath,
          [
            '-e',
            `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write('ready'))`,
          ],
          { stdio: ['ignore', 'pipe', 'inherit'] },
        );
        try {
          await new Promise<void>((resolve, reject) => {
            child.stdout?.once('data', () => resolve());
            child.once('error', reject);
            child.once('exit', (code, signal) =>
              reject(
                new Error(`stale-socket fixture exited: ${code ?? signal}`),
              ),
            );
          });
          chmodSync(socketPath, 0o600);
          expect(lstatSync(socketPath).isSocket()).toBe(true);
          if (withDescriptor) {
            const descriptorPath = join(directory, 'relay.json');
            writeFileSync(descriptorPath, JSON.stringify(staleDescriptor), {
              mode: 0o600,
            });
            chmodSync(descriptorPath, 0o600);
          }
          child.kill('SIGKILL');
          await once(child, 'exit');
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await once(child, 'exit');
          }
        }
        expect(lstatSync(socketPath).isSocket()).toBe(true);
        if (withDescriptor) {
          expect(descriptorFor(home).instance).toBe(staleDescriptor.instance);
        } else {
          expect(() => lstatSync(join(directory, 'relay.json'))).toThrow();
        }

        const target = makeRelay();
        await target.start();
        expect(target.isRunning).toBe(true);
        expect(lstatSync(socketPath).isSocket()).toBe(true);
        expect(lstatSync(join(directory, 'relay.json')).isFile()).toBe(true);
        if (withDescriptor) {
          const currentDescriptor = descriptorFor(home);
          expect(currentDescriptor.instance).not.toBe(staleDescriptor.instance);
          expect(currentDescriptor.capability).not.toBe(
            staleDescriptor.capability,
          );
        }
      },
    );

    it('leaves a live owner-validated socket without a descriptor untouched', async () => {
      const phiDir = join(home, '.phi');
      const directory = join(phiDir, 'streamdeck');
      const socketPath = join(directory, 'relay.sock');
      mkdirSync(phiDir, { mode: 0o700 });
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(phiDir, 0o700);
      chmodSync(directory, 0o700);

      const liveServer = net.createServer();
      const listening = once(liveServer, 'listening');
      liveServer.listen(socketPath);
      await listening;
      chmodSync(socketPath, 0o600);

      const target = makeRelay();
      await expect(target.start()).rejects.toThrow(/live or uncertain/);
      expect(lstatSync(socketPath).isSocket()).toBe(true);
      expect(() => lstatSync(join(directory, 'relay.json'))).toThrow();
      await new Promise<void>((resolve, reject) => {
        liveServer.close((error) => (error ? reject(error) : resolve()));
      });
    });

    it('authenticates and serves bounded requests plus the latest state snapshot', async () => {
      const handleRequest = vi.fn((request: StreamDeckRelayRequest) => ({
        op: request.op,
      }));
      const target = makeRelay(handleRequest);
      const { socket, frames } = await authenticatedClient(target);

      const request = Buffer.from(
        `${JSON.stringify({ v: 1, id: 'r1', op: 'getState' })}\n`,
      );
      socket.write(request.subarray(0, 7));
      socket.write(request.subarray(7));
      expect(await frames.next()).toEqual({
        v: 1,
        id: 'r1',
        ok: true,
        result: { op: 'getState' },
      });
      expect(handleRequest).toHaveBeenCalledTimes(1);
      expect(target.publishSnapshot({ activePane: 'pane-1' })).toBe(true);
      expect(await frames.next()).toEqual({
        v: 1,
        kind: 'state',
        state: { activePane: 'pane-1' },
      });
      socket.destroy();
    });

    it('rejects a wrong capability without invoking a request handler', async () => {
      const handleRequest = vi.fn(() => ({}));
      const target = makeRelay(handleRequest);
      await target.start();
      const descriptor = descriptorFor(home);
      const socket = await connect(descriptor.socketPath);
      const frames = new Frames(socket);
      const closed = once(socket, 'close');
      send(socket, authFrame(descriptor, '0'.repeat(64)));
      await closed;
      expect(handleRequest).not.toHaveBeenCalled();
      await frames.next().catch(() => undefined);
    });

    it('rejects invalid UTF-8 and partial frames over the request limit', async () => {
      const handleRequest = vi.fn(() => ({}));
      const target = makeRelay(handleRequest);
      const first = await authenticatedClient(target);
      const firstClosed = once(first.socket, 'close');
      first.socket.write(Buffer.from([0xff, 0x0a]));
      await firstClosed;
      expect(handleRequest).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(target.publishSnapshot({})).toBe(false));

      const second = await authenticatedClient(target);
      const secondClosed = once(second.socket, 'close');
      second.socket.write(Buffer.alloc(8 * 1024 + 1, 0x61));
      await secondClosed;
      expect(handleRequest).not.toHaveBeenCalled();
    });

    it('fails closed on oversized state instead of truncating the snapshot', async () => {
      const target = makeRelay();
      const client = await authenticatedClient(target);
      const closed = once(client.socket, 'close');
      expect(target.publishSnapshot({ pad: 'x'.repeat(128 * 1024) })).toBe(
        false,
      );
      await closed;
    });

    it('allows only one authenticated plugin connection', async () => {
      const target = makeRelay();
      const first = await authenticatedClient(target);
      const second = await connect(first.descriptor.socketPath);
      const frames = new Frames(second);
      const closed = once(second, 'close');
      send(second, authFrame(first.descriptor));
      await closed;
      expect(first.socket.destroyed).toBe(false);
      first.socket.destroy();
      await frames.next().catch(() => undefined);
    });

    it('rejects unknown fields before dispatch and admits no more than eight requests', async () => {
      const target = makeRelay();
      const first = await authenticatedClient(target);
      send(first.socket, { v: 1, id: 'bad', op: 'getState', extra: true });
      await once(first.socket, 'close');
      await target.stop();

      const releases: Array<(value: unknown) => void> = [];
      const handleRequest = vi.fn(
        () => new Promise<unknown>((resolve) => releases.push(resolve)),
      );
      const secondTarget = makeRelay(handleRequest);
      const second = await authenticatedClient(secondTarget);
      for (let i = 0; i < 9; i += 1) {
        send(second.socket, { v: 1, id: `r${i}`, op: 'getState' });
      }
      expect(await second.frames.next()).toEqual({
        v: 1,
        id: 'r8',
        ok: false,
        error: { code: 'BUSY', started: false },
      });
      expect(handleRequest).toHaveBeenCalledTimes(8);
      for (const release of releases) release({ accepted: true });
      for (let i = 0; i < 8; i += 1) await second.frames.next();
      second.socket.destroy();
    });

    it('does not let disconnected requests consume the replacement client limit', async () => {
      const releases: Array<(value: unknown) => void> = [];
      const target = makeRelay((request) =>
        request.id.startsWith('old-')
          ? new Promise<unknown>((resolve) => releases.push(resolve))
          : { accepted: true },
      );
      const first = await authenticatedClient(target);
      for (let i = 0; i < 8; i += 1) {
        send(first.socket, { v: 1, id: `old-${i}`, op: 'getState' });
      }
      await vi.waitFor(() => expect(releases).toHaveLength(8));
      first.socket.destroy();
      await once(first.socket, 'close');

      const second = await authenticatedClient(target);
      send(second.socket, { v: 1, id: 'new-request', op: 'getState' });
      expect(await second.frames.next()).toEqual({
        v: 1,
        id: 'new-request',
        ok: true,
        result: { accepted: true },
      });
      expect(releases).toHaveLength(8);
      for (const release of releases) release({ accepted: false });
      second.socket.destroy();
    });

    it('invalidates asynchronous results when the authenticated client disconnects', async () => {
      let resolveContext!: (value: { isCurrent(): boolean }) => void;
      let release!: (value: unknown) => void;
      const contextPromise = new Promise<{ isCurrent(): boolean }>(
        (resolve) => (resolveContext = resolve),
      );
      const pending = new Promise<unknown>((resolve) => (release = resolve));
      const target = makeRelay((_request, current) => {
        resolveContext(current);
        return pending;
      });
      const client = await authenticatedClient(target);
      send(client.socket, { v: 1, id: 'r1', op: 'getState' });
      const context = await contextPromise;
      expect(context.isCurrent()).toBe(true);
      client.socket.destroy();
      await once(client.socket, 'close');
      await vi.waitFor(() => expect(context.isCurrent()).toBe(false));
      release({ accepted: false });
    });

    it('rejects an insecure symlinked .phi path without touching its target', async () => {
      const outside = join(root, 'outside');
      mkdirSync(outside, { mode: 0o700 });
      symlinkSync(outside, join(home, '.phi'));
      const target = makeRelay();
      await expect(target.start()).rejects.toThrow(/unsafe type or owner/);
      expect(() => lstatSync(join(outside, 'streamdeck'))).toThrow();
    });

    it('rotates the capability on each enable cycle', async () => {
      const target = makeRelay();
      await target.start();
      const first = descriptorFor(home);
      await target.stop();
      await target.start();
      const second = descriptorFor(home);
      expect(second.instance).not.toBe(first.instance);
      expect(second.capability).not.toBe(first.capability);
    });
  },
);
