export type ChatDeliveryState = 'pending' | 'sent' | 'partial' | 'failed' | 'received';

export interface ChatMessage {
  readonly id: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly text: string;
  readonly sentAt: number;
  readonly isLocal: boolean;
  readonly deliveryState: ChatDeliveryState;
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

/** 화면에 보이는 채팅 기록과 로컬 메시지의 수신 확인 수명주기를 관리한다. */
export class RoomChatLedger {
  readonly #activeLocalMessageIds = new Set<string>();
  readonly #recentlyRetiredLocalMessageIds = new Set<string>();
  readonly #localRecipientStates = new Map<string, Map<string, ChatRecipientDeliveryState>>();
  readonly #messages: ChatMessage[] = [];
  readonly #maxMessages: number;

  constructor(maxMessages: number) {
    this.#maxMessages = maxMessages;
  }

  assertLocalMessageIdAvailable(messageId: string): void {
    if (
      this.#activeLocalMessageIds.has(messageId) ||
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
    if (deliveryState === 'pending') {
      this.#localRecipientStates.set(message.id, recipientStates);
    }
    const storedMessage = { ...message, deliveryState };
    this.#rememberMessage(storedMessage);
    return storedMessage;
  }

  recordReceived(message: ChatMessage): void {
    this.#rememberMessage(message);
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
    if (deliveryState !== 'pending') {
      this.#localRecipientStates.delete(messageId);
      this.#retireLocalMessageIdIfUnused(messageId);
    }
    if (index < 0) {
      return false;
    }
    const message = this.#messages[index]!;
    if (message.deliveryState === deliveryState) {
      return false;
    }
    this.#messages[index] = { ...message, deliveryState };
    return true;
  }

  snapshot(): readonly ChatMessage[] {
    return this.#messages.map((message) => ({ ...message }));
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
    if (message.isLocal) {
      this.#activeLocalMessageIds.add(message.id);
    }
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
      !this.#activeLocalMessageIds.has(messageId) ||
      this.#localRecipientStates.has(messageId) ||
      this.#messages.some((message) => message.isLocal && message.id === messageId)
    ) {
      return;
    }

    this.#activeLocalMessageIds.delete(messageId);
    this.#recentlyRetiredLocalMessageIds.add(messageId);
    while (this.#recentlyRetiredLocalMessageIds.size > MAX_RECENTLY_RETIRED_LOCAL_CHAT_IDS) {
      const oldest = this.#recentlyRetiredLocalMessageIds.values().next().value as string;
      this.#recentlyRetiredLocalMessageIds.delete(oldest);
    }
  }
}
