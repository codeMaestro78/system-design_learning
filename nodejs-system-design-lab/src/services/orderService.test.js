const test = require("node:test");
const assert = require("node:assert/strict");
const { IdempotencyStore } = require("../distributed/idempotencyStore");
const { MetricsRegistry } = require("../observability/metricsRegistry");
const { OrderService } = require("./orderService");

function createOrderService() {
  const saga = {
    async run() {
      return {
        ok: true,
        charge: { chargeId: "ch_test" },
      };
    },
  };

  return new OrderService({
    saga,
    idempotencyStore: new IdempotencyStore(),
    metrics: new MetricsRegistry(),
    config: {
      limits: {
        maxItemsPerOrder: 5,
        maxOrderValue: 10000,
      },
    },
  });
}

test("OrderService rejects fractional quantities", async () => {
  const service = createOrderService();

  await assert.rejects(
    service.createOrder(
      {
        items: [{ sku: "book", qty: 1.5, price: 10 }],
      },
      "order-1"
    ),
    /invalid item payload/
  );
});

test("OrderService copies item payload into stored order record", async () => {
  const service = createOrderService();
  const input = {
    userId: "u1",
    items: [{ sku: "book", qty: 1, price: 10 }],
  };

  const result = await service.createOrder(input, "order-2");
  input.items[0].qty = 99;

  const stored = service.getOrder(result.orderId);
  assert.equal(stored.items[0].qty, 1);
});
