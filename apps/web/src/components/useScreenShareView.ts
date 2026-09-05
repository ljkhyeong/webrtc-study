import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type RefObject,
} from 'react';

const INITIAL_VIEW = { scale: 1, x: 0.5, y: 0.5 };
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function useScreenShareView(
  active: boolean,
  stream: MediaStream | undefined,
  videoRef: RefObject<HTMLVideoElement | null>,
) {
  const [view, setView] = useState(INITIAL_VIEW);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState({ width: 1, height: 1 });
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  useEffect(() => {
    setView(INITIAL_VIEW);
    drag.current = null;
  }, [active, stream]);
  useEffect(() => {
    const viewport = viewportRef.current;
    const video = videoRef.current;
    if (!active || !viewport || !video) return;
    const measure = () => {
      if (
        !video.videoWidth ||
        !video.videoHeight ||
        !viewport.clientWidth ||
        !viewport.clientHeight
      )
        return;
      const ratio =
        video.videoWidth / video.videoHeight / (viewport.clientWidth / viewport.clientHeight);
      setContent({ width: Math.min(1, ratio), height: Math.min(1, 1 / ratio) });
    };
    measure();
    video.addEventListener('loadedmetadata', measure);
    video.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    return () => {
      video.removeEventListener('loadedmetadata', measure);
      video.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, [active, stream, videoRef]);
  const scale = active ? view.scale : 1;
  const overflowX = Math.max(0, content.width * scale - 1);
  const overflowY = Math.max(0, content.height * scale - 1);
  const reset = () => setView(INITIAL_VIEW);
  const zoom = (step: number) =>
    setView((current) => {
      const next = Math.max(1, Math.min(4, current.scale + step));
      return next === 1 ? INITIAL_VIEW : { ...current, scale: next };
    });

  const viewportProps: HTMLAttributes<HTMLDivElement> = {
    tabIndex: active ? 0 : undefined,
    onPointerDown: (event) => {
      if (scale === 1 || !event.isPrimary || event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    },
    onPointerMove: (event) => {
      const previous = drag.current;
      if (!previous || previous.id !== event.pointerId || scale === 1) return;
      const { clientWidth: width, clientHeight: height } = event.currentTarget;
      if (!width || !height) return;
      const dx = overflowX > 0 ? (event.clientX - previous.x) / (width * overflowX) : 0;
      const dy = overflowY > 0 ? (event.clientY - previous.y) / (height * overflowY) : 0;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      setView((current) => ({ ...current, x: clamp(current.x - dx), y: clamp(current.y - dy) }));
    },
    onPointerUp: (event) => {
      if (drag.current?.id !== event.pointerId) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      drag.current = null;
    },
    onLostPointerCapture: () => {
      drag.current = null;
    },
    onPointerCancel: () => {
      drag.current = null;
    },
    onKeyDown: (event) => {
      if (!active || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === '+' || event.key === '=') zoom(0.5);
      else if (event.key === '-') zoom(-0.5);
      else if (event.key === '0') reset();
      else if (
        scale > 1 &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
      ) {
        setView((current) => ({
          ...current,
          x: clamp(
            current.x + (event.key === 'ArrowLeft' ? -0.1 : event.key === 'ArrowRight' ? 0.1 : 0),
          ),
          y: clamp(
            current.y + (event.key === 'ArrowUp' ? -0.1 : event.key === 'ArrowDown' ? 0.1 : 0),
          ),
        }));
      } else return;
      event.preventDefault();
    },
  };
  const videoStyle: CSSProperties | undefined = active
    ? {
        width: `${scale * 100}%`,
        height: `${scale * 100}%`,
        left: `${-(scale - 1) * 50 - (view.x - 0.5) * overflowX * 100}%`,
        top: `${-(scale - 1) * 50 - (view.y - 0.5) * overflowY * 100}%`,
      }
    : undefined;
  return { scale, zoom, reset, viewportRef, viewportProps, videoStyle };
}
