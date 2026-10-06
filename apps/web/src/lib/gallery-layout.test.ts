import { describe, expect, it } from 'vitest';
import { emptySeatCount, fitGallery } from './gallery-layout';

describe('fitGallery', () => {
  it('넓은 화면의 두 명은 나란히 두고 4:3보다 길쭉하게 자르지 않는다', () => {
    expect(fitGallery(2, 1232, 590, 14)).toEqual({ columns: 2, width: 609, height: 456 });
  });

  it('채팅을 열어 좁아진 두 명은 위아래로 16:9 타일을 둔다', () => {
    expect(fitGallery(2, 848, 590, 14)).toEqual({ columns: 1, width: 512, height: 288 });
  });

  it('중간 폭의 여섯 명은 띠처럼 납작해지지 않게 3열로 둔다', () => {
    expect(fitGallery(6, 912, 520, 14)).toEqual({ columns: 3, width: 294, height: 221 });
  });

  it('세로 화면의 여섯 명은 2열 정사각형에 가깝게 둔다', () => {
    expect(fitGallery(6, 374, 560, 8)).toEqual({ columns: 2, width: 182, height: 181 });
  });

  it('혼자일 때는 영역을 넘지 않는 16:9 타일 하나를 둔다', () => {
    expect(fitGallery(1, 1232, 590, 14)).toEqual({ columns: 1, width: 1048, height: 590 });
  });

  it('측정 전이나 참가자가 없으면 배치를 정하지 않는다', () => {
    expect(fitGallery(0, 1232, 590, 14)).toBeNull();
    expect(fitGallery(2, 0, 590, 14)).toBeNull();
  });
});

describe('emptySeatCount', () => {
  it('격자 마지막 줄에 남는 칸만 빈 좌석으로 센다', () => {
    expect(emptySeatCount(3, 2)).toBe(1);
    expect(emptySeatCount(5, 3)).toBe(1);
    expect(emptySeatCount(4, 2)).toBe(0);
    expect(emptySeatCount(2, 1)).toBe(0);
  });

  it('열 수를 모르면 빈 좌석을 두지 않는다', () => {
    expect(emptySeatCount(3, 0)).toBe(0);
  });
});
