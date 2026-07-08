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
    timeout = setTimeout(() => reject(new Error(`${label} excedeu ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([work, timeoutPromise]).finally(() => clearTimeout(timeout));
}

module.exports = {
  normalizeMime,
  sleep,
  withTimeout
};
