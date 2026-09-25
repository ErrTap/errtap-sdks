export interface ErrTapOptions {
  /** URL DSN (`https://et_…@host`) or bare key (requires `endpoint`) */
  dsn: string;
  /** Override ingest URL; optional when `dsn` is a URL DSN */
  endpoint?: string;
  environment?: string;
  release?: string;
  tags?: Record<string, unknown>;
  /**
   * Report Core Web Vitals (LCP, CLS, INP, FCP, TTFB) once per page
   * view, when the page is first hidden (default true)
   */
  vitals?: boolean;
  /** Fraction of page views that report vitals, 0–1 (default 1) */
  vitalsSampleRate?: number;
}

/** Extra fields merged into the event payload. `fingerprint` overrides server-side grouping. */
export interface CaptureExtra extends Record<string, unknown> {
  fingerprint?: string;
  tags?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export function resolveDsn(
  dsn: string,
  endpointOverride?: string,
): { key: string; endpoint: string; logEndpoint: string } | null;

export function init(options: ErrTapOptions): void;
export function captureException(error: Error, extra?: CaptureExtra): Promise<void>;
export function captureMessage(message: string, extra?: CaptureExtra): Promise<void>;
/** Id of the most recent error sent by this SDK, for linking feedback to it. */
export function lastEventId(): string | undefined;
/** Send what the user was doing when it broke; linked to `eventId` (default: the last error sent). */
export function captureFeedback(feedback: {
  message: string;
  name?: string;
  email?: string;
  /** defaults to the current page in browsers */
  url?: string;
  eventId?: string;
}): Promise<void>;

export const logger: {
  debug(message: string, data?: Record<string, unknown>): Promise<void>;
  info(message: string, data?: Record<string, unknown>): Promise<void>;
  warn(message: string, data?: Record<string, unknown>): Promise<void>;
  warning(message: string, data?: Record<string, unknown>): Promise<void>;
  error(message: string, data?: Record<string, unknown>): Promise<void>;
};
