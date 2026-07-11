export interface ErrTapOptions {
  dsn: string;
  endpoint: string;
  environment?: string;
  release?: string;
  tags?: Record<string, unknown>;
  /** exit the process after reporting an uncaughtException (default true) */
  exitOnFatal?: boolean;
}

/** Extra fields merged into the event payload. `fingerprint` overrides server-side grouping. */
export interface CaptureExtra extends Record<string, unknown> {
  fingerprint?: string;
  tags?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export function init(options: ErrTapOptions): void;
export function captureException(error: Error, extra?: CaptureExtra): Promise<void>;
export function captureMessage(message: string, extra?: CaptureExtra): Promise<void>;
