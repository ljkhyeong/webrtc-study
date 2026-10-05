import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type StudyCommand,
  type StudyState,
} from '@round/protocol';

export interface RoomStudySnapshot extends StudyState {
  readonly sampledAt: number;
}

interface RoomStudyOptions {
  readonly roomId: string;
  /** 연결이 열려 있지 않으면 예외를 던진다. */
  readonly send: (message: ClientMessage) => void;
  readonly createId: () => string;
  readonly monotonicNow: () => number;
  readonly isActive: () => boolean;
  readonly isHost: () => boolean;
  readonly onChanged: () => void;
}

const STUDY_REQUEST_TIMEOUT_MS = 10_000;

/** 방의 공용 타이머·주제 상태와 방장의 변경 요청을 관리한다. */
export class RoomStudy {
  readonly #options: RoomStudyOptions;

  #state: RoomStudySnapshot | null = null;
  #notice: string | null = null;
  #commandId: string | null = null;
  #commandTimer: ReturnType<typeof setTimeout> | null = null;
  #syncRequest: { id: string; sentAt: number } | null = null;

  constructor(options: RoomStudyOptions) {
    this.#options = options;
  }

  snapshot(): {
    readonly study: RoomStudySnapshot | null;
    readonly studyPending: boolean;
    readonly studyNotice: string | null;
  } {
    return {
      study: this.#state === null ? null : { ...this.#state },
      studyPending: this.#commandId !== null,
      studyNotice: this.#notice,
    };
  }

  sync(): boolean {
    if (!this.#options.isActive()) return false;
    const sentAt = this.#options.monotonicNow();
    if (this.#syncRequest && sentAt - this.#syncRequest.sentAt < STUDY_REQUEST_TIMEOUT_MS) {
      return false;
    }
    const id = `study-sync-${this.#options.createId()}`;
    try {
      this.#options.send({
        v: PROTOCOL_VERSION,
        type: 'room.study.sync',
        roomId: this.#options.roomId,
        requestId: id,
      });
      this.#syncRequest = { id, sentAt };
      return true;
    } catch {
      return false;
    }
  }

  update(command: StudyCommand, expectedRevision = this.#state?.revision): boolean {
    if (
      !this.#options.isActive() ||
      !this.#options.isHost() ||
      !this.#state ||
      this.#commandId ||
      expectedRevision !== this.#state.revision
    )
      return false;
    const id = `study-update-${this.#options.createId()}`;
    try {
      this.#options.send({
        v: PROTOCOL_VERSION,
        type: 'room.study.update',
        roomId: this.#options.roomId,
        requestId: id,
        payload: { ...command, expectedRevision },
      });
      this.#commandId = id;
      this.#notice = null;
      this.#commandTimer = globalThis.setTimeout(() => {
        this.#clearCommand();
        this.#notice = '변경 결과를 확인하지 못했습니다. 최신 상태를 불러옵니다.';
        this.sync();
        this.#options.onChanged();
      }, STUDY_REQUEST_TIMEOUT_MS);
      this.#options.onChanged();
      return true;
    } catch {
      return false;
    }
  }

  /** 서버의 타이머 상태를 반영한다. 조회 응답이면 왕복 시간의 절반만큼 남은 시간을 줄인다. */
  applyState(
    requestId: string | undefined,
    { conflict, ...state }: StudyState & { readonly conflict: boolean },
  ): void {
    if (requestId === this.#commandId) this.#clearCommand();
    if (conflict)
      this.#notice = '다른 방장이 먼저 변경했습니다. 최신 상태를 확인한 뒤 다시 조작해 주세요.';
    if (!this.#state || state.revision >= this.#state.revision) {
      const now = this.#options.monotonicNow();
      const request = this.#syncRequest;
      const transitMs =
        request !== null && request.id === requestId ? Math.max(0, now - request.sentAt) / 2 : 0;
      this.#state = {
        ...state,
        remainingMs: Math.max(0, state.remainingMs - (state.running ? transitMs : 0)),
        sampledAt: now,
      };
    }
    if (requestId === this.#syncRequest?.id) this.#syncRequest = null;
  }

  /** 서버가 변경 요청을 거부했으면 대기를 풀고 안내를 남긴 뒤 true를 돌려준다. */
  rejectCommand(requestId: string | undefined): boolean {
    if (requestId === undefined || requestId !== this.#commandId) return false;
    this.#clearCommand();
    this.#notice = '타이머와 주제 변경 요청을 처리하지 못했습니다.';
    return true;
  }

  reset(): void {
    this.#clearCommand();
    this.#state = null;
    this.#notice = null;
    this.#syncRequest = null;
  }

  #clearCommand(): void {
    if (this.#commandTimer !== null) globalThis.clearTimeout(this.#commandTimer);
    this.#commandTimer = null;
    this.#commandId = null;
  }
}
