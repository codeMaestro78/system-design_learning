const http = require("http");

function safeJsonParse(input) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function request({ method = "GET", path = "/", body = null }) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "localhost",
        port: process.env.PORT || 3100,
        method,
        path,
        headers: {
          "Content-Type": "application/json",
          "x-client-id": "demo-client",
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (c) => {
          chunks += c.toString();
        });
        res.on("end", () => {
          const contentType = (res.headers["content-type"] || "").toLowerCase();
          const parsedBody =
            chunks && contentType.includes("application/json") ? safeJsonParse(chunks) : null;
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsedBody,
            rawBody: parsedBody === null ? chunks : null,
          });
        });
      }
    );
    req.on("error", reject);
    if (data) {
      req.write(data);
    }
    req.end();
  });
}

async function run() {
  console.log("1) health");
  const health = await request({ path: "/health" });
  console.log(health);
  if (health.statusCode !== 200 || !health.body || health.body.ok !== true) {
    throw new Error(
      "Demo target is not the lab server. Start lab with `npm start` (default PORT=3100) or run demo with matching PORT."
    );
  }

  console.log("2) shorten URL");
  const shorten = await request({
    method: "POST",
    path: "/shorten",
    body: {
      longUrl: "https://example.com/some/very/long/path?x=1",
      requestId: "req-1",
      userId: "user-42",
      ttlMs: 60_000,
    },
  });
  console.log(shorten);

  if (shorten.body && shorten.body.shortCode) {
    console.log("3) check placement");
    console.log(await request({ path: `/placement?key=${shorten.body.shortCode}` }));
  }

  console.log("4) queue email task");
  console.log(
    await request({
      method: "POST",
      path: "/tasks/email",
      body: {
        to: "hello@example.com",
        subject: "System design demo",
      },
    })
  );

  console.log("5) metrics snapshot");
  console.log(await request({ path: "/metrics" }));

  console.log("6) create advanced order (saga + outbox)");
  const order = await request({
    method: "POST",
    path: "/orders",
    body: {
      idempotencyKey: "demo-order-1",
      userId: "user-42",
      paymentMethod: "card",
      items: [
        { sku: "SKU-1", qty: 2, price: 150 },
        { sku: "SKU-2", qty: 1, price: 300 },
      ],
    },
  });
  console.log(order);

  if (order.body && order.body.orderId) {
    console.log("7) fetch order record");
    console.log(await request({ path: `/orders/${order.body.orderId}` }));
  }

  console.log("8) dead letter events snapshot");
  console.log(await request({ path: "/events/dead-letter" }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
