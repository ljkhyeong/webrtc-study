import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const ROOM_ID = 'abcd-efgh-jkmp';
const ROOM_PATH = `/room/${ROOM_ID}`;
const HOST_CAPABILITY = 'round-test-only-host-capability-not-a-secret';

interface BrowserFailure {
  readonly participant: string;
  readonly kind: 'console.error' | 'pageerror';
  readonly message: string;
}

async function createParticipant(
  browser: Browser,
  baseURL: string,
  participant: string,
  failures: BrowserFailure[],
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL,
    permissions: ['camera', 'microphone'],
  });
  try {
    await context.addInitScript(() => {
      const canvases = [] as HTMLCanvasElement[];
      Object.defineProperty(window, '__roundE2eDisplayCanvases', {
        configurable: true,
        value: canvases,
      });
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 360;
          const drawingContext = canvas.getContext('2d');
          if (drawingContext === null) {
            throw new Error('E2E display canvas is unavailable');
          }
          drawingContext.fillStyle = '#6d5dfc';
          drawingContext.fillRect(0, 0, canvas.width, canvas.height);
          drawingContext.fillStyle = '#ffffff';
          drawingContext.font = 'bold 48px sans-serif';
          drawingContext.fillText('ROUND SCREEN', 120, 195);
          canvases.push(canvas);
          return canvas.captureStream(5);
        },
      });
    });
    const page = await context.newPage();

    page.on('console', (message) => {
      if (message.type() === 'error') {
        failures.push({
          participant,
          kind: 'console.error',
          message: message.text(),
        });
      }
    });
    page.on('pageerror', (error) => {
      failures.push({
        participant,
        kind: 'pageerror',
        message: error.message,
      });
    });

    return { context, page };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function enterRoom(page: Page, displayName: string, hostCapability?: string): Promise<void> {
  await page.goto(ROOM_PATH);
  await page.getByLabel('내 이름').fill(displayName);
  await page.getByRole('button', { name: '입장 준비' }).click();
  await expect(
    page.getByRole('heading', { name: '입장 전에 장치를 확인해 주세요.' }),
  ).toBeVisible();

  if (hostCapability !== undefined) {
    await page.getByLabel('방장 키 (선택)').fill(hostCapability);
  }

  await page.getByRole('button', { name: '장치 확인' }).click();
  const joinButton = page.getByRole('button', { name: '이 설정으로 입장' });
  await expect(joinButton).toBeEnabled();
  await joinButton.click();
}

function participantTile(page: Page, displayName: string) {
  return page.getByRole('article', { name: `${displayName} 참가자`, exact: true });
}

async function remoteVideoHasVisibleContent(page: Page, displayName: string): Promise<boolean> {
  const video = participantTile(page, displayName).locator('video');
  if ((await video.count()) !== 1) {
    return false;
  }

  return video.evaluate((element) => {
    const videoElement = element as HTMLVideoElement;
    if (
      videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      videoElement.videoWidth === 0 ||
      videoElement.videoHeight === 0
    ) {
      return false;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 36;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) {
      return false;
    }
    context.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let visiblePixels = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if ((pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0) > 24) {
        visiblePixels += 1;
      }
    }
    return visiblePixels / (pixels.length / 4) > 0.02;
  });
}

async function expectRemoteMedia(page: Page, displayName: string): Promise<void> {
  const tile = participantTile(page, displayName);
  await expect(tile).toHaveCount(1);
  await expect
    .poll(async () => {
      const video = tile.locator('video');
      if ((await video.count()) !== 1) {
        return false;
      }
      return video.evaluate((element) => {
        const videoElement = element as HTMLVideoElement;
        const stream = videoElement.srcObject;
        return {
          audioFlowing:
            stream instanceof MediaStream &&
            stream
              .getAudioTracks()
              .some((track) => track.readyState === 'live' && track.muted === false),
          frameReady:
            videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            videoElement.videoWidth > 0 &&
            videoElement.videoHeight > 0,
          videoFlowing:
            stream instanceof MediaStream &&
            stream
              .getVideoTracks()
              .some((track) => track.readyState === 'live' && track.muted === false),
        };
      });
    })
    .toEqual({
      audioFlowing: true,
      frameReady: true,
      videoFlowing: true,
    });
  await expect.poll(() => remoteVideoHasVisibleContent(page, displayName)).toBe(true);
}

test('방장과 참가자가 미디어·화면 공유·채팅을 사용하고 정상 퇴장한다', async ({
  baseURL,
  browser,
}) => {
  if (baseURL === undefined) {
    throw new Error('Playwright baseURL is required');
  }

  const failures: BrowserFailure[] = [];
  const contexts: BrowserContext[] = [];

  try {
    const first = await createParticipant(browser, baseURL, '가온', failures);
    contexts.push(first.context);
    const second = await createParticipant(browser, baseURL, '나래', failures);
    contexts.push(second.context);

    await Promise.all([
      enterRoom(first.page, '가온', HOST_CAPABILITY),
      enterRoom(second.page, '나래'),
    ]);

    await Promise.all([
      expect(first.page.getByText('통화 연결됨', { exact: true })).toBeVisible(),
      expect(second.page.getByText('통화 연결됨', { exact: true })).toBeVisible(),
      expect(first.page.getByLabel('참가자 2명')).toBeVisible(),
      expect(second.page.getByLabel('참가자 2명')).toBeVisible(),
      expectRemoteMedia(first.page, '나래'),
      expectRemoteMedia(second.page, '가온'),
    ]);

    await expect(
      participantTile(second.page, '가온').getByText('방장', { exact: true }),
    ).toBeVisible();
    await expect(second.page.getByRole('button', { name: '가온 마이크 끄기' })).toHaveCount(0);

    await first.page.getByRole('button', { name: '화면 공유 시작' }).click();
    const firstTileOnSecondPage = participantTile(second.page, '가온');
    await expect(firstTileOnSecondPage.getByText('화면 공유 중')).toBeVisible();
    await expect(
      first.page.getByRole('button', { name: '화면 공유 중에는 카메라를 변경할 수 없음' }),
    ).toBeDisabled();
    await expect.poll(() => remoteVideoHasVisibleContent(second.page, '가온')).toBe(true);

    const remoteScreenVideo = firstTileOnSecondPage.locator('video');
    const remoteFullscreenButton = firstTileOnSecondPage.getByRole('button', {
      name: '가온의 화면 공유 전체 화면으로 보기',
    });
    await remoteScreenVideo.evaluate((element) => {
      const video = element as HTMLVideoElement & {
        webkitEnterFullscreen?: () => void;
        webkitRequestFullscreen?: () => Promise<void>;
        readonly webkitSupportsFullscreen?: boolean;
      };
      const recordAttempt = (name: string) => {
        const attempts = Number.parseInt(video.dataset[name] ?? '0', 10);
        video.dataset[name] = String(attempts + 1);
      };

      Object.defineProperties(video, {
        requestFullscreen: {
          configurable: true,
          value: async () => {
            recordAttempt('standardFullscreenAttempts');
            throw new DOMException('standard fullscreen denied', 'NotAllowedError');
          },
        },
        webkitRequestFullscreen: {
          configurable: true,
          value: async () => {
            recordAttempt('webkitRequestFullscreenAttempts');
            throw new DOMException('prefixed fullscreen denied', 'NotAllowedError');
          },
        },
        webkitSupportsFullscreen: {
          configurable: true,
          value: true,
        },
        webkitEnterFullscreen: {
          configurable: true,
          value: () => {
            recordAttempt('webkitEnterFullscreenAttempts');
          },
        },
      });
    });

    await remoteFullscreenButton.click();
    await expect(remoteScreenVideo).toHaveAttribute('data-standard-fullscreen-attempts', '1');
    await expect(remoteScreenVideo).toHaveAttribute('data-webkit-request-fullscreen-attempts', '1');
    await expect(remoteScreenVideo).toHaveAttribute('data-webkit-enter-fullscreen-attempts', '1');
    await expect(firstTileOnSecondPage.locator('.video-tile__fullscreen-error')).toHaveCount(0);

    await remoteScreenVideo.evaluate((element) => {
      const video = element as HTMLVideoElement & {
        webkitEnterFullscreen?: () => void;
        webkitRequestFullscreen?: () => Promise<void>;
      };
      const rejectFullscreen = () => {
        throw new DOMException('fullscreen denied', 'NotAllowedError');
      };

      delete video.dataset.standardFullscreenAttempts;
      delete video.dataset.webkitRequestFullscreenAttempts;
      delete video.dataset.webkitEnterFullscreenAttempts;
      Object.defineProperties(video, {
        requestFullscreen: {
          configurable: true,
          value: async () => {
            video.dataset.standardFullscreenAttempts = '1';
            rejectFullscreen();
          },
        },
        webkitRequestFullscreen: {
          configurable: true,
          value: async () => {
            video.dataset.webkitRequestFullscreenAttempts = '1';
            rejectFullscreen();
          },
        },
        webkitEnterFullscreen: {
          configurable: true,
          value: () => {
            video.dataset.webkitEnterFullscreenAttempts = '1';
            rejectFullscreen();
          },
        },
      });
    });

    await remoteFullscreenButton.click();
    await expect(remoteScreenVideo).toHaveAttribute('data-standard-fullscreen-attempts', '1');
    await expect(remoteScreenVideo).toHaveAttribute('data-webkit-request-fullscreen-attempts', '1');
    await expect(remoteScreenVideo).toHaveAttribute('data-webkit-enter-fullscreen-attempts', '1');
    await expect(
      firstTileOnSecondPage.getByRole('alert').filter({
        hasText:
          '화면 공유를 전체 화면으로 열지 못했습니다. 브라우저의 전체 화면 기능을 사용해 주세요.',
      }),
    ).toBeVisible();

    await first.page.getByRole('button', { name: '화면 공유 중지' }).click();
    await expect(firstTileOnSecondPage.getByText('화면 공유 중')).toHaveCount(0);
    await expect(firstTileOnSecondPage.locator('.video-tile__fullscreen-error')).toHaveCount(0);
    await expectRemoteMedia(second.page, '가온');

    expect(
      await first.page.locator('#chat-message').evaluate((element) => {
        (element as HTMLElement).focus();
        return document.activeElement === element;
      }),
    ).toBe(false);

    await first.page.getByRole('button', { name: '채팅 열기' }).click();
    const firstChatComposer = first.page.getByRole('textbox', { name: '메시지', exact: true });
    await firstChatComposer.fill('한글 조합 메시지');
    await firstChatComposer.dispatchEvent('compositionstart', { data: '지' });
    await firstChatComposer.dispatchEvent('keydown', {
      code: 'Enter',
      isComposing: true,
      key: 'Enter',
      keyCode: 229,
    });
    await expect(firstChatComposer).toHaveValue('한글 조합 메시지');
    await expect(
      first.page.locator('article.chat-message', { hasText: '한글 조합 메시지' }),
    ).toHaveCount(0);
    await expect(second.page.getByText('한글 조합 메시지', { exact: true })).toHaveCount(0);

    await firstChatComposer.dispatchEvent('compositionend', { data: '지' });
    await firstChatComposer.press('Enter');
    await expect(firstChatComposer).toHaveValue('');
    await expect(second.page.getByText('한글 조합 메시지', { exact: true })).toHaveCount(1);
    const composedOutgoingMessage = first.page.locator('article.chat-message', {
      hasText: '한글 조합 메시지',
    });
    await expect(composedOutgoingMessage).toHaveCount(1);
    await expect(composedOutgoingMessage).toHaveAttribute('data-delivery-state', 'sent');

    await firstChatComposer.fill('오늘 목표는 3장까지');
    await first.page.getByRole('button', { name: '메시지 보내기' }).click();

    await second.page.getByRole('button', { name: '채팅 열기' }).click();
    await expect(second.page.getByText('오늘 목표는 3장까지', { exact: true })).toHaveCount(1);
    const firstOutgoingMessage = first.page.locator('article.chat-message', {
      hasText: '오늘 목표는 3장까지',
    });
    await expect(firstOutgoingMessage).toHaveAttribute('data-delivery-state', 'sent');
    await expect(firstOutgoingMessage).not.toContainText('수신 확인 실패');

    await second.page
      .getByRole('textbox', { name: '메시지', exact: true })
      .fill('좋아요, 시작해요');
    await second.page.getByRole('button', { name: '메시지 보내기' }).click();
    await expect(first.page.getByText('좋아요, 시작해요', { exact: true })).toHaveCount(1);
    const secondOutgoingMessage = second.page.locator('article.chat-message', {
      hasText: '좋아요, 시작해요',
    });
    await expect(secondOutgoingMessage).toHaveAttribute('data-delivery-state', 'sent');
    await expect(secondOutgoingMessage).not.toContainText('수신 확인 실패');

    const secondTileOnFirstPage = participantTile(first.page, '나래');
    await first.page.getByRole('button', { name: '나래 마이크 끄기' }).click();
    await expect(
      second.page.getByRole('button', { name: '마이크 켜기', exact: true }),
    ).toBeVisible();
    await expect(secondTileOnFirstPage.getByLabel('마이크 꺼짐')).toBeVisible();
    await expect(
      second.page.getByText('방장이 마이크를 껐습니다. 필요하면 직접 다시 켤 수 있습니다.'),
    ).toBeVisible();
    await second.page.getByRole('button', { name: '마이크 켜기', exact: true }).click();
    await expect(secondTileOnFirstPage.getByLabel('마이크 켜짐')).toBeVisible();

    await second.page.getByRole('button', { name: '화면 공유 시작' }).click();
    await expect(secondTileOnFirstPage.getByText('화면 공유 중')).toBeVisible();
    await first.page.getByRole('button', { name: '나래 비디오 끄기' }).click();
    await expect(
      second.page.getByRole('button', { name: '카메라 켜기', exact: true }),
    ).toBeVisible();
    await expect(second.page.getByRole('button', { name: '화면 공유 시작' })).toBeVisible();
    await expect(secondTileOnFirstPage.getByText('화면 공유 중')).toHaveCount(0);
    await expect(secondTileOnFirstPage.getByLabel('나래의 카메라 꺼짐')).toBeVisible();
    await expect(
      second.page.getByText('방장이 비디오를 껐습니다. 필요하면 직접 다시 켤 수 있습니다.'),
    ).toBeVisible();
    await second.page.getByRole('button', { name: '카메라 켜기', exact: true }).click();
    await expectRemoteMedia(first.page, '나래');

    await first.page.getByRole('button', { name: '마이크 끄기', exact: true }).click();
    await expect(firstTileOnSecondPage.getByLabel('마이크 꺼짐')).toBeVisible();

    await first.page.getByRole('button', { name: '카메라 끄기', exact: true }).click();
    await expect(firstTileOnSecondPage.getByLabel('가온의 카메라 꺼짐')).toBeVisible();
    await expect.poll(() => remoteVideoHasVisibleContent(second.page, '가온')).toBe(false);

    await first.page.getByRole('button', { name: '마이크 켜기', exact: true }).click();
    await expect(firstTileOnSecondPage.getByLabel('마이크 켜짐')).toBeVisible();

    await first.page.getByRole('button', { name: '카메라 켜기', exact: true }).click();
    await expect(firstTileOnSecondPage.getByLabel('가온의 카메라 꺼짐')).toHaveCount(0);
    await expect.poll(() => remoteVideoHasVisibleContent(second.page, '가온')).toBe(true);
    await expectRemoteMedia(second.page, '가온');

    await first.page.getByRole('button', { name: '나가기', exact: true }).click();
    await expect(first.page.getByRole('button', { name: '새 스터디룸 만들기' })).toBeVisible();
    await expect(first.page).toHaveURL(new URL('/', baseURL).toString());
    await expect(participantTile(second.page, '가온')).toHaveCount(0);
    await expect(second.page.getByLabel('참가자 1명')).toBeVisible();
    await expect(second.page.getByText('입장 완료 · 대기 중', { exact: true })).toBeVisible();

    const secondLocalVideo = second.page
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
      second.page.getByText(
        '마이크 또는 카메라 연결이 종료되었습니다. 장치를 다시 선택하면 현재 방 연결을 새로 시작합니다.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      second.page.getByRole('button', { name: '마이크 장치 다시 선택', exact: true }),
    ).toBeVisible();
    await second.page.getByRole('button', { name: '장치 다시 선택', exact: true }).click();
    await expect(
      second.page.getByRole('heading', { name: '입장 전에 장치를 확인해 주세요.' }),
    ).toBeVisible();
    await expect(second.page.getByRole('button', { name: '장치 확인', exact: true })).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }

  expect(failures).toEqual([]);
});
