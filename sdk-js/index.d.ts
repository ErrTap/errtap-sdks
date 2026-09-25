export interface ErrTapOptions {
  /** URL DSN (`https://et_…@host`) or bare key (requires `endpoint`) */
  dsn: string;
  /** Override ingest URL; optional when `dsn` is a URL DSN */
  endpoint?: string;
  environment?: string;
  release?: string;
  tags?: Record<string, unknown>;
  /**
   * Browser only: report Core Web Vitals (LCP, CLS, INP, FCP, TTFB) once per page
   * view, when the page is first hidden (default true)
   */
  vitals?: boolean;
  /** Browser only: fraction of page views that report vitals, 0–1 (default 1) */
  vitalsSampleRate?: number;
  /** Node only: exit the process after reporting an uncaughtException (default true) */
  exitOnFatal?: boolean;
}

export function resolveDsn(
  dsn: string,
  endpointOverride?: string,
): { key: string; endpoint: string; logEndpoint: string } | null;

export function init(options: ErrTapOptions): void;
export function captureException(error: Error, extra?: Record<string, unknown>): Promise<void>;
export function captureMessage(message: string, extra?: Record<string, unknown>): Promise<void>;
/** Id of the most recent error sent by this SDK, for linking feedback. */
export function lastEventId(): string | undefined;
export function captureFeedback(feedback: {
  message: string;
  name?: string;
  email?: string;
  /** defaults to the current page in browsers */
  url?: string;
  /** defaults to lastEventId() */
  eventId?: string;
}): Promise<void>;

export const logger: {
  debug(message: string, data?: Record<string, unknown>): Promise<void> | void;
  info(message: string, data?: Record<string, unknown>): Promise<void> | void;
  warn(message: string, data?: Record<string, unknown>): Promise<void> | void;
  warning(message: string, data?: Record<string, unknown>): Promise<void> | void;
  error(message: string, data?: Record<string, unknown>): Promise<void> | void;
};
