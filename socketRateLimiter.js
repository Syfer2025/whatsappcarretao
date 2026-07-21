function createSocketRateLimiter({
  attempts = new Map(),
  windowMs,
  maxAttempts,
  now = Date.now
}) {
  function sweepExpired(currentTime = now()) {
    for (const [key, record] of attempts) {
      if (currentTime - record.startedAt >= windowMs) {
        attempts.delete(key);
      }
    }
  }

  function isLimited(key) {
    const currentTime = now();
    sweepExpired(currentTime);

    const record = attempts.get(key);
    if (!record) {
      attempts.set(key, { count: 1, startedAt: currentTime });
      return false;
    }

    record.count += 1;
    return record.count > maxAttempts;
  }

  return {
    isLimited,
    sweepExpired,
    size: () => attempts.size,
    attempts
  };
}

module.exports = {
  createSocketRateLimiter
};
