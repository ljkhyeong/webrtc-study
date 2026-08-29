import type { PrejoinMediaIssueCode } from '@round/rtc-core';

type MediaKind = 'audio' | 'video';

export function prejoinMediaIssueMessage(kind: MediaKind, code: PrejoinMediaIssueCode): string {
  const deviceName = kind === 'audio' ? '마이크' : '카메라';

  switch (code) {
    case 'permission-denied':
      return `${deviceName} 권한이 거부되었습니다. 브라우저 설정에서 허용한 뒤 다시 시도해 주세요.`;
    case 'device-not-found':
      return `사용할 수 있는 ${deviceName}를 찾지 못했습니다. 장치 연결 상태를 확인해 주세요.`;
    case 'device-busy':
      return `${deviceName}를 다른 앱이 사용 중입니다. 다른 앱을 닫은 뒤 다시 시도해 주세요.`;
    case 'track-ended':
      return `${deviceName} 연결이 종료되었습니다. 장치 연결 상태를 확인한 뒤 다시 시도해 주세요.`;
    case 'media-unavailable':
      return `${deviceName}를 열지 못했습니다. 장치와 브라우저 설정을 확인한 뒤 다시 시도해 주세요.`;
  }
}
