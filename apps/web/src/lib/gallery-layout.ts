import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';

export interface GalleryLayout {
  readonly columns: number;
  readonly width: number;
  readonly height: number;
}

const WIDEST_RATIO = 16 / 9;

/**
 * 참가자 수와 영상 영역 크기에서 타일이 가장 크게 보이는 열 수와 타일 크기를 고른다.
 * 타일 비율은 가로 영역에서 4:3~16:9, 세로 영역에서 3:4~16:9로 제한해 영상이 과하게 잘리지 않게 한다.
 */
export function fitGallery(
  count: number,
  width: number,
  height: number,
  gap: number,
): GalleryLayout | null {
  if (count < 1 || width <= 0 || height <= 0) return null;
  const narrowestRatio = height > width ? 3 / 4 : 4 / 3;
  let best: GalleryLayout | null = null;
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - gap * (columns - 1)) / columns;
    const cellHeight = (height - gap * (rows - 1)) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;
    const ratio = Math.min(Math.max(cellWidth / cellHeight, narrowestRatio), WIDEST_RATIO);
    const tileWidth = Math.min(cellWidth, cellHeight * ratio);
    const tileHeight = tileWidth / ratio;
    if (best === null || tileWidth * tileHeight > best.width * best.height) {
      best = { columns, width: Math.floor(tileWidth), height: Math.floor(tileHeight) };
    }
  }
  return best;
}

/** 영상 영역의 안쪽 크기를 따라 갤러리 배치를 CSS 변수로 돌려준다. 측정할 수 없으면 CSS 기본 배치를 쓴다. */
export function useGalleryLayout(
  ref: RefObject<HTMLElement | null>,
  count: number,
  enabled: boolean,
): CSSProperties | undefined {
  const [layout, setLayout] = useState<GalleryLayout | null>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || element === null || typeof ResizeObserver === 'undefined') {
      setLayout(null);
      return;
    }
    const measure = () => {
      const style = getComputedStyle(element);
      const next = fitGallery(
        count,
        element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        parseFloat(style.columnGap) || 0,
      );
      setLayout((current) =>
        current?.columns === next?.columns &&
        current?.width === next?.width &&
        current?.height === next?.height
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, count, enabled]);

  return layout === null
    ? undefined
    : ({
        '--gallery-columns': layout.columns,
        '--tile-width': `${layout.width}px`,
        '--tile-height': `${layout.height}px`,
      } as CSSProperties);
}
