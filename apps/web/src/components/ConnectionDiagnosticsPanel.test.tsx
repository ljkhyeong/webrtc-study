// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionDiagnosticsPanel } from './ConnectionDiagnosticsPanel';

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
        root.render(
          <ConnectionDiagnosticsPanel
            onCollect={async () => ({
              status: 'active',
              connections: [
                {
                  connectionNumber: 1,
                  participantName: '가온',
                  connectionState: 'connected',
                  localCandidateType: 'host',
                  remoteCandidateType: 'relay',
                  roundTripTimeMs: 30,
                  packetLossPercent: 0,
                  jitterMs: 4,
                },
              ],
            })}
          />,
        ),
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
});
