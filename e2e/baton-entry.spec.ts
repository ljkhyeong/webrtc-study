import { expect, test } from '@playwright/test';

const ROOM_ID = 'abcd-efgh-jkmp';
const ROOM_PATH = `/room/${ROOM_ID}`;
const GRANT_ENDPOINT = `/round/rooms/${ROOM_ID}/participation-grant/refresh`;
const isProductionEdge = process.env.ROUND_BATON_E2E_EDGE === 'true';

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(window, '__roundGetUserMediaCalls', {
      configurable: true,
      value: 0,
      writable: true,
    });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => {
        const trackedWindow = window as Window & { __roundGetUserMediaCalls: number };
        trackedWindow.__roundGetUserMediaCalls += 1;
        throw new DOMException('No test device', 'NotFoundError');
      },
    });
    Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
      configurable: true,
      value: async () => [],
    });
  });
});

test('BATON authorizes the room before prejoin can request media', async ({ page }) => {
  let releaseGrant!: () => void;
  const grantReleased = new Promise<void>((resolve) => {
    releaseGrant = resolve;
  });
  await page.route('**/api/v1/auth/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: {
        authenticated: true,
        csrfHeaderName: 'X-CSRF-TOKEN',
        csrfToken: 'browser-test-csrf',
      },
      status: 200,
    });
  });
  await page.route(`**${GRANT_ENDPOINT}`, async (route) => {
    await grantReleased;
    await route.fulfill({
      contentType: 'application/json',
      json: {
        expiresAt: 1_800_000_000,
        refreshAfterSeconds: 240,
      },
      status: 200,
    });
  });

  await openBatonRoom(page);

  await expect(page.getByText('스터디 참여 권한을 확인하고 있습니다.')).toBeVisible();
  await expect(page.getByRole('button', { name: '장치 확인', exact: true })).toHaveCount(0);
  expect(await mediaRequestCount(page)).toBe(0);

  releaseGrant();
  await expect(page.getByRole('heading', { name: '입장 준비', exact: true })).toBeVisible();
  await expect(page.getByText('같이 공부할 사람만,')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '다른 방 만들기' })).toHaveCount(0);
  await page.getByLabel('내 이름').fill('BATON 스터디원');

  await expect(page.getByRole('heading', { name: '입장 준비' })).toBeVisible();
  expect(await mediaRequestCount(page)).toBe(0);

  await page.getByRole('button', { name: '장치 확인', exact: true }).click();
  await expect.poll(() => mediaRequestCount(page)).toBe(2);
});

test('BATON 401 keeps media closed and offers only the canonical room login return', async ({
  page,
}) => {
  await page.route('**/api/v1/auth/session', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      json: { authenticated: false },
      status: 200,
    });
  });

  await openBatonRoom(page);

  await expect(page.getByRole('heading', { name: 'BATON 로그인이 필요합니다.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'BATON 로그인' })).toHaveAttribute(
    'href',
    `/login?returnTo=${encodeURIComponent(ROOM_PATH)}`,
  );
  await expect(page.getByRole('button', { name: '장치 확인', exact: true })).toHaveCount(0);
  expect(await mediaRequestCount(page)).toBe(0);
  await expect(page.locator('body')).not.toContainText('browser-test-csrf');
});

async function mediaRequestCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () => (window as Window & { __roundGetUserMediaCalls: number }).__roundGetUserMediaCalls,
  );
}

async function openBatonRoom(page: import('@playwright/test').Page): Promise<void> {
  if (isProductionEdge) {
    await page.goto(ROOM_PATH);
    return;
  }

  await page.goto('/round-ui/');
  await page.evaluate((roomPath) => {
    window.history.replaceState(null, '', roomPath);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, ROOM_PATH);
}
