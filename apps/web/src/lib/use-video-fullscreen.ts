import { useEffect, useRef, useState, type RefObject } from 'react';
import { enterVideoFullscreen, exitVideoFullscreen, isVideoFullscreen } from './fullscreen';

// 공유 화면 타일의 전체 화면 상태. 요청은 하나씩 처리하고, 공유가 끝나면 열린 전체 화면을 닫으며
// 그 전에 시작한 요청의 결과는 반영하지 않는다.
export function useVideoFullscreen(
  active: boolean,
  stream: MediaStream | undefined,
  videoRef: RefObject<HTMLVideoElement | null>,
  tileRef: RefObject<HTMLElement | null>,
) {
  const requestPending = useRef(false);
  const shareGenerationRef = useRef(0);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const update = () => setOpen(isVideoFullscreen(video, tileRef.current ?? undefined));
    update();
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update);
    video.addEventListener('webkitbeginfullscreen', update);
    video.addEventListener('webkitendfullscreen', update);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update);
      video.removeEventListener('webkitbeginfullscreen', update);
      video.removeEventListener('webkitendfullscreen', update);
    };
  }, [stream, videoRef, tileRef]);

  useEffect(() => {
    const generation = shareGenerationRef.current + 1;
    shareGenerationRef.current = generation;
    if (active) {
      return () => {
        if (shareGenerationRef.current === generation) {
          shareGenerationRef.current += 1;
        }
      };
    }
    setError(null);
    const video = videoRef.current;
    if (video !== null) {
      void exitVideoFullscreen(video, undefined, tileRef.current ?? undefined);
    }
    return undefined;
  }, [active, videoRef, tileRef]);

  async function change() {
    const video = videoRef.current;
    if (video === null) {
      return;
    }
    const shareGeneration = shareGenerationRef.current;
    const container = tileRef.current ?? undefined;
    setError(null);
    if (isVideoFullscreen(video, container)) {
      const exited = await exitVideoFullscreen(video, undefined, container);
      if (shareGenerationRef.current !== shareGeneration) return;
      setOpen(isVideoFullscreen(video, container));
      if (!exited)
        setError('전체 화면을 닫지 못했습니다. Esc 또는 브라우저의 뒤로가기를 사용해 주세요.');
      return;
    }

    const entered = await enterVideoFullscreen(video, container);
    if (shareGenerationRef.current !== shareGeneration) {
      if (entered) await exitVideoFullscreen(video, undefined, container);
      return;
    }
    if (!entered) {
      setError(
        '화면 공유를 전체 화면으로 열지 못했습니다. 브라우저의 전체 화면 기능을 사용해 주세요.',
      );
    }
    setOpen(isVideoFullscreen(video, container));
  }

  async function toggle() {
    if (requestPending.current) return;
    requestPending.current = true;
    setPending(true);
    try {
      await change();
    } finally {
      requestPending.current = false;
      setPending(false);
    }
  }

  return { open, pending, error, toggle };
}
