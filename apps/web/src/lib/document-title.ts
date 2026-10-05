// 통화 중 브라우저 탭 제목을 한곳에서 정한다.
// 타이머 종료 안내와 새 메시지 수가 서로의 제목을 덮어쓰거나 이전 값으로 되돌리지 않게 한다.
let baseTitle: string | null = null;
let notice: string | null = null;
let unreadCount = 0;

function render(): void {
  if (notice === null && unreadCount === 0) {
    if (baseTitle !== null) document.title = baseTitle;
    baseTitle = null;
    return;
  }
  baseTitle ??= document.title;
  const title = notice === null ? baseTitle : `${notice} · ROUND`;
  document.title = unreadCount > 0 ? `(${unreadCount > 99 ? '99+' : unreadCount}) ${title}` : title;
}

export function setDocumentTitleNotice(next: string | null): void {
  notice = next;
  render();
}

export function setDocumentTitleUnreadCount(count: number): void {
  unreadCount = Math.max(0, Math.floor(count));
  render();
}
