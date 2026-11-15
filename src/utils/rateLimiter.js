function createRateLimiter(options = {}) {
  const windowMs = options.windowMs || 60 * 1000; // 1 minute default
  const maxRequests = options.maxRequests || 30;
  const message = options.message || 'Too many requests, please try again later.';

  const ipHits = new Map();

  // Periodic cleanup to avoid memory leak
  setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of ipHits.entries()) {
      const valid = timestamps.filter((t) => now - t < windowMs);
      if (valid.length === 0) {
        ipHits.delete(ip);
      } else {
        ipHits.set(ip, valid);
      }
    }
  }, windowMs * 2).unref();

  return function rateLimiterMiddleware(req, res, next) {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
    const now = Date.now();

    let timestamps = ipHits.get(ip) || [];
    timestamps = timestamps.filter((t) => now - t < windowMs);

    if (timestamps.length >= maxRequests) {
      const oldest = timestamps[0];
      const retryAfterSeconds = Math.ceil((windowMs - (now - oldest)) / 1000);
      res.setHeader('Retry-After', retryAfterSeconds);
      return res.status(429).json({
        success: false,
        error: message,
        retryAfterSeconds
      });
    }

    timestamps.push(now);
    ipHits.set(ip, timestamps);
    next();
  };
}

module.exports = {
  createRateLimiter
};
