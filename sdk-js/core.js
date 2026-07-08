// Shared core for the browser and Node entrypoints. Each entry calls configure()
// with an environment-specific context provider and fetch options, then registers
// its own global error handlers.
let cfg = null;
let context = () => ({});
let fetchOpts = {};

export function configure(options, contextFn = () => ({}), extraFetchOpts = {}) {
  cfg = { environment: 'production', ...options };
  context = contextFn;
  fetchOpts = extraFetchOpts;
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

function send(payload) {
  if (!cfg) return;
  return fetch(cfg.endpoint, {
    method: 'POST',
    ...fetchOpts,
    headers: { 'Content-Type': 'application/json', Authorization: `DSN ${cfg.dsn}` },
    body: JSON.stringify({
      environment: cfg.environment,
      release: cfg.release,
      tags: cfg.tags,
      ...context(),
      ...payload,
    }),
    // never crash the host app over telemetry
  }).catch(() => {});
}
