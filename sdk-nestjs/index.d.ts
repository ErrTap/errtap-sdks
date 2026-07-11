import type { DynamicModule, ExceptionFilter } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import type { ErrTapOptions, CaptureExtra } from '@errtap/node';

export type { ErrTapOptions, CaptureExtra };
export {
  init,
  captureException,
  captureMessage,
  logger,
  resolveDsn,
} from '@errtap/node';

export declare class ErrTapExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void;
}

export declare class ErrTapModule {
  static forRoot(options: ErrTapOptions): DynamicModule;
}
