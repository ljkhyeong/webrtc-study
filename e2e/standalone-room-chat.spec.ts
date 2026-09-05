import { expect, test } from '@playwright/test';
import { runConnectedRoom } from './standalone-room.fixture';

test('한글 조합 입력과 양방향 채팅 전송 상태를 처리한다', async ({ baseURL, browser }) => {
  await runConnectedRoom(browser, baseURL, async ({ first, second }) => {
    expect(
      await first.locator('#chat-message').evaluate((element) => {
        (element as HTMLElement).focus();
        return document.activeElement === element;
      }),
    ).toBe(false);

    await first.getByRole('button', { name: '채팅 열기' }).click();
    const firstChatComposer = first.getByRole('textbox', { name: '메시지', exact: true });
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
      first.locator('article.chat-message', { hasText: '한글 조합 메시지' }),
    ).toHaveCount(0);
    await expect(second.getByText('한글 조합 메시지', { exact: true })).toHaveCount(0);

    await firstChatComposer.dispatchEvent('compositionend', { data: '지' });
    await firstChatComposer.press('Enter');
    await expect(firstChatComposer).toHaveValue('');
    await expect(second.getByText('한글 조합 메시지', { exact: true })).toHaveCount(1);
    const composedOutgoingMessage = first.locator('article.chat-message', {
      hasText: '한글 조합 메시지',
    });
    await expect(composedOutgoingMessage).toHaveCount(1);
    await expect(composedOutgoingMessage).toHaveAttribute('data-delivery-state', 'sent');

    await firstChatComposer.fill('오늘 목표는 3장까지');
    await first.getByRole('button', { name: '메시지 보내기' }).click();

    await second.getByRole('button', { name: '채팅 열기' }).click();
    await expect(second.getByText('오늘 목표는 3장까지', { exact: true })).toHaveCount(1);
    const firstOutgoingMessage = first.locator('article.chat-message', {
      hasText: '오늘 목표는 3장까지',
    });
    await expect(firstOutgoingMessage).toHaveAttribute('data-delivery-state', 'sent');
    await expect(firstOutgoingMessage).not.toContainText('수신 미확인');

    await second.getByRole('textbox', { name: '메시지', exact: true }).fill('좋아요, 시작해요');
    await second.getByRole('button', { name: '메시지 보내기' }).click();
    await expect(first.getByText('좋아요, 시작해요', { exact: true })).toHaveCount(1);
    const secondOutgoingMessage = second.locator('article.chat-message', {
      hasText: '좋아요, 시작해요',
    });
    await expect(secondOutgoingMessage).toHaveAttribute('data-delivery-state', 'sent');
    await expect(secondOutgoingMessage).not.toContainText('수신 미확인');

    const secondComposer = second.getByRole('textbox', { name: '메시지', exact: true });
    for (let index = 0; index < 8; index += 1) {
      await secondComposer.fill(`이전 대화 ${index} ${'내용을 확인합니다. '.repeat(30)}`);
      await secondComposer.press('Enter');
    }
    await expect(first.locator('article.chat-message')).toHaveCount(11);
    const messages = first.locator('.chat-messages');
    expect(await messages.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    await expect
      .poll(() =>
        messages.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(32);
    await messages.evaluate((element) => {
      element.scrollTop = 80;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(
      first.getByRole('button', { name: '최신 대화로 이동', exact: true }),
    ).toBeVisible();
    const readingPosition = await messages.evaluate((element) => element.scrollTop);
    await secondComposer.fill('새 메시지가 와도 읽던 위치를 유지합니다.');
    await secondComposer.press('Enter');
    const latest = first.getByRole('button', {
      name: '새 메시지 1개 · 최신 대화로 이동',
      exact: true,
    });
    await expect(latest).toBeVisible();
    expect(await messages.evaluate((element) => element.scrollTop)).toBe(readingPosition);
    await latest.click();
    await expect(latest).toHaveCount(0);
    expect(
      await messages.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    ).toBeLessThanOrEqual(32);

    const sharedText = '스터디 자료\nhttps://example.test/guide?chapter=3';
    await secondComposer.fill(sharedText);
    await secondComposer.press('Enter');
    const sharedMessage = first.locator('article.chat-message', { hasText: '스터디 자료' });
    const link = sharedMessage.getByRole('link');
    await expect(link).toHaveAttribute('href', 'https://example.test/guide?chapter=3');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(link).toHaveAttribute('target', '_blank');
    await first
      .context()
      .grantPermissions(['camera', 'microphone', 'clipboard-read', 'clipboard-write']);
    await sharedMessage.getByRole('button', { name: '메시지 복사' }).click();
    await expect(sharedMessage.getByRole('status')).toHaveText('메시지를 복사했습니다.');
    expect(await first.evaluate(() => navigator.clipboard.readText())).toBe(sharedText);

    await first
      .context()
      .route('https://example.test/**', (route) => route.fulfill({ body: '스터디 자료' }));
    const roomUrl = first.url();
    const opened = first.waitForEvent('popup');
    await link.click();
    const popup = await opened;
    await popup.waitForLoadState();
    expect(await popup.evaluate(() => window.opener === null && document.referrer === '')).toBe(
      true,
    );
    expect(first.url()).toBe(roomUrl);
    await popup.close();
  });
});
