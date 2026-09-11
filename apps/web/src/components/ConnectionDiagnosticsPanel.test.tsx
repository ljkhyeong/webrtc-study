// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoomConnectionDiagnostics } from '@round/rtc-core';
import { ConnectionDiagnosticsPanel } from './ConnectionDiagnosticsPanel';

function diagnostics(participantName: string): RoomConnectionDiagnostics {
  return {
    status: 'active',
    connections: [
      {
        connectionNumber: 1,
        participantName,
        connectionState: 'connected',
        localCandidateType: 'host',
        remoteCandidateType: 'relay',
        roundTripTimeMs: 30,
        packetLossPercent: 0,
        jitterMs: 4,
      },
    ],
  };
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.unstubAllGlobals();
});

describe('연결 진단', () => {
  it('화면에는 참가자 이름을 표시하고 복사 정보에서는 제외한다', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      await act(async () =>
        root.render(<ConnectionDiagnosticsPanel onCollect={async () => diagnostics('가온')} />),
      );
      const button = (label: string) =>
        [...container.querySelectorAll('button')].find((element) => element.textContent === label)!;

      await act(async () => button('다시 측정').click());
      expect(container.textContent).toContain('가온 · 연결 1');
      expect(container.querySelector('pre')?.textContent).not.toContain('가온');
      expect(container.querySelector('pre')?.textContent).not.toContain('participantName');
      await act(async () => button('진단 정보 복사').click());

      const copied = JSON.parse(writeText.mock.calls[0]![0]) as Record<string, unknown>;
      expect(JSON.stringify(copied)).not.toContain('가온');
      expect(JSON.stringify(copied)).not.toContain('participantName');
    } finally {
      act(() => root.unmount());
    }
  });

  it('참가자 연결이 바뀌면 진행 중인 이전 측정을 버리고 재측정을 안내한다', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let resolveFirst!: (value: RoomConnectionDiagnostics) => void;
    const first = new Promise<RoomConnectionDiagnostics>((resolve) => {
      resolveFirst = resolve;
    });
    const onCollect = vi
      .fn<() => Promise<RoomConnectionDiagnostics>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(diagnostics('나래'));
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (connectionContextKey: string) =>
      root.render(
        <ConnectionDiagnosticsPanel
          connectionContextKey={connectionContextKey}
          onCollect={onCollect}
        />,
      );
    const measure = () =>
      [...container.querySelectorAll('button')].find(
        (element) => element.textContent === '다시 측정',
      )!;

    try {
      await act(async () => render('peer-a:connected'));
      await act(async () => measure().click());
      await act(async () => render('peer-b:connected'));
      expect(container.textContent).toContain('참가자 연결이 바뀌었습니다. 다시 측정해 주세요.');

      await act(async () => resolveFirst(diagnostics('가온')));
      expect(container.textContent).not.toContain('가온 · 연결 1');
      expect(container.textContent).toContain('참가자 연결이 바뀌었습니다. 다시 측정해 주세요.');

      await act(async () => measure().click());
      expect(container.textContent).toContain('나래 · 연결 1');
    } finally {
      act(() => root.unmount());
    }
  });
});
