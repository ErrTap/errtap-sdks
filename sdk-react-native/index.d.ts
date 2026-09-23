export interface ErrTapOptions {
  /** URL DSN (`https://et_…@host`) or bare key (requires `endpoint`) */
  dsn: string;
  /** Override ingest URL; optional when `dsn` is a URL DSN */
  endpoint?: string;
  environment?: string;
  release?: string;
  tags?: Record<string, unknown>;
  /**
   * Key-value store for crash persistence, e.g. `@react-native-async-storage/async-storage`.
   * A fatal JS error is saved before it is sent; if the app dies first, it is sent on
   * the next launch. Without it, fatal reports rely on the (bounded) wait before exit.
   */
  storage?: {
    getItem(key: string): Promise<string | null> | string | null;
    setItem(key: string, value: string): Promise<void> | void;
    removeItem(key: string): Promise<void> | void;
  };
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
export function captureException(error: unknown, extra?: CaptureExtra): void;
export function captureMessage(message: string, extra?: CaptureExtra): void;

export const logger: {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  warning(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
};
