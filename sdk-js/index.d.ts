export interface ErrTapOptions {
  dsn: string;
  endpoint: string;
  environment?: string;
  release?: string;
  tags?: Record<string, unknown>;
  /** Node only: exit the process after reporting an uncaughtException (default true) */
  exitOnFatal?: boolean;
}

export function init(options: ErrTapOptions): void;
export function captureException(error: Error, extra?: Record<string, unknown>): Promise<void>;
export function captureMessage(message: string, extra?: Record<string, unknown>): Promise<void>;
