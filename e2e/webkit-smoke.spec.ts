import { expect, test } from '@playwright/test';

const ROOM_PATH = '/room/abcd-efgh-jkmp';

test('WebKit keeps a direct invite behind explicit pre-join media consent', async ({
  browserName,
  page,
}) => {
  expect(browserName).toBe('webkit');
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
