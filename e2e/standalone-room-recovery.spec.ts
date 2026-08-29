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
    await first.getByRole('button', { name: '나래 비디오 끄기' }).click();
    await expect(second.getByRole('button', { name: '카메라 켜기', exact: true })).toBeVisible();
    await expect(second.getByRole('button', { name: '화면 공유 시작' })).toBeVisible();
    await expect(secondTileOnFirstPage.getByText('화면 공유 중')).toHaveCount(0);
    await expect(secondTileOnFirstPage.getByLabel('나래의 카메라 꺼짐')).toBeVisible();
    await expect(
      second.getByText('방장이 비디오를 껐습니다. 필요하면 직접 다시 켤 수 있습니다.'),
    ).toBeVisible();
    await second.getByRole('button', { name: '카메라 켜기', exact: true }).click();
    await expectRemoteMedia(first, '나래');

    await first.getByRole('button', { name: '나가기', exact: true }).click();
    await expect(first.getByRole('button', { name: '새 스터디룸 만들기' })).toBeVisible();
    await expect(first).toHaveURL(new URL('/', baseURL!).toString());
    await expect(participantTile(second, '가온')).toHaveCount(0);
    await expect(second.getByLabel('참가자 1명')).toBeVisible();
    await expect(second.getByText('입장 완료 · 대기 중', { exact: true })).toBeVisible();

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
      audioTrack.dispatchEvent(new Event('ended'));
    });
    await expect(
      second.getByText(
        '마이크 또는 카메라 연결이 종료되었습니다. 장치를 다시 선택하면 현재 방 연결을 새로 시작합니다.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      second.getByRole('button', { name: '마이크 장치 다시 선택', exact: true }),
    ).toBeVisible();
    await second.getByRole('button', { name: '장치 다시 선택', exact: true }).click();
    await expect(
      second.getByRole('heading', { name: '입장 전에 장치를 확인해 주세요.' }),
    ).toBeVisible();
    await expect(second.getByRole('button', { name: '장치 확인', exact: true })).toBeVisible();
  });
});
