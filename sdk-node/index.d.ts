export interface StackPulseOptions {
  dsn: string;
  endpoint: string;
  environment?: string;
  release?: string;
  tags?: Record<string, unknown>;
  /** exit the process after reporting an uncaughtException (default true) */
  exitOnFatal?: boolean;
}

export function init(options: StackPulseOptions): void;
export function captureException(error: Error, extra?: Record<string, unknown>): Promise<void>;
export function captureMessage(message: string, extra?: Record<string, unknown>): Promise<void>;
