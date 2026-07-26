import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  PROTOCOL_VERSION,
  ProtocolValidationError,
  parseClientMessage,
  type ClientMessage,
  type ErrorServerMessage,
  type Participant,
  type ServerMessage,
  type SignalingErrorCode,
} from '@round/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import {
  DEFAULT_ALLOWED_ORIGINS,
  DEFAULT_HOST,
  DEFAULT_MAX_ROOM_SIZE,
  DEFAULT_PORT,
  type SignalingConfig,
} from './config.js';

const MAX_WEBSOCKET_PAYLOAD_BYTES = 64 * 1024;
const SHUTDOWN_GRACE_PERIOD_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

export interface SignalingServerOptions extends Partial<SignalingConfig> {
  logger?: Pick<Console, 'info' | 'error'>;
  heartbeatIntervalMs?: number;
}

export interface StartedSignalingServer {
  host: string;
  port: number;
}

interface ConnectedPeer {
  readonly peerId: string;
  readonly socket: WebSocket;
  isAlive: boolean;
  roomId?: string;
  displayName?: string;
}

type Room = Map<string, ConnectedPeer>;

export class SignalingServer {
  readonly httpServer: HttpServer;
  readonly webSocketServer: WebSocketServer;

  private readonly config: SignalingConfig;
  private readonly logger: Pick<Console, 'info' | 'error'>;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly rooms = new Map<string, Room>();
  private readonly connectedPeers = new Map<WebSocket, ConnectedPeer>();
  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private stopPromise: Promise<void> | undefined;

  constructor(options: SignalingServerOptions = {}) {
    this.config = {
      host: options.host ?? DEFAULT_HOST,
      port: options.port ?? DEFAULT_PORT,
      allowedOrigins: options.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS,
      maxRoomSize: options.maxRoomSize ?? DEFAULT_MAX_ROOM_SIZE,
    };
    validateConfig(this.config);
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!Number.isInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs < 1) {
      throw new Error('heartbeatIntervalMs must be a positive integer');
    }
    this.logger = options.logger ?? console;
    this.allowedOrigins = new Set(this.config.allowedOrigins.map(normalizeConfiguredOrigin));

    this.httpServer = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
    });

    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_WEBSOCKET_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });

    this.httpServer.on('upgrade', (request, socket, head) => {
      const pathname = request.url ? new URL(request.url, 'http://signaling.local').pathname : '';

      if (pathname !== '/signal') {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }

      if (!this.isOriginAllowed(request.headers.origin)) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }

      this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.webSocketServer.emit('connection', webSocket, request);
      });
    });

    this.webSocketServer.on('connection', (socket) => {
      this.attachPeer(socket);
    });
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  participantCount(roomId: string): number {
    return this.rooms.get(roomId)?.size ?? 0;
  }

  async start(): Promise<StartedSignalingServer> {
    if (this.httpServer.listening) {
      return this.address();
    }

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.httpServer.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.httpServer.off('error', onError);
        resolve();
      };

      this.httpServer.once('error', onError);
      this.httpServer.once('listening', onListening);
      this.httpServer.listen(this.config.port, this.config.host);
    });

    this.startHeartbeat();
    return this.address();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.performStop();
    return this.stopPromise;
  }

  private address(): StartedSignalingServer {
    const address = this.httpServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The signaling server does not have a TCP address');
    }
    return {
      host: address.address,
      port: address.port,
    };
  }

  private isOriginAllowed(origin: string | undefined): boolean {
    if (this.allowedOrigins.has('*')) {
      return true;
    }
    if (origin === undefined) {
      return false;
    }

    try {
      return this.allowedOrigins.has(normalizeOrigin(origin));
    } catch {
      return false;
    }
  }

  private attachPeer(socket: WebSocket): void {
    const peer: ConnectedPeer = {
      peerId: randomUUID(),
      socket,
      isAlive: true,
    };
    this.connectedPeers.set(socket, peer);

    socket.on('message', (data, isBinary) => {
      this.handleWireMessage(peer, data, isBinary);
    });
    socket.on('pong', () => {
      peer.isAlive = true;
    });
    socket.on('close', () => {
      this.connectedPeers.delete(socket);
      this.removePeerFromRoom(peer);
    });
    socket.on('error', (error) => {
      this.logger.error(`WebSocket error for peer ${peer.peerId}`, error);
    });
  }

  private handleWireMessage(peer: ConnectedPeer, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.sendError(peer, 'INVALID_MESSAGE', 'Binary messages are not supported.');
      return;
    }

    let input: unknown;
    try {
      input = JSON.parse(data.toString());
    } catch {
      this.sendError(peer, 'INVALID_MESSAGE', 'Message must be valid JSON.');
      return;
    }

    let message: ClientMessage;
    try {
      message = parseClientMessage(input);
    } catch (error) {
      const detail =
        error instanceof ProtocolValidationError
          ? error.message
          : 'Message does not match protocol v1.';
      this.sendError(peer, 'INVALID_MESSAGE', detail);
      return;
    }

    switch (message.type) {
      case 'room.join':
        this.joinRoom(peer, message);
        break;
      case 'room.leave':
        this.leaveRoom(peer, message.roomId, message.requestId);
        break;
      case 'rtc.offer':
      case 'rtc.answer':
      case 'rtc.ice':
        this.relay(peer, message);
        break;
    }
  }

  private joinRoom(
    peer: ConnectedPeer,
    message: Extract<ClientMessage, { type: 'room.join' }>,
  ): void {
    if (peer.roomId !== undefined) {
      this.sendError(
        peer,
        'ALREADY_JOINED',
        'Leave the current room before joining another room.',
        peer.roomId,
        message.requestId,
      );
      return;
    }

    const existingRoom = this.rooms.get(message.roomId);
    if (existingRoom !== undefined && existingRoom.size >= this.config.maxRoomSize) {
      this.sendError(
        peer,
        'ROOM_FULL',
        `This room is limited to ${this.config.maxRoomSize} participants.`,
        message.roomId,
        message.requestId,
      );
      return;
    }

    const room = existingRoom ?? new Map<string, ConnectedPeer>();
    const participants = [...room.values()].map(toParticipant);

    peer.roomId = message.roomId;
    peer.displayName = message.payload.displayName;
    room.set(peer.peerId, peer);
    this.rooms.set(message.roomId, room);

    const joinedMessage: ServerMessage = {
      v: PROTOCOL_VERSION,
      type: 'room.joined',
      roomId: message.roomId,
      ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
      payload: {
        peerId: peer.peerId,
        participants,
      },
    };
    this.send(peer.socket, joinedMessage);

    const peerJoinedMessage: ServerMessage = {
      v: PROTOCOL_VERSION,
      type: 'peer.joined',
      roomId: message.roomId,
      payload: {
        participant: toParticipant(peer),
      },
    };
    this.broadcast(room, peerJoinedMessage, peer.peerId);
  }

  private leaveRoom(
    peer: ConnectedPeer,
    requestedRoomId: string,
    requestId: string | undefined,
  ): void {
    if (peer.roomId === undefined) {
      this.sendError(
        peer,
        'NOT_IN_ROOM',
        'Join a room before leaving it.',
        requestedRoomId,
        requestId,
      );
      return;
    }
    if (peer.roomId !== requestedRoomId) {
      this.sendError(
        peer,
        'ROOM_MISMATCH',
        'The message room does not match the joined room.',
        peer.roomId,
        requestId,
      );
      return;
    }

    this.removePeerFromRoom(peer);
  }

  private relay(
    peer: ConnectedPeer,
    message: Extract<ClientMessage, { type: 'rtc.offer' | 'rtc.answer' | 'rtc.ice' }>,
  ): void {
    if (peer.roomId === undefined) {
      this.sendError(
        peer,
        'NOT_IN_ROOM',
        'Join a room before sending negotiation messages.',
        message.roomId,
        message.requestId,
      );
      return;
    }
    if (peer.roomId !== message.roomId) {
      this.sendError(
        peer,
        'ROOM_MISMATCH',
        'The message room does not match the joined room.',
        peer.roomId,
        message.requestId,
      );
      return;
    }
    if (message.to === peer.peerId) {
      this.sendError(
        peer,
        'TARGET_SELF',
        'A peer cannot relay a negotiation message to itself.',
        peer.roomId,
        message.requestId,
      );
      return;
    }

    const target = this.rooms.get(peer.roomId)?.get(message.to);
    if (target === undefined) {
      this.sendError(
        peer,
        'TARGET_NOT_FOUND',
        'The target peer is not in this room.',
        peer.roomId,
        message.requestId,
      );
      return;
    }

    const relayedMessage = toServerRelayMessage(message, peer.peerId);
    this.send(target.socket, relayedMessage);
  }

  private removePeerFromRoom(peer: ConnectedPeer): void {
    if (peer.roomId === undefined) {
      return;
    }

    const roomId = peer.roomId;
    const room = this.rooms.get(roomId);
    delete peer.roomId;
    delete peer.displayName;

    if (room === undefined || !room.delete(peer.peerId)) {
      return;
    }

    if (room.size === 0) {
      this.rooms.delete(roomId);
      return;
    }

    const leftMessage: ServerMessage = {
      v: PROTOCOL_VERSION,
      type: 'peer.left',
      roomId,
      payload: { peerId: peer.peerId },
    };
    this.broadcast(room, leftMessage);
  }

  private broadcast(room: Room, message: ServerMessage, excludedPeerId?: string): void {
    for (const target of room.values()) {
      if (target.peerId !== excludedPeerId) {
        this.send(target.socket, message);
      }
    }
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private sendError(
    peer: ConnectedPeer,
    code: SignalingErrorCode,
    message: string,
    roomId = peer.roomId,
    requestId?: string,
  ): void {
    const errorMessage: ErrorServerMessage = {
      v: PROTOCOL_VERSION,
      type: 'error',
      ...(roomId === undefined ? {} : { roomId }),
      ...(requestId === undefined ? {} : { requestId }),
      payload: { code, message },
    };
    this.send(peer.socket, errorMessage);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      for (const peer of this.connectedPeers.values()) {
        if (!peer.isAlive) {
          peer.socket.terminate();
          continue;
        }

        peer.isAlive = false;
        peer.socket.ping();
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private async performStop(): Promise<void> {
    this.stopHeartbeat();
    const webSocketClosed = new Promise<void>((resolve) => {
      this.webSocketServer.close(() => {
        resolve();
      });
    });

    for (const client of this.webSocketServer.clients) {
      client.close(1001, 'Server shutting down');
    }

    const forceCloseTimer = setTimeout(() => {
      for (const client of this.webSocketServer.clients) {
        client.terminate();
      }
    }, SHUTDOWN_GRACE_PERIOD_MS);
    forceCloseTimer.unref();

    const httpClosed = new Promise<void>((resolve, reject) => {
      if (!this.httpServer.listening) {
        resolve();
        return;
      }
      this.httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });

    try {
      await Promise.all([webSocketClosed, httpClosed]);
    } finally {
      clearTimeout(forceCloseTimer);
      this.connectedPeers.clear();
      this.rooms.clear();
    }
  }
}

export function createSignalingServer(options?: SignalingServerOptions): SignalingServer {
  return new SignalingServer(options);
}

function toParticipant(peer: ConnectedPeer): Participant {
  if (peer.displayName === undefined) {
    throw new Error(`Joined peer ${peer.peerId} has no display name`);
  }
  return {
    peerId: peer.peerId,
    displayName: peer.displayName,
  };
}

function toServerRelayMessage(
  message: Extract<ClientMessage, { type: 'rtc.offer' | 'rtc.answer' | 'rtc.ice' }>,
  from: string,
): ServerMessage {
  switch (message.type) {
    case 'rtc.offer':
      return {
        v: PROTOCOL_VERSION,
        type: 'rtc.offer',
        roomId: message.roomId,
        from,
        payload: message.payload,
      };
    case 'rtc.answer':
      return {
        v: PROTOCOL_VERSION,
        type: 'rtc.answer',
        roomId: message.roomId,
        from,
        payload: message.payload,
      };
    case 'rtc.ice':
      return {
        v: PROTOCOL_VERSION,
        type: 'rtc.ice',
        roomId: message.roomId,
        from,
        payload: message.payload,
      };
  }
}

function normalizeConfiguredOrigin(origin: string): string {
  if (origin === '*') {
    return origin;
  }
  return normalizeOrigin(origin);
}

function normalizeOrigin(origin: string): string {
  if (origin === 'null') {
    return origin;
  }
  const parsed = new URL(origin);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported origin protocol: ${parsed.protocol}`);
  }
  if (parsed.origin !== origin.replace(/\/$/, '')) {
    throw new Error(`Origin must not contain a path: ${origin}`);
  }
  return parsed.origin;
}

function validateConfig(config: SignalingConfig): void {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
    throw new Error('port must be an integer between 0 and 65535');
  }
  if (!Number.isInteger(config.maxRoomSize) || config.maxRoomSize < 1) {
    throw new Error('maxRoomSize must be a positive integer');
  }
  if (config.allowedOrigins.length === 0) {
    throw new Error('allowedOrigins must contain at least one origin');
  }
}

function rejectUpgrade(socket: Duplex, status: 403 | 404, reason: string): void {
  socket.write(
    [
      `HTTP/1.1 ${status} ${reason}`,
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      `Content-Length: ${Buffer.byteLength(reason)}`,
      '',
      reason,
    ].join('\r\n'),
  );
  socket.destroy();
}
