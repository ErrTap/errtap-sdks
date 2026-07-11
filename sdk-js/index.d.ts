export interface ErrTapOptions {
  /** URL DSN (`https://et_…@host`) or bare key (requires `endpoint`) */
  dsn: string;
  /** Override ingest URL; optional when `dsn` is a URL DSN */
  endpoint?: string;
  environment?: string;
  release?: string;
  tags?: Record<string, unknown>;
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

export const logger: {
  debug(message: string, data?: Record<string, unknown>): Promise<void> | void;
  info(message: string, data?: Record<string, unknown>): Promise<void> | void;
  warn(message: string, data?: Record<string, unknown>): Promise<void> | void;
  warning(message: string, data?: Record<string, unknown>): Promise<void> | void;
  error(message: string, data?: Record<string, unknown>): Promise<void> | void;
};
