function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeMime(mimetype) {
  return String(mimetype || '').split(';')[0].trim().toLowerCase();
}

function withTimeout(promiseOrFactory, timeoutMs, label) {
  const work = typeof promiseOrFactory === 'function'
    ? Promise.resolve().then(promiseOrFactory)
    : promiseOrFactory;

  if (!timeoutMs || timeoutMs <= 0) return work;

  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`${label} excedeu ${timeoutMs}ms`);
      // Consumers must not need to parse a localized error message to decide
      // whether retrying would overlap an operation that is still running. A
      // Promise.race cannot cancel Puppeteer/Chromium work already dispatched.
      error.code = 'OPERATION_TIMEOUT';
      error.operation = label;
      error.timeoutMs = timeoutMs;
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([work, timeoutPromise]).finally(() => clearTimeout(timeout));
}

module.exports = {
  normalizeMime,
  sleep,
  withTimeout
};
