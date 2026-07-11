import type { ErrTapOptions, CaptureExtra } from '@errtap/node';

export type { ErrTapOptions, CaptureExtra };

export declare function init(options: ErrTapOptions): void;
export {
  captureException,
  captureMessage,
  logger,
  resolveDsn,
} from '@errtap/node';
