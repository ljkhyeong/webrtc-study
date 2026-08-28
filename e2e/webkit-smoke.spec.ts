import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const ROOM_PATH = '/room/abcd-efgh-jkmp';

async function enterWithoutMedia(page: Page, displayName: string): Promise<void> {
  await page.goto(ROOM_PATH);
  await page.getByLabel('내 이름').fill(displayName);
  await page.getByRole('button', { name: '입장 준비' }).click();
  await page.getByRole('button', { name: '미디어 없이 입장' }).click();
  await expect(page.getByRole('contentinfo', { name: '통화 제어' })).toBeVisible();
}

test('WebKit keeps a direct invite behind explicit pre-join media consent', async ({ page }) => {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      failures.push(`console.error: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    failures.push(`pageerror: ${error.message}`);
  });

  await page.goto(ROOM_PATH);
  await page.getByLabel('내 이름').fill('사파리 스터디원');
  await page.getByRole('button', { name: '입장 준비' }).click();

  await expect(
    page.getByRole('heading', { name: '입장 전에 장치를 확인해 주세요.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '장치 확인', exact: true })).toBeVisible();
  await expect(
    page.getByText('장치를 확인하면 여기에 내 모습이 보입니다.', { exact: true }),
  ).toBeVisible();
  expect(
    await page
      .getByRole('region', { name: '내 카메라 미리보기' })
      .locator('video')
      .evaluate((video) => (video as HTMLVideoElement).srcObject),
  ).toBeNull();
  expect(failures).toEqual([]);
});

test('WebKit에서 미디어 없이 입장해 채팅하고 퇴장한다', async ({ baseURL, browser }) => {
  if (baseURL === undefined) {
    throw new Error('Playwright baseURL이 필요합니다.');
  }
  const failures: string[] = [];
  const contexts: BrowserContext[] = [];

  try {
    const firstContext = await browser.newContext({ baseURL });
    const secondContext = await browser.newContext({ baseURL });
    contexts.push(firstContext, secondContext);
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    for (const [name, page] of [
      ['첫 번째 참가자', first],
      ['두 번째 참가자', second],
    ] as const) {
      page.on('console', (message) => {
        if (message.type() === 'error') {
          failures.push(`${name} console.error: ${message.text()}`);
        }
      });
      page.on('pageerror', (error) => failures.push(`${name} pageerror: ${error.message}`));
    }

    await Promise.all([enterWithoutMedia(first, '가온'), enterWithoutMedia(second, '나래')]);
    await Promise.all([
      expect(first.getByLabel('참가자 2명')).toBeVisible(),
      expect(second.getByLabel('참가자 2명')).toBeVisible(),
    ]);

    await first.getByRole('button', { name: '채팅 열기' }).click();
    await first.getByRole('textbox', { name: '메시지' }).fill('WebKit 채팅 확인');
    await first.getByRole('button', { name: '메시지 보내기' }).click();
    await second.getByRole('button', { name: '채팅 열기' }).click();
    await expect(second.getByText('WebKit 채팅 확인', { exact: true })).toBeVisible();
    await expect(
      first.locator('article.chat-message', { hasText: 'WebKit 채팅 확인' }),
    ).toHaveAttribute('data-delivery-state', 'sent');

    await first.getByRole('button', { name: '나가기', exact: true }).click();
    await expect(second.getByLabel('참가자 1명')).toBeVisible();
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }

  expect(failures).toEqual([]);
});
