import type { ErrTapOptions, CaptureExtra } from '@errtap/node';

export type { ErrTapOptions, CaptureExtra };

export declare function init(options: ErrTapOptions): void;
export interface NextRequestErrorRequest {
  path?: string;
  method?: string;
}
export interface NextRequestErrorContext {
  routerKind?: string;
  routePath?: string;
  routeType?: string;
  renderSource?: string;
  renderType?: string;
  revalidateReason?: string;
}
export declare function onRequestError(
  error: unknown,
  request?: NextRequestErrorRequest,
  context?: NextRequestErrorContext,
): Promise<void>;
export {
  captureException,
  captureMessage,
  logger,
  resolveDsn,
} from '@errtap/node';
