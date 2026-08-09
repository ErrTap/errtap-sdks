import { Catch } from '@nestjs/common';
import { APP_FILTER, BaseExceptionFilter } from '@nestjs/core';
import {
  init,
  captureException,
  captureMessage,
  logger,
  resolveDsn,
} from '@errtap/node';

/**
 * Global filter: report every thrown exception, then let Nest render the response.
 * Applied via `Catch()` at runtime so this package stays plain ESM (no TS build).
 */
export class ErrTapExceptionFilter extends BaseExceptionFilter {
  catch(exception, host) {
    const status = typeof exception?.getStatus === 'function' ? exception.getStatus() : undefined;
    if (typeof status !== 'number' || status >= 500) {
      if (exception instanceof Error) {
        void captureException(exception);
      } else {
        void captureException(new Error(String(exception)));
      }
    }
    super.catch(exception, host);
  }
}
Catch()(ErrTapExceptionFilter);

export class ErrTapModule {
  /**
   * @param {import('@errtap/node').ErrTapOptions} options
   * @returns {import('@nestjs/common').DynamicModule}
   */
  static forRoot(options) {
    init({ exitOnFatal: false, ...options });
    return {
      module: ErrTapModule,
      global: true,
      providers: [{ provide: APP_FILTER, useClass: ErrTapExceptionFilter }],
    };
  }
}

export { init, captureException, captureMessage, logger, resolveDsn };
