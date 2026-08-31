// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MicrophoneLevel } from './MicrophoneLevel';

class TestAudioContext extends EventTarget {
  static instances: TestAudioContext[] = [];
  state = 'running';
  source = { connect: vi.fn(), disconnect: vi.fn() };
  analyser = {
    fftSize: 1024,
    getFloatTimeDomainData: (data: Float32Array) => data.fill(0.4),
    disconnect: vi.fn(),
  };
  createMediaStreamSource = vi.fn(() => this.source);
  createAnalyser = vi.fn(() => this.analyser);
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  constructor() {
    super();
    TestAudioContext.instances.push(this);
  }
}

describe('마이크 입력 표시', () => {
  let container: HTMLDivElement;
  let root: Root;
  let nextFrame: FrameRequestCallback;
  const track = { stop: vi.fn() } as unknown as MediaStreamTrack;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('AudioContext', TestAudioContext);
    vi.stubGlobal(
      'MediaStream',
      class {
        constructor(readonly tracks: MediaStreamTrack[]) {}
      },
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        nextFrame = callback;
        return 1;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    TestAudioContext.instances = [];
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('기존 트랙으로 입력 크기를 표시하고 교체·음소거 시 분석 자원만 해제한다', () => {
    act(() => root.render(<MicrophoneLevel track={track} enabled />));
    const first = TestAudioContext.instances[0]!;
    act(() => nextFrame(100));
    expect(container.querySelector('meter')?.value).toBeCloseTo(0.4);
    expect(first.source.connect).toHaveBeenCalledWith(first.analyser);
    expect(first.createMediaStreamSource).toHaveBeenCalledWith({ tracks: [track] });

    const replacement = { stop: vi.fn() } as unknown as MediaStreamTrack;
    act(() => root.render(<MicrophoneLevel track={replacement} enabled />));
    expect(first.close).toHaveBeenCalledOnce();
    expect(first.source.disconnect).toHaveBeenCalledOnce();
    expect(first.analyser.disconnect).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();

    act(() => root.render(<MicrophoneLevel track={replacement} enabled={false} />));
    expect(TestAudioContext.instances[1]!.close).toHaveBeenCalledOnce();
    expect(container.querySelector('meter')?.value).toBe(0);
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(container.textContent).toContain('마이크가 꺼져 있습니다.');
  });

  it('마이크가 없거나 꺼져 있으면 분석을 시작하지 않는다', () => {
    act(() => root.render(<MicrophoneLevel track={null} enabled={false} />));
    act(() => root.render(<MicrophoneLevel track={track} enabled={false} />));
    expect(TestAudioContext.instances).toHaveLength(0);
  });

  it('Web Audio 미지원 시 장치 사용을 막지 않고 안내만 표시한다', () => {
    vi.stubGlobal('AudioContext', undefined);
    act(() => root.render(<MicrophoneLevel track={track} enabled />));
    expect(container.textContent).toContain('이 브라우저에서는 입력 크기를 표시할 수 없습니다.');
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('입력 표시를 닫으면 분석 자원만 정리하고 통화 트랙은 유지한다', () => {
    act(() => root.render(<MicrophoneLevel track={track} enabled />));
    const context = TestAudioContext.instances[0]!;
    act(() => root.render(null));
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.source.disconnect).toHaveBeenCalledOnce();
    expect(context.analyser.disconnect).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(track.stop).not.toHaveBeenCalled();
  });
});
