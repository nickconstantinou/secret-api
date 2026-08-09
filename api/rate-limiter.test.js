const assert = require("node:assert/strict");
const { test } = require("node:test");

const { FixedWindowRateLimiter } = require("./rate-limiter.js");

test("limits each authenticated client independently", () => {
  let now = 1000;
  const limiter = new FixedWindowRateLimiter({
    limit: 2,
    windowMs: 10_000,
    now: () => now,
  });

  assert.equal(limiter.consume("client-a").allowed, true);
  assert.equal(limiter.consume("client-a").allowed, true);
  assert.deepEqual(limiter.consume("client-a"), { allowed: false, retryAfterSeconds: 10 });
  assert.equal(limiter.consume("client-b").allowed, true);

  now += 10_000;
  assert.equal(limiter.consume("client-a").allowed, true);
});
