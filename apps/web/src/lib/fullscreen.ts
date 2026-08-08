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

  if (typeof video.requestFullscreen === 'function') {
    try {
      await video.requestFullscreen();
      return true;
    } catch {
      // A browser can expose the standard API while rejecting it at runtime.
    }
  }

  if (typeof webkitVideo.webkitRequestFullscreen === 'function') {
    try {
      await webkitVideo.webkitRequestFullscreen();
      return true;
    } catch {
      // Some Safari versions still support only the native video fallback.
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
      // Report failure only after every compatible API has been attempted.
    }
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

  if (activeDocument?.fullscreenElement === video && activeDocument.exitFullscreen) {
    try {
      await activeDocument.exitFullscreen();
      return true;
    } catch {
      // Continue to prefixed APIs when the standard exit path is rejected.
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
      // Native video fullscreen may still own the active presentation.
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
      // Report failure only after every compatible API has been attempted.
    }
  }

  return false;
}
