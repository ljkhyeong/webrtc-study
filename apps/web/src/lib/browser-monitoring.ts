import type { ExceptionEvent, ExceptionStackFrame } from '@grafana/faro-web-sdk';

const ERROR_TYPES = [
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
];

function assetFrames(frames: readonly ExceptionStackFrame[]): ExceptionStackFrame[] {
  return frames.flatMap((frame) => {
    try {
      const url = new URL(frame.filename, location.origin);
      if (
        url.origin !== location.origin ||
        !url.pathname.startsWith(`${import.meta.env.BASE_URL}assets/`)
      ) {
        return [];
      }
      return [
        {
          filename: `${url.origin}${url.pathname}`,
          function: '',
          ...(frame.lineno === undefined ? {} : { lineno: frame.lineno }),
          ...(frame.colno === undefined ? {} : { colno: frame.colno }),
        },
      ];
    } catch {
      return [];
    }
  });
}

export async function startBrowserMonitoring(
  collectorUrl = import.meta.env.VITE_FARO_COLLECTOR_URL,
) {
  if (!collectorUrl?.trim()) return;
  try {
    const { initializeFaro, ErrorsInstrumentation, TransportItemType } =
      await import('@grafana/faro-web-sdk');
    const app = { name: 'round', version: import.meta.env.ROUND_WEB_BUILD_ID };
    const session = { id: crypto.randomUUID() };
    return initializeFaro({
      url: collectorUrl,
      app,
      metas: [{ session }],
      instrumentations: [new ErrorsInstrumentation()],
      preventGlobalExposure: true,
      beforeSend(item) {
        if (item.type !== TransportItemType.EXCEPTION) return null;
        const error = item.payload as ExceptionEvent;
        const type = ERROR_TYPES.includes(error.type) ? error.type : 'Error';
        return {
          type: item.type,
          meta: { app, session },
          payload: {
            type,
            value: type,
            timestamp: error.timestamp,
            stacktrace: { frames: assetFrames(error.stacktrace?.frames ?? []) },
          },
        };
      },
    });
  } catch {
    console.warn('브라우저 오류 수집을 시작하지 못했습니다.');
    return;
  }
}
