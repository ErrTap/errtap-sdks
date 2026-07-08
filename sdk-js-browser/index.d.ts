export interface ErrTapOptions {
  dsn: string;
  endpoint: string;
  environment?: string;
  release?: string;
  tags?: Record<string, unknown>;
}

export function init(options: ErrTapOptions): void;
export function captureException(error: Error, extra?: Record<string, unknown>): void;
export function captureMessage(message: string, extra?: Record<string, unknown>): void;
