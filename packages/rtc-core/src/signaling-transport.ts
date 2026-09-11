import {
  parseServerMessageText,
  serializeClientMessage,
  type ClientMessage,
  type ServerMessage,
} from '@round/protocol';

type RelayClientMessage = Extract<ClientMessage, { to: string }>;
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

const MAX_PENDING_SIGNAL_REQUESTS = 256;

interface SocketBinding {
  readonly socket: WebSocket;
  readonly generation: number;
  readonly message: (event: MessageEvent<unknown>) => void;
  readonly close: (event: CloseEvent) => void;
}

interface PendingSignalRequest {
  readonly peerId: string;
}

interface SignalingTransportOptions {
  readonly url: string;
  readonly roomId: string;
  readonly connectTimeoutMs: number;
  readonly beforeConnect?: (() => void | Promise<void>) | undefined;
  readonly webSocketFactory?: ((url: string) => WebSocket) | undefined;
  readonly canConnect: () => boolean;
  readonly onMessage: (message: ServerMessage, socket: WebSocket, generation: number) => void;
  readonly onInvalidMessage: (message: string) => void;
  readonly onClose: (error: SignalingTransportError, event: CloseEvent) => void;
}

export type SignalingTransportErrorCode =
  'signaling-connect-failed' | 'signaling-connect-timeout' | 'signaling-closed';

export class SignalingTransportError extends Error {
  constructor(
    readonly code: SignalingTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SignalingTransportError';
  }
}

/** RoomSession 하나의 WebSocket 연결과 요청·응답 연결을 관리한다. */
export class SignalingTransport {
  readonly #options: SignalingTransportOptions;
  readonly #pendingRequests = new Map<string, PendingSignalRequest>();

  #socket: WebSocket | null = null;
  #binding: SocketBinding | null = null;
  #generation = 0;
  #requestSequence = 0;
  #rejectConnecting: ((reason: unknown) => void) | null = null;

  constructor(options: SignalingTransportOptions) {
    this.#options = options;
  }

  get socket(): WebSocket | null {
    return this.#socket;
  }

  isOpen(): boolean {
    return this.#socket !== null && this.#socket.readyState === this.#socket.OPEN;
  }

  async connect(): Promise<void> {
    await this.#options.beforeConnect?.();
    if (!this.#options.canConnect()) return;

    return new Promise((resolve, reject) => {
      let settled = false;
      const factory = this.#options.webSocketFactory ?? ((url: string) => new WebSocket(url));

      let socket: WebSocket;
      try {
        socket = factory(this.#options.url);
      } catch (error) {
        reject(error);
        return;
      }

      this.#pendingRequests.clear();
      this.#socket = socket;
      const generation = ++this.#generation;
      this.#bind(socket, generation);

      let timeout: TimerHandle | null = null;
      const cleanupAttemptListeners = () => {
        socket.removeEventListener('open', settleOpen);
        socket.removeEventListener('error', settleErrorEvent);
        socket.removeEventListener('close', settleClose);
        if (timeout !== null) {
          globalThis.clearTimeout(timeout);
          timeout = null;
        }
      };

      const settleOpen = () => {
        if (settled) return;
        settled = true;
        cleanupAttemptListeners();
        this.#rejectConnecting = null;
        resolve();
      };
      const settleError = (
        error: unknown = new SignalingTransportError(
          'signaling-connect-failed',
          'Could not connect to the signaling server',
        ),
      ) => {
        if (settled) return;
        settled = true;
        cleanupAttemptListeners();
        this.#rejectConnecting = null;
        reject(error);
      };
      const settleErrorEvent = () => {
        settleError();
      };
      const settleClose = (event: Event) => {
        const close = event as CloseEvent;
        const reason = close.reason || `close code ${close.code}`;
        settleError(
          new SignalingTransportError(
            'signaling-closed',
            `Signaling connection closed before it opened (${reason})`,
          ),
        );
      };

      this.#rejectConnecting = settleError;
      socket.addEventListener('open', settleOpen);
      socket.addEventListener('error', settleErrorEvent);
      socket.addEventListener('close', settleClose);
      timeout = globalThis.setTimeout(() => {
        const error = new SignalingTransportError(
          'signaling-connect-timeout',
          `Signaling connection did not open within ${this.#options.connectTimeoutMs}ms`,
        );
        settleError(error);
        if (this.isCurrent(socket, generation)) {
          this.close(1000, 'signaling connect timeout');
        }
      }, this.#options.connectTimeoutMs);

      if (socket.readyState === socket.OPEN) {
        settleOpen();
      } else if (socket.readyState !== socket.CONNECTING) {
        settleError();
      }
    });
  }

  cancelConnect(reason: unknown): void {
    this.#rejectConnecting?.(reason);
    this.#rejectConnecting = null;
  }

  send(message: ClientMessage): void {
    this.#requireOpenSocket().send(serializeClientMessage(message));
  }

  sendSerialized(serializedMessage: string): void {
    this.#requireOpenSocket().send(serializedMessage);
  }

  sendRelay(message: RelayClientMessage): void {
    const socket = this.#requireOpenSocket();
    this.#requestSequence += 1;
    const requestId = `signal-${this.#generation}-${this.#requestSequence.toString(36)}`;
    const correlatedMessage = { ...message, requestId } as RelayClientMessage;
    const serialized = serializeClientMessage(correlatedMessage);
    this.#rememberRequest(requestId, correlatedMessage.to);
    try {
      socket.send(serialized);
    } catch (error) {
      this.#pendingRequests.delete(requestId);
      throw error;
    }
  }

  takePendingRequest(requestId: string): { readonly peerId: string } | null {
    const request = this.#pendingRequests.get(requestId);
    if (request === undefined) return null;
    this.#pendingRequests.delete(requestId);
    return { peerId: request.peerId };
  }

  purgeRequestsForPeer(peerId: string): void {
    for (const [requestId, request] of this.#pendingRequests) {
      if (request.peerId === peerId) {
        this.#pendingRequests.delete(requestId);
      }
    }
  }

  clearPendingRequests(): void {
    this.#pendingRequests.clear();
  }

  close(code = 1000, reason = 'client leave'): void {
    this.#pendingRequests.clear();
    const socket = this.#socket;
    if (socket === null) return;
    this.#detach(socket);
    socket.close(code, reason);
    this.#socket = null;
  }

  isCurrent(socket: WebSocket, generation: number): boolean {
    return (
      this.#socket === socket &&
      this.#binding?.socket === socket &&
      this.#binding.generation === generation
    );
  }

  #bind(socket: WebSocket, generation: number): void {
    const message = (event: MessageEvent<unknown>) => {
      this.#handleMessage(socket, generation, event);
    };
    const close = (event: CloseEvent) => {
      this.#handleClose(socket, generation, event);
    };
    this.#binding = { socket, generation, message, close };
    socket.addEventListener('message', message);
    socket.addEventListener('close', close);
  }

  #handleMessage(socket: WebSocket, generation: number, event: MessageEvent<unknown>): void {
    if (!this.isCurrent(socket, generation)) return;
    if (typeof event.data !== 'string') {
      this.#options.onInvalidMessage('Ignored a non-text signaling message');
      return;
    }

    let message: ServerMessage;
    try {
      message = parseServerMessageText(event.data);
    } catch (error) {
      this.#options.onInvalidMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    if (message.type !== 'error' && message.roomId !== this.#options.roomId) return;
    this.#options.onMessage(message, socket, generation);
  }

  #handleClose(socket: WebSocket, generation: number, event: CloseEvent): void {
    if (!this.isCurrent(socket, generation)) return;
    this.#detach(socket);
    this.#socket = null;
    this.#pendingRequests.clear();
    const reason = event.reason || `close code ${event.code}`;
    const error = new SignalingTransportError(
      'signaling-closed',
      `Signaling connection closed (${reason})`,
    );
    this.cancelConnect(error);
    this.#options.onClose(error, event);
  }

  #rememberRequest(requestId: string, peerId: string): void {
    this.#pendingRequests.set(requestId, {
      peerId,
    });
    while (this.#pendingRequests.size > MAX_PENDING_SIGNAL_REQUESTS) {
      const oldestRequestId = this.#pendingRequests.keys().next().value as string;
      this.#pendingRequests.delete(oldestRequestId);
    }
  }

  #requireOpenSocket(): WebSocket {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== socket.OPEN) {
      throw new Error('Signaling socket is not open');
    }
    return socket;
  }

  #detach(socket: WebSocket): void {
    const binding = this.#binding;
    if (binding === null || binding.socket !== socket) return;
    socket.removeEventListener('message', binding.message);
    socket.removeEventListener('close', binding.close);
    this.#binding = null;
  }
}
