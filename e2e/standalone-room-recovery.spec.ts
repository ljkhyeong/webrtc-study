import { expect, test } from '@playwright/test';
import { expectRemoteMedia, participantTile, runConnectedRoom } from './standalone-room.fixture';

test('방장 제어와 참가자 퇴장 및 장치 종료를 복구한다', async ({ baseURL, browser }) => {
  await runConnectedRoom(browser, baseURL, async ({ first, second }) => {
    await expectRemoteMedia(first, '나래');
    const secondTileOnFirstPage = participantTile(first, '나래');
    await first.getByRole('button', { name: '나래 마이크 끄기' }).click();
    await expect(second.getByRole('button', { name: '마이크 켜기', exact: true })).toBeVisible();
    await expect(secondTileOnFirstPage.getByLabel('마이크 꺼짐')).toBeVisible();
    await expect(
      second.getByText('방장이 마이크를 껐습니다. 필요하면 직접 다시 켤 수 있습니다.'),
    ).toBeVisible();
    await second.getByRole('button', { name: '마이크 켜기', exact: true }).click();
    await expect(secondTileOnFirstPage.getByLabel('마이크 켜짐')).toBeVisible();

    await second.getByRole('button', { name: '화면 공유 시작' }).click();
    await expect(secondTileOnFirstPage.getByText('화면 공유 중')).toBeVisible();
    await first.getByRole('button', { name: '나래 영상 끄기' }).click();
    await expect(second.getByRole('button', { name: '카메라 켜기', exact: true })).toBeVisible();
    await expect(second.getByRole('button', { name: '화면 공유 시작' })).toBeVisible();
    await expect(secondTileOnFirstPage.getByText('화면 공유 중')).toHaveCount(0);
    await expect(secondTileOnFirstPage.getByLabel('나래의 카메라 꺼짐')).toBeVisible();
    await expect(
      second.getByText('방장이 영상을 껐습니다. 필요하면 직접 다시 켤 수 있습니다.'),
    ).toBeVisible();
    await second.getByRole('button', { name: '카메라 켜기', exact: true }).click();
    await expectRemoteMedia(first, '나래');

    const diagnosticsSummary = second.locator('summary', { hasText: '진단' });
    await diagnosticsSummary.click();
    await expect(second.getByText('가온 · 연결 1', { exact: true })).toBeVisible();
    await expect(second.locator('.connection-diagnostics time')).toHaveAttribute(
      'datetime',
      /^\d{4}-\d{2}-\d{2}T.*Z$/,
    );

    await first.getByRole('button', { name: '나가기', exact: true }).click();
    await expect(first.getByRole('button', { name: '새 스터디룸 만들기' })).toBeVisible();
    await expect(first).toHaveURL(new URL('/', baseURL!).toString());
    await expect(participantTile(second, '가온')).toHaveCount(0);
    await expect(second.getByLabel('참가자 1명')).toBeVisible();
    await expect(second.getByText('다른 참가자를 기다리는 중', { exact: true })).toBeVisible();
    await expect(
      second.getByText('참가자 연결이 바뀌었습니다. 다시 측정해 주세요.', { exact: true }),
    ).toBeVisible();
    await diagnosticsSummary.click();

    const secondLocalVideo = second
      .getByRole('article', { name: '나래 (나) 참가자', exact: true })
      .locator('video');
    await secondLocalVideo.evaluate((element) => {
      const stream = (element as HTMLVideoElement).srcObject;
      if (!(stream instanceof MediaStream)) {
        throw new Error('Local media stream is unavailable');
      }
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack === undefined) {
        throw new Error('Local audio track is unavailable');
      }
      audioTrack.stop();
      audioTrack.dispatchEvent(new Event('ended'));
    });
    await expect(
      second.getByText(
        '마이크 또는 카메라 연결이 종료되었습니다. 통화를 유지한 채 장치를 다시 선택할 수 있습니다.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      second.getByRole('button', { name: '마이크 장치 다시 선택', exact: true }),
    ).toBeVisible();
    await second.getByRole('button', { name: '장치 다시 선택', exact: true }).click();
    await expect(second.getByRole('dialog', { name: '통화 장치 설정' })).toBeVisible();
    await second.getByRole('button', { name: '마이크 적용' }).click();
    await expect(
      second.getByRole('status').filter({ hasText: '마이크를 변경했습니다.' }),
    ).toBeVisible();
    await second.getByRole('button', { name: '장치 설정 닫기' }).click();
    await expect(second.getByRole('button', { name: '마이크 끄기', exact: true })).toBeVisible();
    await expect(second.getByLabel('참가자 1명')).toBeVisible();
    await expect(second.getByRole('button', { name: '장치 다시 선택', exact: true })).toHaveCount(
      0,
    );
  });
});
