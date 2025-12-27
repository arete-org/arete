/**
 * @description: Simple in-memory rate limiter for backend endpoints.
 * @arete-scope: utility
 * @arete-module: SimpleRateLimiter
 * @arete-risk: low - Rate limiter failures could allow abuse but not data loss.
 * @arete-ethics: moderate - Rate limiting protects fair access and abuse prevention.
 */
// --- Types ---
type RateLimiterOptions = {
  limit: number;
  window: number;
};

type RateLimitResult = {
  allowed: boolean;
  retryAfter: number;
};

// --- In-memory rate limiter ---
class SimpleRateLimiter {
  private readonly limit: number;
  private readonly window: number;
  private readonly requests: Map<string, number[]>;

  constructor(options: RateLimiterOptions) {
    this.limit = options.limit;
    this.window = options.window;
    this.requests = new Map();
  }

  check(identifier: string): RateLimitResult {
    // Sliding window over timestamps; prune on each check.
    const now = Date.now();
    const userRequests = this.requests.get(identifier) || [];
    const validRequests = userRequests.filter(time => now - time < this.window);

    if (validRequests.length >= this.limit) {
      // Compute retry-after in seconds based on oldest allowed timestamp.
      const oldestRequest = Math.min(...validRequests);
      const retryAfter = Math.ceil((oldestRequest + this.window - now) / 1000);
      return { allowed: false, retryAfter };
    }

    // Store the current request timestamp.
    validRequests.push(now);
    this.requests.set(identifier, validRequests);

    return { allowed: true, retryAfter: 0 };
  }

  cleanup(): void {
    // Periodic sweep to drop stale identifiers.
    const now = Date.now();
    for (const [identifier, requests] of this.requests.entries()) {
      const validRequests = requests.filter(time => now - time < this.window);
      if (validRequests.length === 0) {
        this.requests.delete(identifier);
      } else {
        this.requests.set(identifier, validRequests);
      }
    }
  }
}

export { SimpleRateLimiter };


