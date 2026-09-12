import { useEffect, useRef, useState, type RefObject } from 'react';

async function closePictureInPicture(video: HTMLVideoElement) {
  if (video.ownerDocument.pictureInPictureElement === video) {
    await video.ownerDocument.exitPictureInPicture();
  }
}

export function useVideoPictureInPicture(
  active: boolean,
  stream: MediaStream | undefined,
  videoRef: RefObject<HTMLVideoElement | null>,
) {
  const sessionRef = useRef<{ video: HTMLVideoElement; disposed: boolean } | null>(null);
  const requesting = useRef(false);
  const [supported, setSupported] = useState(false);
  const [ready, setReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    const available = Boolean(
      active &&
      video?.ownerDocument.pictureInPictureEnabled &&
      typeof video.requestPictureInPicture === 'function',
    );
    setSupported(available);
    setReady(false);
    setOpen(false);
    setPending(requesting.current);
    setError(null);
    if (!available || !video) return;

    const session = { video, disposed: false };
    sessionRef.current = session;
    const update = () => {
      setReady(video.readyState > 0 && video.videoWidth > 0);
      setOpen(video.ownerDocument.pictureInPictureElement === video);
    };
    const events = [
      'loadedmetadata',
      'resize',
      'emptied',
      'enterpictureinpicture',
      'leavepictureinpicture',
    ];
    events.forEach((event) => video.addEventListener(event, update));
    update();
    return () => {
      session.disposed = true;
      sessionRef.current = null;
      events.forEach((event) => video.removeEventListener(event, update));
      // 보기 창만 닫고 수신 스트림과 트랙은 기존 통화 세션이 관리한다.
      void closePictureInPicture(video).catch(() => {});
    };
  }, [active, stream, videoRef]);

  async function toggle() {
    const session = sessionRef.current;
    if (!session || requesting.current) return;
    const { video } = session;
    const closing = video.ownerDocument.pictureInPictureElement === video;
    requesting.current = true;
    setPending(true);
    setError(null);
    try {
      if (closing) {
        await closePictureInPicture(video);
      } else {
        await video.requestPictureInPicture();
        // 공유 종료·퇴장 이후에 완료된 열기 요청도 정리한다.
        if (session.disposed) await closePictureInPicture(video);
      }
    } catch {
      if (!session.disposed) {
        setError(
          closing
            ? '작은 창을 닫지 못했습니다. 창의 닫기 버튼을 사용해 주세요.'
            : '작은 창을 열지 못했습니다. 다시 시도해 주세요.',
        );
      }
    } finally {
      requesting.current = false;
      if (sessionRef.current) setPending(false);
    }
  }

  return { supported, ready, open, pending, error, toggle };
}
