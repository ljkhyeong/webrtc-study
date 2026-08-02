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

function resolvedDocument(documentRef?: Document): Document | undefined {
  if (documentRef !== undefined) {
    return documentRef;
  }
  return typeof document === 'undefined' ? undefined : document;
}

export async function enterVideoFullscreen(video: HTMLVideoElement): Promise<boolean> {
  const webkitVideo = video as WebkitFullscreenVideoElement;

  try {
    if (typeof video.requestFullscreen === 'function') {
      await video.requestFullscreen();
      return true;
    }
    if (typeof webkitVideo.webkitRequestFullscreen === 'function') {
      await webkitVideo.webkitRequestFullscreen();
      return true;
    }
    if (
      webkitVideo.webkitSupportsFullscreen !== false &&
      typeof webkitVideo.webkitEnterFullscreen === 'function'
    ) {
      webkitVideo.webkitEnterFullscreen();
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

export async function exitVideoFullscreen(
  video: HTMLVideoElement,
  documentRef?: Document,
): Promise<boolean> {
  const activeDocument = resolvedDocument(documentRef);
  const webkitVideo = video as WebkitFullscreenVideoElement;
  const webkitDocument = activeDocument as WebkitFullscreenDocument | undefined;

  try {
    if (activeDocument?.fullscreenElement === video && activeDocument.exitFullscreen) {
      await activeDocument.exitFullscreen();
      return true;
    }
    if (
      webkitDocument?.webkitFullscreenElement === video &&
      typeof webkitDocument.webkitExitFullscreen === 'function'
    ) {
      await webkitDocument.webkitExitFullscreen();
      return true;
    }
    if (
      webkitVideo.webkitDisplayingFullscreen === true &&
      typeof webkitVideo.webkitExitFullscreen === 'function'
    ) {
      webkitVideo.webkitExitFullscreen();
      return true;
    }
  } catch {
    return false;
  }

  return false;
}
