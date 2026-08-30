import { expect, test } from '@playwright/test';
import {
  expectRemoteMedia,
  participantTile,
  remoteVideoHasVisibleContent,
  runConnectedRoom,
} from './standalone-room.fixture';

test('미디어와 화면 공유를 전환한다', async ({ baseURL, browser }) => {
  await runConnectedRoom(browser, baseURL, async ({ first, second }) => {
    await expectRemoteMedia(second, '가온');
    const firstTileOnSecondPage = participantTile(second, '가온');
    await expect(firstTileOnSecondPage.getByText('방장', { exact: true })).toBeVisible();
    await expect(second.getByRole('button', { name: '가온 마이크 끄기' })).toHaveCount(0);

    await first.getByRole('button', { name: '화면 공유 시작' }).click();
    await expect(firstTileOnSecondPage.getByText('화면 공유 중')).toBeVisible();
    await expect(
      first.getByRole('button', { name: '화면 공유 중에는 카메라를 변경할 수 없음' }),
    ).toBeDisabled();
    await expect.poll(() => remoteVideoHasVisibleContent(second, '가온')).toBe(true);

    const remoteScreenVideo = firstTileOnSecondPage.locator('video');
    const originalVideo = await remoteScreenVideo.elementHandle();
    await firstTileOnSecondPage.getByRole('button', { name: '가온의 화면 공유 크게 고정' }).click();
    await expect(firstTileOnSecondPage).toHaveClass(/video-tile--pinned/);
    await second.getByRole('button', { name: '채팅 열기' }).click();
    await expect(second.getByRole('textbox', { name: '메시지', exact: true })).toBeVisible();
    expect(
      await remoteScreenVideo.evaluate((video, original) => video === original, originalVideo),
    ).toBe(true);
    await second.getByRole('complementary').getByRole('button', { name: '채팅 닫기' }).click();
    await originalVideo?.dispose();
    const remoteFullscreenButton = firstTileOnSecondPage.getByRole('button', {
      name: '가온의 화면 공유 전체 화면으로 보기',
    });
    await remoteScreenVideo.evaluate((element) => {
      Object.defineProperties(element, {
        requestFullscreen: {
          configurable: true,
          value: async () => {
            throw new DOMException('fullscreen denied', 'NotAllowedError');
          },
        },
        webkitRequestFullscreen: {
          configurable: true,
          value: undefined,
        },
        webkitEnterFullscreen: {
          configurable: true,
          value: undefined,
        },
      });
    });

    await remoteFullscreenButton.click();
    await expect(
      firstTileOnSecondPage.getByRole('alert').filter({
        hasText:
          '화면 공유를 전체 화면으로 열지 못했습니다. 브라우저의 전체 화면 기능을 사용해 주세요.',
      }),
    ).toBeVisible();

    await first.getByRole('button', { name: '화면 공유 중지' }).click();
    await expect(firstTileOnSecondPage.getByText('화면 공유 중')).toHaveCount(0);
    await expect(firstTileOnSecondPage).not.toHaveClass(/video-tile--pinned/);
    await expect(firstTileOnSecondPage.locator('.video-tile__fullscreen-error')).toHaveCount(0);
    await expectRemoteMedia(second, '가온');

    await first.getByRole('button', { name: '마이크 끄기', exact: true }).click();
    await expect(firstTileOnSecondPage.getByLabel('마이크 꺼짐')).toBeVisible();
    await first.getByRole('button', { name: '카메라 끄기', exact: true }).click();
    await expect(firstTileOnSecondPage.getByLabel('가온의 카메라 꺼짐')).toBeVisible();
    await expect.poll(() => remoteVideoHasVisibleContent(second, '가온')).toBe(false);

    await first.getByRole('button', { name: '마이크 켜기', exact: true }).click();
    await expect(firstTileOnSecondPage.getByLabel('마이크 켜짐')).toBeVisible();
    await first.getByRole('button', { name: '카메라 켜기', exact: true }).click();
    await expect(firstTileOnSecondPage.getByLabel('가온의 카메라 꺼짐')).toHaveCount(0);
    await expectRemoteMedia(second, '가온');

    const localTracks = await first
      .getByRole('article', { name: '가온 (나) 참가자', exact: true })
      .locator('video')
      .evaluateHandle((video) => (video.srcObject as MediaStream).getTracks());
    const remoteTrackIds = await firstTileOnSecondPage
      .locator('video')
      .evaluate((video) => (video.srcObject as MediaStream).getTracks().map((track) => track.id));
    await first.getByRole('button', { name: '통화 장치 설정' }).click();
    await first.getByRole('button', { name: '마이크 적용' }).click();
    await expect(
      first.getByRole('status').filter({ hasText: '마이크를 변경했습니다.' }),
    ).toBeVisible();
    await first.getByRole('button', { name: '카메라 적용' }).click();
    await expect(
      first.getByRole('status').filter({ hasText: '카메라를 변경했습니다.' }),
    ).toBeVisible();
    await first.getByRole('button', { name: '장치 설정 닫기' }).click();
    expect(await localTracks.evaluate((tracks) => tracks.map((track) => track.readyState))).toEqual(
      ['ended', 'ended'],
    );
    await localTracks.dispose();
    await expectRemoteMedia(second, '가온');
    expect(
      await firstTileOnSecondPage
        .locator('video')
        .evaluate((video) => (video.srcObject as MediaStream).getTracks().map((track) => track.id)),
    ).toEqual(remoteTrackIds);
    await first.getByRole('button', { name: '채팅 열기' }).click();
    await second.getByRole('button', { name: '채팅 열기' }).click();
    await first
      .getByRole('textbox', { name: '메시지' })
      .fill('장치 교체 후에도 대화를 이어갑니다.');
    await first.getByRole('button', { name: '메시지 보내기' }).click();
    await expect(
      second.getByText('장치 교체 후에도 대화를 이어갑니다.', { exact: true }),
    ).toBeVisible();
  });
});
