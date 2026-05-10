/**
 * File Relationship Map
 * - Used by: src/index.js
 * - Depends on services assembled in index bootstrap:
 *   - URL shortener path: src/services/urlShortenerService.js
 *   - Order orchestration path: src/services/orderService.js + src/workflows/orderSaga.js
 * - Observability sink: src/observability/metricsRegistry.js
 */

const http = require("http");
const crypto = require("crypto");
const { URL } = require("url");
const { logger } = require("../common/logger");

const PUBLIC_ERROR_CODES = new Set([
  "bad_request",
  "invalid_json",
  "payload_too_large",
  "not_found",
  "rate_limited",
  "method_not_allowed",
  "unsupported_media_type",
  "order_not_found",
]);

function json(res, statusCode, body, extraHeaders = {}) {
  res.statusCode = statusCode;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function requestIdFrom(req) {
  // Accept upstream request IDs for trace continuity, but bound length to avoid log/header abuse.
  const raw = req.headers["x-request-id"];
  if (typeof raw === "string" && raw.trim().length > 0 && raw.length <= 128) {
    return raw.trim();
  }
  return crypto.randomUUID();
}

function clientIpFrom(req) {
  const forwardedFor = req.headers["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function ensureJsonRequest(req) {
  // POST endpoints in this lab accept JSON only. Rejecting early keeps handlers simple and predictable.
  const contentType = req.headers["content-type"] || "";
  if (contentType && !String(contentType).toLowerCase().startsWith("application/json")) {
    const err = new Error("Content-Type must be application/json");
    err.statusCode = 415;
    err.publicCode = "unsupported_media_type";
    throw err;
  }
}

async function parseJsonBody(req, maxBytes = 1024 * 64) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(err);
    };
    req.on("data", (chunk) => {
      if (settled) {
        return;
      }
      bytes += chunk.length;
      if (bytes > maxBytes) {
        const err = new Error("Payload too large");
        err.statusCode = 413;
        err.publicCode = "payload_too_large";
        fail(err);
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      if (!data) {
        settled = true;
        resolve({});
        return;
      }
      try {
        settled = true;
        resolve(JSON.parse(data));
      } catch {
        const err = new Error("Invalid JSON body");
        err.statusCode = 400;
        err.publicCode = "invalid_json";
        fail(err);
      }
    });
    req.on("error", fail);
  });
}

function createServer({ services }) {
  const {
    limiter,
    shortener,
    queue,
    cache,
    idempotency,
    ring,
    breaker,
    orderService,
    paymentService,
    inventoryService,
    eventBus,
    metrics,
  } = services;

  const server = http.createServer(async (req, res) => {
    const requestStart = Date.now();
    const requestId = requestIdFrom(req);
    res.setHeader("X-Request-Id", requestId);
    const requestLogger = logger.child({ requestId });
    const parsed = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = parsed.pathname;
    const method = req.method || "GET";
    const ip = clientIpFrom(req);
    let route = path;

    const clientKey = req.headers["x-client-id"] || ip;
    const rate = limiter.allow(clientKey, 1);
    if (!rate.allowed) {
      metrics.inc("http.rate_limited", 1, { path, method });
      requestLogger.warn("Request rate limited", {
        method,
        path,
        clientKey,
        retryAfterMs: rate.retryAfterMs,
      });
      return json(
        res,
        429,
        { error: "rate_limited", requestId, retryAfterMs: rate.retryAfterMs, remaining: rate.remaining },
        { "Retry-After": Math.ceil(rate.retryAfterMs / 1000) }
      );
    }

    try {
      requestLogger.debug("Request received", {
        method,
        path,
        ip,
        userAgent: req.headers["user-agent"] || "",
      });

      if (method === "GET" && path === "/health") {
        return json(res, 200, { ok: true, ts: Date.now(), requestId });
      }

      if (method === "GET" && path === "/metrics") {
        metrics.setGauge("queue.pending", queue.stats().pending);
        return json(res, 200, {
          cache: cache.stats(),
          limiter: limiter.stats(),
          queue: queue.stats(),
          idempotency: idempotency.stats(),
          ring: ring.snapshot(),
          breaker: breaker.snapshot(),
          shortener: shortener.stats(),
          orders: orderService.stats(),
          payment: paymentService.stats(),
          inventory: inventoryService.stats(),
          eventBus: eventBus.stats(),
          customMetrics: metrics.snapshot(),
        });
      }

      if (method === "POST" && path === "/shorten") {
        ensureJsonRequest(req);
        const body = await parseJsonBody(req);
        const result = await shortener.createShortUrl({
          longUrl: body.longUrl,
          requestId: body.requestId,
          userId: body.userId || "anonymous",
          ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : null,
        });
        return json(res, 201, {
          shortCode: result.code,
          shortUrl: `${parsed.origin}/r/${result.code}`,
          expiresAt: result.expiresAt,
          requestId,
        });
      }

      if (method === "GET" && path.startsWith("/r/")) {
        route = "/r/:code";
        const code = path.split("/")[2];
        const longUrl = await shortener.resolve(code, {
          userAgent: req.headers["user-agent"],
          ip,
          referrer: req.headers.referer || "",
        });
        requestLogger.info("Redirect resolved", { code, statusCode: 302 });
        res.writeHead(302, { Location: longUrl });
        res.end();
        return;
      }

      if (method === "POST" && path === "/tasks/email") {
        ensureJsonRequest(req);
        const body = await parseJsonBody(req);
        if (!body.to || !body.subject) {
          return json(res, 400, { error: "to and subject are required", requestId });
        }
        const id = queue.enqueue({
          type: "notification.email",
          payload: body,
          maxAttempts: 4,
          backoffMs: 100,
        });
        return json(res, 202, { taskId: id, requestId });
      }

      if (method === "POST" && path === "/orders") {
        ensureJsonRequest(req);
        const body = await parseJsonBody(req);
        const idempotencyKey = req.headers["x-idempotency-key"] || body.idempotencyKey;
        const result = await orderService.createOrder(body, idempotencyKey);
        return json(res, result.status === "CONFIRMED" ? 201 : 202, { ...result, requestId });
      }

      if (method === "GET" && path.startsWith("/orders/")) {
        route = "/orders/:id";
        const parts = path.split("/");
        const orderId = parts[2];
        const record = orderService.getOrder(orderId);
        if (!record) {
          return json(res, 404, { error: "order_not_found", requestId });
        }
        return json(res, 200, record);
      }

      if (method === "GET" && path === "/events/dead-letter") {
        return json(res, 200, { deadLetter: eventBus.deadLetter.slice(-50) });
      }

      if (method === "GET" && path === "/placement") {
        const key = parsed.searchParams.get("key") || "";
        if (!key) {
          return json(res, 400, { error: "query key is required", requestId });
        }
        return json(res, 200, {
          key,
          primary: ring.getNode(key),
          replicas: ring.getReplicas(key, 3),
        });
      }

      if (["POST", "PUT", "PATCH"].includes(method)) {
        // Drain unknown request bodies so keep-alive connections are not left in a bad state.
        req.resume();
      }
      return json(res, 404, { error: "not_found", requestId });
    } catch (error) {
      const statusCode = error.statusCode || (error.code === "CIRCUIT_OPEN" ? 503 : 500);
      const publicCode = error.publicCode || (PUBLIC_ERROR_CODES.has(error.message) ? error.message : null);
      const body =
        statusCode >= 500
          ? { error: "internal_server_error", requestId }
          : { error: publicCode || error.message, requestId };
      requestLogger[statusCode >= 500 ? "error" : "warn"]("Request failed", {
        method,
        path: route,
        statusCode,
        error,
      });
      return json(res, statusCode, body);
    } finally {
      const durationMs = Date.now() - requestStart;
      const statusCode = res.statusCode || 200;
      metrics.observeMs("http.request.duration_ms", Date.now() - requestStart, {
        method,
        path: route,
        statusCode,
      });
      metrics.inc("http.request.total", 1, { method, path: route, statusCode });
      requestLogger.info("Request completed", {
        method,
        path: route,
        statusCode,
        durationMs,
      });
    }
  });

  return server;
}

module.exports = { createServer, parseJsonBody };
