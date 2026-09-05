import { useEffect } from 'react';

export function useRoomShortcuts({
  active,
  audioAvailable,
  videoAvailable,
  onAudio,
  onVideo,
  onHand,
}: {
  active: boolean;
  audioAvailable: boolean;
  videoAvailable: boolean;
  onAudio: () => void;
  onVideo: () => void;
  onHand: () => void;
}) {
  useEffect(() => {
    let composing = false;
    const startComposition = () => {
      composing = true;
    };
    const endComposition = () => {
      composing = false;
    };
    const keydown = (event: KeyboardEvent) => {
      if (
        !active ||
        document.hidden ||
        event.defaultPrevented ||
        event.repeat ||
        composing ||
        event.isComposing ||
        event.keyCode === 229 ||
        !event.altKey ||
        !event.shiftKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
        )
      )
        return;
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      const action =
        event.code === 'KeyM' && audioAvailable
          ? onAudio
          : event.code === 'KeyC' && videoAvailable
            ? onVideo
            : event.code === 'KeyH'
              ? onHand
              : null;
      if (!action) return;
      event.preventDefault();
      action();
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('compositionstart', startComposition);
    document.addEventListener('compositionend', endComposition);
    window.addEventListener('blur', endComposition);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('compositionstart', startComposition);
      document.removeEventListener('compositionend', endComposition);
      window.removeEventListener('blur', endComposition);
    };
  }, [active, audioAvailable, videoAvailable, onAudio, onVideo, onHand]);
}
