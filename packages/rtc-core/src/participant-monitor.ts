import { summarizeConnection } from './connection-diagnostics.js';

export type ReceptionQuality = 'stable' | 'unstable' | 'unavailable';
export interface ParticipantActivity {
  readonly speaking: boolean;
  readonly receptionQuality: ReceptionQuality;
}

class SpeechActivity {
  #consecutive = 0;
  #holdUntil = 0;

  update(level: number | undefined, enabled: boolean, now: number): boolean {
    if (!enabled || level === undefined || !Number.isFinite(level)) {
      this.#consecutive = 0;
      this.#holdUntil = 0;
      return false;
    }
    this.#consecutive = level >= 0.02 ? this.#consecutive + 1 : 0;
    if (this.#consecutive >= 2) this.#holdUntil = now + 800;
    return now < this.#holdUntil;
  }
}

/** 현재 브라우저 표시용 통계만 보관하며 원본 통계를 외부로 내보내지 않는다. */
export class ParticipantMonitor {
  readonly #remoteSpeech = new SpeechActivity();
  readonly #localSpeech = new SpeechActivity();
  #qualityReport: RTCStatsReport | null = null;
  #qualitySampledAt = 0;
  #quality: ReceptionQuality = 'unavailable';
  #candidate: ReceptionQuality = 'unavailable';
  #consecutive = 0;

  sample(
    report: RTCStatsReport,
    now: number,
    audioEnabled: boolean,
    localAudioEnabled: boolean,
    qualityEnabled: boolean,
  ): ParticipantActivity & { localSpeaking: boolean } {
    let remoteLevel: number | undefined;
    let localLevel: number | undefined;
    for (const stats of report.values()) {
      const audio = stats as RTCStats & { kind?: string; audioLevel?: number };
      if (audio.kind !== 'audio') continue;
      if (audio.type === 'inbound-rtp' && audio.audioLevel !== undefined)
        remoteLevel = Math.max(remoteLevel ?? 0, audio.audioLevel);
      if (audio.type === 'media-source' && audio.audioLevel !== undefined)
        localLevel = Math.max(localLevel ?? 0, audio.audioLevel);
    }
    if (!qualityEnabled) {
      this.#quality = 'unavailable';
      this.#qualityReport = null;
      this.#consecutive = 0;
    } else if (this.#qualityReport === null || now - this.#qualitySampledAt >= 3_000) {
      if (this.#qualityReport !== null) {
        const summary = summarizeConnection(0, 'connected', this.#qualityReport, report);
        const next: ReceptionQuality =
          summary.packetLossPercent === null
            ? 'unavailable'
            : summary.packetLossPercent >= 5 ||
                (summary.roundTripTimeMs ?? 0) >= 500 ||
                (summary.jitterMs ?? 0) >= 50
              ? 'unstable'
              : 'stable';
        this.#consecutive = next === this.#candidate ? this.#consecutive + 1 : 1;
        this.#candidate = next;
        if (next === 'unavailable' || this.#consecutive >= 2) this.#quality = next;
      }
      this.#qualityReport = report;
      this.#qualitySampledAt = now;
    }
    return {
      speaking: this.#remoteSpeech.update(remoteLevel, audioEnabled, now),
      localSpeaking: this.#localSpeech.update(localLevel, localAudioEnabled, now),
      receptionQuality: this.#quality,
    };
  }
}
