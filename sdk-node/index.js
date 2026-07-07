let cfg = null;

/**
 * @param {{ dsn: string, endpoint: string, environment?: string, release?: string, tags?: object, exitOnFatal?: boolean }} options
 */
export function init(options) {
  cfg = { environment: 'production', exitOnFatal: true, ...options };
  process.on('uncaughtException', async (err) => {
    await captureException(err);
    if (cfg.exitOnFatal) process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    reason instanceof Error
      ? captureException(reason)
      : captureMessage(`Unhandled rejection: ${String(reason)}`);
  });
}

/** @param {Error} error */
export function captureException(error, extra = {}) {
  return send({
    message: error.message || String(error),
    type: error.name || 'Error',
    stacktrace: error.stack,
    ...extra,
  });
}

export function captureMessage(message, extra = {}) {
  return send({ message, type: 'Message', ...extra });
}

async function send(payload) {
  if (!cfg) return;
  try {
    await fetch(cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `DSN ${cfg.dsn}` },
      body: JSON.stringify({
        environment: cfg.environment,
        release: cfg.release,
        tags: cfg.tags,
        context: { node: process.version, platform: process.platform },
        ...payload,
      }),
    });
  } catch {
    // never crash the host app over telemetry
  }
}
