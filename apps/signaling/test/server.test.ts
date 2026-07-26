import type { AddressInfo } from 'node:net';

import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from '@round/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createSignalingServer, type SignalingServer } from '../src/server.js';

const ORIGIN = 'http://localhost:5173';
const ROOM_ID = 'webrtc-study';

class TestClient {
  private readonly queuedMessages: ServerMessage[] = [];
  private readonly messageWaiters: Array<(message: ServerMessage) => void> = [];

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = parseServerMessage(JSON.parse(data.toString()));
      const waiter = this.messageWaiters.shift();
      if (waiter === undefined) {
        this.queuedMessages.push(message);
      } else {
        waiter(message);
      }
    });
  }

  static async connect(url: string, origin = ORIGIN, autoPong = true): Promise<TestClient> {
    const socket = new WebSocket(url, { origin, autoPong });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    return new TestClient(socket);
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  async nextMessage(): Promise<ServerMessage> {
    const queued = this.queuedMessages.shift();
    if (queued !== undefined) {
      return queued;
    }

    return await new Promise<ServerMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.messageWaiters.indexOf(onMessage);
        if (index >= 0) {
          this.messageWaiters.splice(index, 1);
        }
        reject(new Error('Timed out waiting for a signaling message'));
      }, 2_000);

      const onMessage = (message: ServerMessage): void => {
        clearTimeout(timeout);
        resolve(message);
      };
      this.messageWaiters.push(onMessage);
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.socket.once('close', resolve);
      this.socket.close(1000, 'Test finished');
    });
  }
}

describe('signaling server', () => {
  let server: SignalingServer;
  let signalUrl: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    server = createSignalingServer({
      host: '127.0.0.1',
      port: 0,
      allowedOrigins: [ORIGIN],
      maxRoomSize: 6,
      heartbeatIntervalMs: 25,
      logger: {
        info: () => undefined,
        error: () => undefined,
      },
    });
    const address = await server.start();
    signalUrl = `ws://127.0.0.1:${address.port}/signal`;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(async (client) => client.close()));
    await server.stop();
  });

  async function connect(): Promise<TestClient> {
    const client = await TestClient.connect(signalUrl);
    clients.push(client);
    return client;
  }

  it('reports health and only upgrades allowed origins on /signal', async () => {
    const address = server.httpServer.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });

    await expect(TestClient.connect(signalUrl, 'https://evil.example')).rejects.toThrow(
      /Unexpected server response: 403/,
    );
    await expect(TestClient.connect(`ws://127.0.0.1:${address.port}/elsewhere`)).rejects.toThrow(
      /Unexpected server response: 404/,
    );
  });

  it('joins three peers, relays with server-owned identity, leaves, and cleans the room', async () => {
    const ada = await connect();
    const grace = await connect();
    const linus = await connect();

    ada.send(joinMessage('Ada'));
    const adaJoined = expectType(await ada.nextMessage(), 'room.joined');
    expect(adaJoined.payload.participants).toEqual([]);

    grace.send(joinMessage('Grace'));
    const graceJoined = expectType(await grace.nextMessage(), 'room.joined');
    expect(graceJoined.payload.participants).toEqual([
      { peerId: adaJoined.payload.peerId, displayName: 'Ada' },
    ]);
    expect(expectType(await ada.nextMessage(), 'peer.joined').payload.participant).toEqual({
      peerId: graceJoined.payload.peerId,
      displayName: 'Grace',
    });

    linus.send(joinMessage('Linus'));
    const linusJoined = expectType(await linus.nextMessage(), 'room.joined');
    expect(linusJoined.payload.participants).toEqual([
      { peerId: adaJoined.payload.peerId, displayName: 'Ada' },
      { peerId: graceJoined.payload.peerId, displayName: 'Grace' },
    ]);
    expect(expectType(await ada.nextMessage(), 'peer.joined').payload.participant.peerId).toBe(
      linusJoined.payload.peerId,
    );
    expect(expectType(await grace.nextMessage(), 'peer.joined').payload.participant.peerId).toBe(
      linusJoined.payload.peerId,
    );
    expect(server.participantCount(ROOM_ID)).toBe(3);

    grace.send({
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: ROOM_ID,
      to: adaJoined.payload.peerId,
      payload: { description: { type: 'offer', sdp: 'v=0\r\ns=study' } },
    });
    const offer = expectType(await ada.nextMessage(), 'rtc.offer');
    expect(offer.from).toBe(graceJoined.payload.peerId);
    expect(offer.payload.description.sdp).toBe('v=0\r\ns=study');

    ada.send({
      v: PROTOCOL_VERSION,
      type: 'rtc.answer',
      roomId: ROOM_ID,
      to: graceJoined.payload.peerId,
      payload: { description: { type: 'answer', sdp: 'v=0\r\ns=answer' } },
    });
    const answer = expectType(await grace.nextMessage(), 'rtc.answer');
    expect(answer.from).toBe(adaJoined.payload.peerId);

    linus.send({
      v: PROTOCOL_VERSION,
      type: 'rtc.ice',
      roomId: ROOM_ID,
      to: adaJoined.payload.peerId,
      payload: {
        candidate: {
          candidate: 'candidate:1 1 UDP 1 192.0.2.1 5000 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      },
    });
    const ice = expectType(await ada.nextMessage(), 'rtc.ice');
    expect(ice.from).toBe(linusJoined.payload.peerId);
    expect(ice.payload.candidate?.sdpMLineIndex).toBe(0);

    grace.send({
      v: PROTOCOL_VERSION,
      type: 'room.leave',
      roomId: ROOM_ID,
    });
    expect(expectType(await ada.nextMessage(), 'peer.left').payload.peerId).toBe(
      graceJoined.payload.peerId,
    );
    expect(expectType(await linus.nextMessage(), 'peer.left').payload.peerId).toBe(
      graceJoined.payload.peerId,
    );

    await linus.close();
    expect(expectType(await ada.nextMessage(), 'peer.left').payload.peerId).toBe(
      linusJoined.payload.peerId,
    );
    await ada.close();

    await expect.poll(() => server.roomCount).toBe(0);
  });

  it('validates the sender room and relay target', async () => {
    const ada = await connect();
    const grace = await connect();

    ada.send(joinMessage('Ada'));
    const adaJoined = expectType(await ada.nextMessage(), 'room.joined');
    grace.send(joinMessage('Grace'));
    const graceJoined = expectType(await grace.nextMessage(), 'room.joined');
    await ada.nextMessage();

    grace.send({
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: 'another-room',
      to: adaJoined.payload.peerId,
      requestId: 'wrong-room',
      payload: { description: { type: 'offer' } },
    });
    const roomError = expectType(await grace.nextMessage(), 'error');
    expect(roomError.payload.code).toBe('ROOM_MISMATCH');
    expect(roomError.requestId).toBe('wrong-room');

    grace.send({
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: ROOM_ID,
      to: 'missing-peer',
      payload: { description: { type: 'offer' } },
    });
    expect(expectType(await grace.nextMessage(), 'error').payload.code).toBe('TARGET_NOT_FOUND');

    grace.sendRaw({
      v: PROTOCOL_VERSION,
      type: 'rtc.offer',
      roomId: ROOM_ID,
      from: adaJoined.payload.peerId,
      to: adaJoined.payload.peerId,
      payload: { description: { type: 'offer' } },
    });
    expect(expectType(await grace.nextMessage(), 'error').payload.code).toBe('INVALID_MESSAGE');

    expect(graceJoined.payload.peerId).not.toBe(adaJoined.payload.peerId);
  });

  it('enforces the six-participant room limit', async () => {
    for (let index = 0; index < 6; index += 1) {
      const client = await connect();
      client.send(joinMessage(`Peer ${index + 1}`));
      expectType(await client.nextMessage(), 'room.joined');
    }

    const seventh = await connect();
    seventh.send(joinMessage('Peer 7'));
    const error = expectType(await seventh.nextMessage(), 'error');

    expect(error.payload.code).toBe('ROOM_FULL');
    expect(server.participantCount(ROOM_ID)).toBe(6);
  });

  it('closes active peers and clears rooms during shutdown', async () => {
    const ada = await connect();
    ada.send(joinMessage('Ada'));
    await ada.nextMessage();

    await server.stop();

    await expect.poll(() => ada.socket.readyState).toBe(WebSocket.CLOSED);
    expect(server.roomCount).toBe(0);
  });

  it('rejects WebSocket messages larger than 64 KiB', async () => {
    const client = await connect();
    const closed = new Promise<number>((resolve) => {
      client.socket.once('close', resolve);
    });

    client.socket.send('x'.repeat(64 * 1024 + 1));

    await expect(closed).resolves.toBe(1009);
  });

  it('terminates an unresponsive peer and releases its room slot', async () => {
    const responsive = await connect();
    responsive.send(joinMessage('Responsive'));
    await responsive.nextMessage();

    const unresponsive = await TestClient.connect(signalUrl, ORIGIN, false);
    clients.push(unresponsive);
    unresponsive.send(joinMessage('Sleeping laptop'));
    const joined = expectType(await unresponsive.nextMessage(), 'room.joined');
    await responsive.nextMessage();

    const closed = new Promise<number>((resolve) => {
      unresponsive.socket.once('close', resolve);
    });

    await expect(closed).resolves.toBe(1006);
    expect(expectType(await responsive.nextMessage(), 'peer.left').payload.peerId).toBe(
      joined.payload.peerId,
    );
    await expect.poll(() => server.participantCount(ROOM_ID)).toBe(1);
  });
});

function joinMessage(displayName: string): ClientMessage {
  return {
    v: PROTOCOL_VERSION,
    type: 'room.join',
    roomId: ROOM_ID,
    payload: { displayName },
  };
}

function expectType<T extends ServerMessage['type']>(
  message: ServerMessage,
  type: T,
): Extract<ServerMessage, { type: T }> {
  expect(message.type).toBe(type);
  return message as Extract<ServerMessage, { type: T }>;
}
