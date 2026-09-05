import {
  parsePeerDataMessage,
  serializePeerDataMessage,
  utf8ByteLength,
  type ChatAckDataMessage,
  type ChatDataMessage,
  type ParticipantHandDataMessage,
  type ParticipantMediaDataMessage,
  type PeerDataMessage,
} from '@round/protocol';

export const PEER_DATA_CHANNEL_LABEL = 'round-room';

const DATA_CHANNEL_RATE_WINDOW_MS = 10_000;
const MAX_DATA_CHANNEL_MESSAGES_PER_WINDOW = 120;
const MAX_PENDING_CHAT_MESSAGES = 50;
const MAX_RECEIVED_CHAT_IDS = 128;
const MAX_PENDING_ACK_IDS = 128;
const CHAT_ACK_TIMEOUT_MS = 45_000;
const MAX_BUFFERED_BYTES = 256 * 1024;
const BUFFERED_AMOUNT_LOW_BYTES = 64 * 1024;
const CONTROL_RESERVE_BYTES = 32 * 1024;
const ERROR_GRACE_MS = 250;
const RECOVERY_WARNING_CODES = [
  'data-channel-closed',
  'data-channel-error',
  'data-channel-send-failed',
] as const;

export type PeerDataChannelRecoveryIssueCode = (typeof RECOVERY_WARNING_CODES)[number];
export type PeerDataChannelIssueCode = PeerDataChannelRecoveryIssueCode | 'data-channel-rate-limit';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

interface PendingChatMessage {
  readonly message: ChatDataMessage;
  readonly serialized: string;
  readonly byteLength: number;
  readonly timeout: TimerHandle;
  sentOnCurrentChannel: boolean;
  everSent: boolean;
}

interface PeerDataChannelOptions {
  readonly peerId: string;
  readonly isCurrent: () => boolean;
  readonly isRecovering: () => boolean;
  readonly monotonicNow: () => number;
  readonly currentMediaState: () => ParticipantMediaDataMessage;
  readonly currentHandState: () => ParticipantHandDataMessage;
  readonly onOpen: () => void;
  readonly canReceiveChat: () => boolean;
  readonly onChatMessage: (message: ChatDataMessage) => void;
  readonly onMediaState: (message: ParticipantMediaDataMessage) => void;
  readonly onHandState: (message: ParticipantHandDataMessage) => void;
  readonly onChatAcknowledged: (messageId: string) => boolean;
  readonly onChatFailed: (messageId: string) => boolean;
  readonly onRateLimited: () => void;
  readonly onRecoveryRequired: (code: PeerDataChannelRecoveryIssueCode, message: string) => void;
  readonly clearWarning: (codes: readonly PeerDataChannelIssueCode[]) => boolean;
  readonly onStateChanged: () => void;
}

/** 단일 피어의 DataChannel, ACK, 송신 대기열과 수신 제한 수명주기를 소유한다. */
export class PeerDataChannel {
  readonly #options: PeerDataChannelOptions;
  readonly #pendingChatMessages: PendingChatMessage[] = [];
  readonly #receivedChatIds = new Set<string>();
  readonly #receivedChatIdOrder: string[] = [];
  readonly #pendingAckIds = new Set<string>();

  #channel: RTCDataChannel | null = null;
  #pendingMediaState: ParticipantMediaDataMessage | null = null;
  #pendingHandState: ParticipantHandDataMessage | null = null;
  #inboundWindowStartedAt: number | null = null;
  #inboundMessagesInWindow = 0;
  #inboundRateLimitExceeded = false;
  #inboundWindowExpiryTimer: TimerHandle | null = null;
  #errorTimer: TimerHandle | null = null;

  constructor(options: PeerDataChannelOptions) {
    this.#options = options;
  }

  isAttached(): boolean {
    return this.#channel !== null;
  }

  isOpen(): boolean {
    return this.#channel?.readyState === 'open';
  }

  hasQueueCapacity(): boolean {
    return this.#pendingChatMessages.length < MAX_PENDING_CHAT_MESSAGES;
  }

  attach(channel: RTCDataChannel): void {
    if (this.#channel !== null && this.#channel !== channel) {
      this.#detachAndClose(this.#channel);
    }
    this.#clearErrorTimer();
    this.#channel = channel;
    for (const pendingChat of this.#pendingChatMessages) {
      pendingChat.sentOnCurrentChannel = false;
    }

    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_BYTES;
    channel.onopen = () => this.#handleOpen(channel);
    channel.onmessage = (event) => this.#handleMessage(channel, event.data);
    channel.onbufferedamountlow = () => this.flush();
    channel.onclose = () => {
      this.#recover(
        channel,
        'data-channel-closed',
        `Chat channel to ${this.#options.peerId} closed and is being recovered`,
      );
    };
    channel.onerror = () => {
      this.#clearErrorTimer();
      this.#errorTimer = globalThis.setTimeout(() => {
        this.#errorTimer = null;
        this.#recover(
          channel,
          'data-channel-error',
          `Chat channel to ${this.#options.peerId} encountered an error and is being recovered`,
        );
      }, ERROR_GRACE_MS);
    };

    if (channel.readyState === 'open' && !this.#options.isRecovering()) {
      this.#handleOpen(channel);
    }
  }

  detach(): void {
    this.#clearErrorTimer();
    const channel = this.#channel;
    this.#channel = null;
    if (channel !== null) {
      this.#detachAndClose(channel);
    }
  }

  dispose(): void {
    this.detach();
    if (this.#inboundWindowExpiryTimer !== null) {
      globalThis.clearTimeout(this.#inboundWindowExpiryTimer);
      this.#inboundWindowExpiryTimer = null;
    }
    for (const pendingChat of this.#pendingChatMessages) {
      globalThis.clearTimeout(pendingChat.timeout);
      this.#options.onChatFailed(pendingChat.message.id);
    }
    this.#pendingChatMessages.length = 0;
    this.#receivedChatIds.clear();
    this.#receivedChatIdOrder.length = 0;
    this.#pendingAckIds.clear();
    this.#pendingMediaState = null;
    this.#pendingHandState = null;
    this.#inboundWindowStartedAt = null;
    this.#inboundMessagesInWindow = 0;
    this.#inboundRateLimitExceeded = false;
  }

  enqueueChat(message: ChatDataMessage, serialized: string): void {
    let pendingChat!: PendingChatMessage;
    const timeout = globalThis.setTimeout(() => {
      this.#expireChat(pendingChat);
    }, CHAT_ACK_TIMEOUT_MS);
    pendingChat = {
      message,
      serialized,
      byteLength: utf8ByteLength(serialized),
      timeout,
      sentOnCurrentChannel: false,
      everSent: false,
    };
    this.#pendingChatMessages.push(pendingChat);
  }

  publishMediaState(message: ParticipantMediaDataMessage): void {
    this.#pendingMediaState = message;
    this.flush();
  }

  publishHandState(message: ParticipantHandDataMessage): void {
    this.#pendingHandState = message;
    this.flush();
  }

  flush(sendCurrentState = false): void {
    const channel = this.#channel;
    if (
      !this.#options.isCurrent() ||
      this.#options.isRecovering() ||
      channel === null ||
      channel.readyState !== 'open'
    ) {
      return;
    }

    if (sendCurrentState) {
      this.#pendingMediaState = this.#options.currentMediaState();
      this.#pendingHandState = this.#options.currentHandState();
    }

    while (this.#pendingAckIds.size > 0) {
      const messageId = this.#pendingAckIds.values().next().value as string;
      const acknowledgement: ChatAckDataMessage = {
        type: 'chat.ack',
        messageId,
      };
      const serializedAcknowledgement = serializePeerDataMessage(acknowledgement);
      if (
        this.#isBackpressured(
          channel,
          utf8ByteLength(serializedAcknowledgement),
          MAX_BUFFERED_BYTES + CONTROL_RESERVE_BYTES,
        )
      ) {
        return;
      }
      if (!this.#send(channel, serializedAcknowledgement)) {
        return;
      }
      this.#pendingAckIds.delete(messageId);
    }

    if (this.#pendingMediaState !== null) {
      const serializedMediaState = serializePeerDataMessage(this.#pendingMediaState);
      if (
        this.#isBackpressured(channel, utf8ByteLength(serializedMediaState)) ||
        !this.#send(channel, serializedMediaState)
      ) {
        return;
      }
      this.#pendingMediaState = null;
    }

    if (this.#pendingHandState !== null) {
      const serializedHandState = serializePeerDataMessage(this.#pendingHandState);
      if (
        this.#isBackpressured(channel, utf8ByteLength(serializedHandState)) ||
        !this.#send(channel, serializedHandState)
      ) {
        return;
      }
      this.#pendingHandState = null;
    }

    while (true) {
      const pendingChat = this.#pendingChatMessages.find(
        (candidate) => !candidate.sentOnCurrentChannel,
      );
      if (pendingChat === undefined) {
        return;
      }
      if (
        this.#isBackpressured(channel, pendingChat.byteLength) ||
        !this.#send(channel, pendingChat.serialized)
      ) {
        return;
      }
      pendingChat.sentOnCurrentChannel = true;
      pendingChat.everSent = true;
    }
  }

  clearRecoveryWarning(): boolean {
    if (!this.isOpen()) {
      return false;
    }
    return this.#options.clearWarning(RECOVERY_WARNING_CODES);
  }

  #handleOpen(channel: RTCDataChannel): void {
    if (!this.#isCurrentChannel(channel) || channel.readyState !== 'open') {
      return;
    }
    this.#options.onOpen();
  }

  #handleMessage(channel: RTCDataChannel, raw: unknown): void {
    if (
      !this.#isCurrentChannel(channel) ||
      !this.#consumeInboundBudget() ||
      typeof raw !== 'string'
    ) {
      return;
    }

    let data: PeerDataMessage;
    try {
      data = parsePeerDataMessage(raw);
    } catch {
      return;
    }

    if (data.type === 'chat.ack') {
      if (
        this.#acknowledgeChat(data.messageId) &&
        this.#options.onChatAcknowledged(data.messageId)
      ) {
        this.#options.onStateChanged();
      }
      return;
    }

    if (data.type === 'participant.media') {
      this.#options.onMediaState(data);
      return;
    }

    if (data.type === 'participant.hand') {
      this.#options.onHandState(data);
      return;
    }

    if (!this.#options.canReceiveChat()) {
      return;
    }

    if (!this.#receivedChatIds.has(data.id)) {
      this.#rememberReceivedChatId(data.id);
      this.#options.onChatMessage(data);
    }
    if (this.#pendingAckIds.has(data.id) || this.#pendingAckIds.size < MAX_PENDING_ACK_IDS) {
      this.#pendingAckIds.add(data.id);
      this.flush();
    }
  }

  #acknowledgeChat(messageId: string): boolean {
    const index = this.#pendingChatMessages.findIndex(
      (pendingChat) => pendingChat.everSent && pendingChat.message.id === messageId,
    );
    if (index < 0) {
      return false;
    }
    const [acknowledged] = this.#pendingChatMessages.splice(index, 1) as [PendingChatMessage];
    globalThis.clearTimeout(acknowledged.timeout);
    return true;
  }

  #expireChat(pendingChat: PendingChatMessage): void {
    const index = this.#pendingChatMessages.indexOf(pendingChat);
    if (index < 0) {
      return;
    }
    const [expired] = this.#pendingChatMessages.splice(index, 1) as [PendingChatMessage];
    if (this.#options.onChatFailed(expired.message.id)) {
      this.#options.onStateChanged();
    }
  }

  #rememberReceivedChatId(messageId: string): void {
    this.#receivedChatIds.add(messageId);
    this.#receivedChatIdOrder.push(messageId);
    while (this.#receivedChatIdOrder.length > MAX_RECEIVED_CHAT_IDS) {
      const removed = this.#receivedChatIdOrder.shift() as string;
      this.#receivedChatIds.delete(removed);
    }
  }

  #consumeInboundBudget(): boolean {
    const now = this.#options.monotonicNow();
    const windowStartedAt = this.#inboundWindowStartedAt;
    let warningCleared = false;
    if (windowStartedAt === null || now - windowStartedAt >= DATA_CHANNEL_RATE_WINDOW_MS) {
      warningCleared = this.#resetInboundWindow(now);
    }

    if (this.#inboundMessagesInWindow >= MAX_DATA_CHANNEL_MESSAGES_PER_WINDOW) {
      if (!this.#inboundRateLimitExceeded) {
        this.#inboundRateLimitExceeded = true;
        this.#scheduleInboundWindowExpiry();
      }
      this.#options.onRateLimited();
      return false;
    }

    this.#inboundMessagesInWindow += 1;
    if (warningCleared) {
      this.#options.onStateChanged();
    }
    return true;
  }

  #resetInboundWindow(nextWindowStartedAt: number | null): boolean {
    if (this.#inboundWindowExpiryTimer !== null) {
      globalThis.clearTimeout(this.#inboundWindowExpiryTimer);
      this.#inboundWindowExpiryTimer = null;
    }
    this.#inboundWindowStartedAt = nextWindowStartedAt;
    this.#inboundMessagesInWindow = 0;
    this.#inboundRateLimitExceeded = false;
    return this.#options.clearWarning(['data-channel-rate-limit']);
  }

  #scheduleInboundWindowExpiry(): void {
    const windowStartedAt = this.#inboundWindowStartedAt;
    if (windowStartedAt === null || this.#inboundWindowExpiryTimer !== null) {
      return;
    }

    const delay = Math.max(
      0,
      windowStartedAt + DATA_CHANNEL_RATE_WINDOW_MS - this.#options.monotonicNow(),
    );
    this.#inboundWindowExpiryTimer = globalThis.setTimeout(() => {
      this.#inboundWindowExpiryTimer = null;
      if (
        !this.#options.isCurrent() ||
        !this.#inboundRateLimitExceeded ||
        this.#inboundWindowStartedAt !== windowStartedAt
      ) {
        return;
      }
      if (this.#resetInboundWindow(null)) {
        this.#options.onStateChanged();
      }
    }, delay);
  }

  #recover(channel: RTCDataChannel, code: PeerDataChannelRecoveryIssueCode, message: string): void {
    if (!this.#isCurrentChannel(channel)) {
      return;
    }
    this.detach();
    this.#options.onRecoveryRequired(code, message);
  }

  #send(channel: RTCDataChannel, serializedMessage: string): boolean {
    try {
      channel.send(serializedMessage);
      return true;
    } catch (error) {
      this.#recover(
        channel,
        'data-channel-send-failed',
        `Chat channel to ${this.#options.peerId} rejected a send and is being recovered: ${getErrorMessage(error)}`,
      );
      return false;
    }
  }

  #isBackpressured(
    channel: RTCDataChannel,
    nextFrameBytes: number,
    limit = MAX_BUFFERED_BYTES,
  ): boolean {
    return channel.bufferedAmount + nextFrameBytes > limit;
  }

  #isCurrentChannel(channel: RTCDataChannel): boolean {
    return this.#options.isCurrent() && this.#channel === channel;
  }

  #clearErrorTimer(): void {
    if (this.#errorTimer !== null) {
      globalThis.clearTimeout(this.#errorTimer);
      this.#errorTimer = null;
    }
  }

  #detachAndClose(channel: RTCDataChannel): void {
    channel.onopen = null;
    channel.onmessage = null;
    channel.onclose = null;
    channel.onerror = null;
    channel.onbufferedamountlow = null;
    channel.close();
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
