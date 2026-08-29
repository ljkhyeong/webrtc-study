import { expect, test } from '@playwright/test';
import { expectRemoteMedia, participantTile, runConnectedRoom } from './standalone-room.fixture';

test('방장과 참가자가 미디어로 연결된다', async ({ baseURL, browser }) => {
  await runConnectedRoom(browser, baseURL, async ({ first, second }) => {
    await Promise.all([expectRemoteMedia(first, '나래'), expectRemoteMedia(second, '가온')]);
    await expect(participantTile(second, '가온').getByText('방장', { exact: true })).toBeVisible();
    await expect(second.getByRole('button', { name: '가온 마이크 끄기' })).toHaveCount(0);
  });
});
