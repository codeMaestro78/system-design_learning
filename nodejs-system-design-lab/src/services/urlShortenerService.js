/**
 * File Relationship Map
 * - Used by: src/http/server.js
 * - Depends on:
 *   - src/cache/lruCache.js
 *   - src/distributed/idempotencyStore.js
 *   - src/queue/taskQueue.js
 *   - src/resilience/circuitBreaker.js
 * - Provides: create/resolve short URL path with async analytics enqueue
 */

const crypto = require("crypto");
const { logger } = require("../common/logger");
const { retryWithBackoff } = require("../resilience/retry");

class UrlShortenerService {
  constructor({ cache, idempotencyStore, analyticsQueue, circuitBreaker }) {
    this.cache = cache;
    this.idempotencyStore = idempotencyStore;
    this.analyticsQueue = analyticsQueue;
    this.circuitBreaker = circuitBreaker;

    this.linksByCode = new Map();
    this.codeByLongUrl = new Map();
  }

  _generateCode(size = 7) {
    const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const bytes = crypto.randomBytes(size);
    let out = "";
    for (let i = 0; i < size; i += 1) {
      out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
  }

  _isValidUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  async createShortUrl({ longUrl, requestId, userId = "anonymous", ttlMs = null }) {
    if (!this._isValidUrl(longUrl)) {
      const err = new Error("Invalid URL");
      err.statusCode = 400;
      throw err;
    }
    if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      const err = new Error("ttlMs must be a positive number");
      err.statusCode = 400;
      throw err;
    }

    const idempotencyKey = requestId ? `shorten:${userId}:${requestId}` : null;
    if (idempotencyKey) {
      const begin = this.idempotencyStore.begin(idempotencyKey);
      if (!begin.allowed) {
        if (begin.status === "COMPLETED" && begin.response) {
          logger.info("Returning idempotent URL shortening response", {
            userId,
            requestId,
            code: begin.response.code,
          });
          return begin.response;
        }
        const err = new Error("Request already in progress");
        err.statusCode = 409;
        throw err;
      }
    }

    try {
      const existingCode = this.codeByLongUrl.get(longUrl);
      if (existingCode) {
        const existing = this.linksByCode.get(existingCode);
        if (existing) {
          if (existing.expiresAt !== null && existing.expiresAt <= Date.now()) {
            this.linksByCode.delete(existingCode);
            this.codeByLongUrl.delete(longUrl);
            this.cache.delete(`code:${existingCode}`);
            logger.info("Removed expired URL mapping before creating replacement", { code: existingCode, userId });
          } else {
            if (idempotencyKey) {
              this.idempotencyStore.complete(idempotencyKey, existing);
            }
            logger.info("Reused existing non-expired short URL", { code: existing.code, userId });
            return existing;
          }
        } else {
          this.codeByLongUrl.delete(longUrl);
        }
      }

      const result = await retryWithBackoff(async () => {
        let code = this._generateCode(7);
        let tries = 0;
        while (this.linksByCode.has(code) && tries < 5) {
          code = this._generateCode(7);
          tries += 1;
        }
        if (this.linksByCode.has(code)) {
          throw new Error("Unable to generate unique short code");
        }

        const record = {
          code,
          longUrl,
          createdAt: Date.now(),
          ownerId: userId,
          clicks: 0,
          expiresAt: ttlMs ? Date.now() + ttlMs : null,
        };
        this.linksByCode.set(code, record);
        this.codeByLongUrl.set(longUrl, code);
        this.cache.set(`code:${code}`, record, 5 * 60 * 1000);
        return record;
      });

      if (idempotencyKey) {
        this.idempotencyStore.complete(idempotencyKey, result);
      }
      logger.info("Created short URL", {
        code: result.code,
        userId,
        expiresAt: result.expiresAt,
      });
      return result;
    } catch (error) {
      if (idempotencyKey) {
        this.idempotencyStore.fail(idempotencyKey);
      }
      logger.warn("Short URL creation failed", { userId, requestId, error });
      throw error;
    }
  }

  _ensureNotExpired(record) {
    if (record.expiresAt !== null && record.expiresAt <= Date.now()) {
      const err = new Error("Short URL expired");
      err.statusCode = 410;
      throw err;
    }
  }

  async resolve(code, metadata = {}) {
    if (!code || typeof code !== "string") {
      const err = new Error("Short code is required");
      err.statusCode = 400;
      throw err;
    }
    const cacheKey = `code:${code}`;
    let record = this.cache.get(cacheKey);
    if (!record) {
      record = this.linksByCode.get(code);
      if (record) {
        this.cache.set(cacheKey, record, 5 * 60 * 1000);
      }
    }
    if (!record) {
      const err = new Error("Short URL not found");
      err.statusCode = 404;
      throw err;
    }
    this._ensureNotExpired(record);

    record.clicks += 1;
    // Analytics is intentionally async: redirect latency should not depend on the analytics pipeline.
    const event = {
      type: "URL_CLICK",
      ts: Date.now(),
      code,
      userAgent: metadata.userAgent ?? "unknown",
      ip: metadata.ip ?? "unknown",
      referrer: metadata.referrer ?? "",
    };

    await this.circuitBreaker.execute(async () => {
      this.analyticsQueue.enqueue({
        type: "analytics.click",
        payload: event,
      });
      return true;
    });

    return record.longUrl;
  }

  stats() {
    return {
      links: this.linksByCode.size,
      uniqueLongUrls: this.codeByLongUrl.size,
    };
  }
}

module.exports = { UrlShortenerService };
