import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

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
  await expect(page.getByRole('heading', { name: '입장 준비' })).toBeVisible();

  if (hostCapability !== undefined) {
    await page.getByLabel('방장 키 (선택)').fill(hostCapability);
  }

  await page.getByRole('button', { name: '장치 확인' }).click();
  const joinButton = page.getByRole('button', { name: '이 설정으로 입장' });
  await expect(joinButton).toBeEnabled();
  await joinButton.click();
}

export function participantTile(page: Page, displayName: string) {
  return page.getByRole('article', { name: `${displayName} 참가자`, exact: true });
}

export async function remoteVideoHasVisibleContent(
  page: Page,
  displayName: string,
): Promise<boolean> {
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

export async function expectRemoteMedia(page: Page, displayName: string): Promise<void> {
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
      videoFlowing: true,
    });
  await expect.poll(() => remoteVideoHasVisibleContent(page, displayName)).toBe(true);
}

export interface ConnectedRoomParticipants {
  readonly first: Page;
  readonly second: Page;
}

export async function runConnectedRoom(
  browser: Browser,
  baseURL: string | undefined,
  scenario: (participants: ConnectedRoomParticipants) => Promise<void>,
): Promise<void> {
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
    ]);

    await scenario({ first: first.page, second: second.page });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }

  expect(failures).toEqual([]);
}
