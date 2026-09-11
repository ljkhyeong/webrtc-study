interface WebkitFullscreenVideoElement extends HTMLVideoElement {
  readonly webkitSupportsFullscreen?: boolean;
  readonly webkitDisplayingFullscreen?: boolean;
  webkitRequestFullscreen?: () => void | Promise<void>;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
}

interface WebkitFullscreenDocument extends Document {
  readonly webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void | Promise<void>;
}

export function isVideoFullscreen(video: HTMLVideoElement, container?: HTMLElement): boolean {
  const owner =
    document.fullscreenElement ?? (document as WebkitFullscreenDocument).webkitFullscreenElement;
  return (
    owner === video ||
    (container !== undefined && owner === container) ||
    (video as WebkitFullscreenVideoElement).webkitDisplayingFullscreen === true
  );
}

export async function enterVideoFullscreen(
  video: HTMLVideoElement,
  container?: HTMLElement,
): Promise<boolean> {
  const webkitVideo = video as WebkitFullscreenVideoElement;

  if (container && typeof container.requestFullscreen === 'function') {
    try {
      await container.requestFullscreen();
      return true;
    } catch {
      // 보기 도구를 함께 열 수 없으면 기존 영상 전체 화면으로 전환한다.
    }
  }

  if (typeof video.requestFullscreen === 'function') {
    try {
      await video.requestFullscreen();
      return true;
    } catch {
      // 브라우저가 표준 API를 제공하더라도 실행 중에는 호출을 거부할 수 있다.
    }
  }

  if (typeof webkitVideo.webkitRequestFullscreen === 'function') {
    try {
      await webkitVideo.webkitRequestFullscreen();
      return true;
    } catch {
      // 일부 Safari 버전은 브라우저 자체 비디오 전체 화면만 지원한다.
    }
  }

  if (
    webkitVideo.webkitSupportsFullscreen !== false &&
    typeof webkitVideo.webkitEnterFullscreen === 'function'
  ) {
    try {
      webkitVideo.webkitEnterFullscreen();
      return true;
    } catch {
      // 호환되는 모든 API를 시도한 뒤에만 실패를 반환한다.
    }
  }

  return false;
}

export async function exitVideoFullscreen(
  video: HTMLVideoElement,
  documentRef?: Document,
  container?: HTMLElement,
): Promise<boolean> {
  const activeDocument = documentRef ?? (typeof document === 'undefined' ? undefined : document);
  const webkitVideo = video as WebkitFullscreenVideoElement;
  const webkitDocument = activeDocument as WebkitFullscreenDocument | undefined;

  if (
    (activeDocument?.fullscreenElement === video ||
      (container && activeDocument?.fullscreenElement === container)) &&
    activeDocument?.exitFullscreen
  ) {
    try {
      await activeDocument.exitFullscreen();
      return true;
    } catch {
      // 표준 종료 경로가 거부되면 벤더 접두 API를 계속 시도한다.
    }
  }

  if (
    webkitDocument?.webkitFullscreenElement === video &&
    typeof webkitDocument.webkitExitFullscreen === 'function'
  ) {
    try {
      await webkitDocument.webkitExitFullscreen();
      return true;
    } catch {
      // 현재 화면은 브라우저 자체 비디오 전체 화면일 수 있다.
    }
  }

  if (
    webkitVideo.webkitDisplayingFullscreen === true &&
    typeof webkitVideo.webkitExitFullscreen === 'function'
  ) {
    try {
      webkitVideo.webkitExitFullscreen();
      return true;
    } catch {
      // 호환되는 모든 API를 시도한 뒤에만 실패를 반환한다.
    }
  }

  return false;
}
