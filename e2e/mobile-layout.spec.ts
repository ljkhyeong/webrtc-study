import { expect, test } from '@playwright/test';

const ROOM_PATH = '/room/abcd-efgh-jkmp';

test('모바일에서 방 입장과 채팅 제어가 화면 안에 유지된다', async ({ page }) => {
  const failures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      failures.push(`console.error: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));

  await page.goto(ROOM_PATH);
  await page.getByLabel('내 이름').fill('모바일 스터디원');
  await page.getByRole('button', { name: '카메라·마이크 없이 입장' }).click();

  const controlDock = page.getByRole('contentinfo', { name: '통화 제어' });
  await expect(controlDock).toBeVisible();
  const moreMenu = page.locator('summary', { hasText: '더보기' });
  await moreMenu.click();
  await page.locator('summary', { hasText: '진단' }).click();
  const diagnosticsPanel = page.getByRole('region', { name: '연결 진단' });
  await expect(diagnosticsPanel).toBeVisible();
  expect(
    await diagnosticsPanel.evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= document.documentElement.clientWidth;
    }),
  ).toBe(true);
  // 모바일 더보기는 화면 아래에서 올라오는 메뉴이므로 닫은 뒤 다른 조작을 한다.
  await page.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(page.locator('details.more-menu')).not.toHaveAttribute('open');
  await page.getByRole('button', { name: '채팅 열기' }).click();
  await expect(page.getByRole('textbox', { name: '메시지' })).toBeVisible();
  await expect(
    page.getByRole('complementary').getByRole('button', { name: '채팅 닫기' }),
  ).toBeVisible();
  await expect(controlDock).toBeVisible();

  // 채팅 패널이 열리는 중간 좌표가 아니라 실제 표시된 배치를 확인한다.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dock = document.querySelector<HTMLElement>('.control-dock')?.getBoundingClientRect();
        const messageInput = document
          .querySelector<HTMLElement>('.chat-composer textarea')
          ?.getBoundingClientRect();
        const sendButton = document
          .querySelector<HTMLElement>('.chat-composer button')
          ?.getBoundingClientRect();
        return {
          documentFits:
            document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          dockFits:
            dock !== undefined &&
            dock.left >= 0 &&
            dock.right <= document.documentElement.clientWidth,
          composerControlsAboveDock:
            messageInput !== undefined &&
            sendButton !== undefined &&
            dock !== undefined &&
            Math.max(messageInput.bottom, sendButton.bottom) <= dock.top + 1,
        };
      }),
    )
    .toEqual({
      documentFits: true,
      dockFits: true,
      composerControlsAboveDock: true,
    });
  await page.setViewportSize({ width: 320, height: 740 });
  await moreMenu.click();
  await page.getByRole('button', { name: '마이크·카메라 바꾸기' }).click();
  const deviceDialog = page.getByRole('dialog', { name: '통화 장치 설정' });
  await expect(deviceDialog).toBeVisible();
  const narrowLayout = await page.evaluate(() => {
    const header = document.querySelector('.room-header__status')!.getBoundingClientRect();
    const dialog = document.querySelector('dialog')!.getBoundingClientRect();
    return {
      headerFits: header.left >= 0 && header.right <= innerWidth,
      dialogFits: dialog.left >= 0 && dialog.right <= innerWidth && dialog.bottom <= innerHeight,
    };
  });
  expect(narrowLayout).toEqual({ headerFits: true, dialogFits: true });
  await page.keyboard.press('Escape');
  await expect(deviceDialog).toHaveCount(0);
  expect(failures).toEqual([]);
});
