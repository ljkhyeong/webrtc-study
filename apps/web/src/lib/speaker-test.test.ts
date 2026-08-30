// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSpeakerTest } from './speaker-test';

function setup() {
  const track = { stop: vi.fn() };
  const audio = {
    srcObject: null,
    setSinkId: vi.fn().mockResolvedValue(undefined),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
  };
  const oscillator = {
    frequency: { value: 0 },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    onended: null as (() => void) | null,
  };
  const gain = {
    connect: vi.fn(),
    gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
  };
  oscillator.connect.mockReturnValue(gain);
  const context = {
    currentTime: 0,
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    createMediaStreamDestination: vi.fn(() => ({ stream: { getTracks: () => [track] } })),
    createOscillator: () => oscillator,
    createGain: () => gain,
  };
  vi.stubGlobal(
    'Audio',
    class {
      constructor() {
        return audio;
      }
    },
  );
  vi.stubGlobal(
    'AudioContext',
    class {
      constructor() {
        return context;
      }
    },
  );
  return { audio, oscillator, context, track };
}
afterEach(() => vi.unstubAllGlobals());

describe('스피커 확인음 수명', () => {
  it('선택한 출력으로 재생한 뒤 확인음과 오디오 자원을 정리한다', async () => {
    const { audio, oscillator, context, track } = setup();
    const test = startSpeakerTest('headset');
    await vi.waitFor(() => expect(oscillator.start).toHaveBeenCalled());
    expect(audio.setSinkId).toHaveBeenCalledWith('headset');
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(oscillator.stop).toHaveBeenCalledWith(0.6);
    oscillator.onended!();
    await test.finished;
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.srcObject).toBeNull();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it('출력 선택 도중 닫으면 늦게 완료되어도 확인음을 시작하지 않는다', async () => {
    const { audio, oscillator, context } = setup();
    let finish!: () => void;
    audio.setSinkId.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const test = startSpeakerTest('headset');
    test.stop();
    finish();
    await test.finished;
    expect(audio.play).not.toHaveBeenCalled();
    expect(oscillator.start).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it('출력 장치 적용 실패 시 소리를 재생하지 않고 자원을 정리한다', async () => {
    const { audio, context } = setup();
    audio.setSinkId.mockRejectedValue(new Error('출력 장치 없음'));
    await expect(startSpeakerTest('missing').finished).rejects.toThrow('출력 장치 없음');
    expect(audio.play).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledTimes(1);
  });
});
