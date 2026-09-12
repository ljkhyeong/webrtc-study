export type ChatDeliveryState = 'pending' | 'sent' | 'partial' | 'failed' | 'received';

export interface ChatMessage {
  readonly id: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly sentAt: number;
  readonly isLocal: boolean;
  readonly deliveryState: ChatDeliveryState;
  readonly recipients?: readonly ChatRecipient[];
}

export interface ChatRecipient {
  readonly peerId: string;
  readonly displayName: string;
  readonly state: ChatRecipientDeliveryState;
  readonly canRetry?: boolean;
}

export type ChatSendErrorCode =
  'room-not-active' | 'message-id-conflict' | 'peer-unavailable' | 'queue-full';

export class ChatSendError extends Error {
  constructor(
    readonly code: ChatSendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChatSendError';
  }
}

export type ChatRecipientDeliveryState = 'pending' | 'acknowledged' | 'failed';

// 표시와 전송이 끝난 ID만 제한된 FIFO로 보관하고, 대기 중인 ID는 완료될 때까지 유지한다.
const MAX_RECENTLY_RETIRED_LOCAL_CHAT_IDS = 128;

/** 화면 채팅 기록과 내가 보낸 메시지의 수신 확인 상태를 관리한다. */
export class RoomChatLedger {
  readonly #recentlyRetiredLocalMessageIds = new Set<string>();
  readonly #localRecipientStates = new Map<string, Map<string, ChatRecipientDeliveryState>>();
  readonly #messages: ChatMessage[] = [];
  readonly #maxMessages: number;
  readonly #retryDeadlines = new Map<string, number>();
  readonly #receivedIds = new Set<string>();
  readonly #now: () => number;

  constructor(maxMessages: number, now: () => number = () => performance.now()) {
    this.#maxMessages = maxMessages;
    this.#now = now;
  }

  assertLocalMessageIdAvailable(messageId: string): void {
    if (
      this.#localRecipientStates.has(messageId) ||
      this.#recentlyRetiredLocalMessageIds.has(messageId)
    ) {
      throw new ChatSendError(
        'message-id-conflict',
        `Chat message id ${messageId} is already in use`,
      );
    }
  }

  recordOutgoing(
    message: Omit<ChatMessage, 'deliveryState'>,
    recipientStates: Map<string, ChatRecipientDeliveryState>,
  ): ChatMessage {
    const deliveryState = this.#aggregateDeliveryState(recipientStates);
    this.#localRecipientStates.set(message.id, recipientStates);
    this.#retryDeadlines.set(message.id, this.#now() + 120_000);
    const storedMessage = { ...message, deliveryState };
    this.#rememberMessage(storedMessage);
    return storedMessage;
  }

  recordReceived(message: ChatMessage): void {
    const key = JSON.stringify([message.senderId, message.id]);
    if (this.#receivedIds.has(key)) return;
    this.#receivedIds.add(key);
    // 방의 정상 수신 제한에서 2분 재전송 창을 충분히 덮고, 기록 크기도 제한한다.
    while (this.#receivedIds.size > 16_384)
      this.#receivedIds.delete(this.#receivedIds.values().next().value!);
    this.#rememberMessage(message);
  }

  retryCandidate(messageId: string): ChatMessage | undefined {
    if ((this.#retryDeadlines.get(messageId) ?? 0) <= this.#now()) return undefined;
    return this.#messages.find((message) => message.isLocal && message.id === messageId);
  }

  prepareRetry(messageId: string, peerIds: readonly string[]): void {
    const states = this.#localRecipientStates.get(messageId)!;
    for (const peerId of peerIds) states.set(peerId, 'pending');
    const index = this.#messages.findIndex(
      (message) => message.isLocal && message.id === messageId,
    );
    this.#messages[index] = {
      ...this.#messages[index]!,
      deliveryState: this.#aggregateDeliveryState(states),
    };
  }

  failedRecipients(messageId: string): readonly string[] {
    return [...(this.#localRecipientStates.get(messageId) ?? [])]
      .filter(([, state]) => state === 'failed')
      .map(([peerId]) => peerId);
  }

  markLocalRecipient(
    messageId: string,
    peerId: string,
    state: Exclude<ChatRecipientDeliveryState, 'pending'>,
  ): boolean {
    const recipientStates = this.#localRecipientStates.get(messageId);
    if (recipientStates?.get(peerId) !== 'pending') {
      return false;
    }

    recipientStates.set(peerId, state);
    const index = this.#messages.findIndex(
      (message) => message.id === messageId && message.isLocal,
    );
    const deliveryState = this.#aggregateDeliveryState(recipientStates);
    if (deliveryState !== 'pending') this.#retireLocalMessageIdIfUnused(messageId);
    if (index < 0) {
      return false;
    }
    const message = this.#messages[index]!;
    this.#messages[index] = { ...message, deliveryState };
    return true;
  }

  snapshot(): readonly ChatMessage[] {
    return this.#messages.map((message) => {
      const states = this.#localRecipientStates.get(message.id);
      return {
        ...message,
        ...(message.isLocal && states
          ? {
              recipients: [...states].map(([peerId, state]) => ({
                peerId,
                displayName:
                  message.recipients?.find((recipient) => recipient.peerId === peerId)
                    ?.displayName ?? peerId,
                state,
              })),
            }
          : {}),
      };
    });
  }

  #aggregateDeliveryState(
    recipientStates: ReadonlyMap<string, ChatRecipientDeliveryState>,
  ): Exclude<ChatDeliveryState, 'received'> {
    let sentCount = 0;
    let failedCount = 0;
    for (const state of recipientStates.values()) {
      if (state === 'pending') {
        return 'pending';
      }
      if (state === 'acknowledged') {
        sentCount += 1;
      } else {
        failedCount += 1;
      }
    }

    if (failedCount === 0) {
      return 'sent';
    }
    return sentCount === 0 ? 'failed' : 'partial';
  }

  #rememberMessage(message: ChatMessage): void {
    this.#messages.push(message);

    while (this.#messages.length > this.#maxMessages) {
      const removed = this.#messages.shift() as ChatMessage;
      if (removed.isLocal) {
        this.#retireLocalMessageIdIfUnused(removed.id);
      }
    }
  }

  #retireLocalMessageIdIfUnused(messageId: string): void {
    if (
      !this.#localRecipientStates.has(messageId) ||
      [...(this.#localRecipientStates.get(messageId)?.values() ?? [])].some(
        (state) => state === 'pending',
      ) ||
      this.#messages.some((message) => message.isLocal && message.id === messageId)
    ) {
      return;
    }

    this.#localRecipientStates.delete(messageId);
    this.#retryDeadlines.delete(messageId);
    this.#recentlyRetiredLocalMessageIds.add(messageId);
    while (this.#recentlyRetiredLocalMessageIds.size > MAX_RECENTLY_RETIRED_LOCAL_CHAT_IDS) {
      const oldest = this.#recentlyRetiredLocalMessageIds.values().next().value as string;
      this.#recentlyRetiredLocalMessageIds.delete(oldest);
    }
  }
}
