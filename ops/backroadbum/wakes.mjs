// Merchant-only SQLite outbox. No event bodies, orders or payment decisions.
import { assertWakeContext, assertCommercePaymentWake, WakeError } from '../../src/checkout/wakes.ts';

export function createWakeStorage(db, config, now = Date.now) {
  db.exec('CREATE TABLE IF NOT EXISTS merchant_wake_events (event_id TEXT PRIMARY KEY, context TEXT NOT NULL, received_at INTEGER NOT NULL, acknowledged_at INTEGER);');
  const read = db.prepare('SELECT * FROM merchant_wake_events WHERE event_id=?');
  const readAttempt = db.prepare('SELECT value FROM attempts WHERE id=?');
  const ownerContext = context => {
    assertWakeContext(context);
    if (context.siteId !== config.siteId || context.bindingRef !== config.bindingRef ||
        context.stripeAccountId !== config.stripeAccountId || context.mode !== 'test') throw new WakeError('wake_association_mismatch');
    const row = readAttempt.get(context.attemptId);
    const attempt = row ? JSON.parse(row.value) : null;
    if (!attempt || attempt.attemptId !== context.attemptId || attempt.siteId !== context.siteId ||
        attempt.bindingRef !== context.bindingRef || attempt.stripeAccountId !== context.stripeAccountId ||
        attempt.mode !== context.mode) throw new WakeError('wake_association_mismatch');
  };
  const canonical = context => JSON.stringify({ eventId: context.eventId, attemptId: context.attemptId,
    siteId: context.siteId, bindingRef: context.bindingRef, stripeAccountId: context.stripeAccountId, mode: context.mode });
  const projection = row => {
    const context = JSON.parse(row.context); ownerContext(context);
    if (row.event_id !== context.eventId) throw new WakeError('wake_association_mismatch');
    return { eventId: context.eventId, attemptId: context.attemptId, bindingRef: context.bindingRef, deliveryGeneration: 1, wokeAt: row.received_at };
  };
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {
    enqueueWake(context) {
      return transaction(() => {
        ownerContext(context);
        const serialized = canonical(context), previous = read.get(context.eventId);
        if (previous) {
          if (previous.context !== serialized) throw new WakeError('event_reuse');
          return; // An acknowledged event stays acknowledged on provider redelivery.
        }
        db.prepare('INSERT INTO merchant_wake_events VALUES (?, ?, ?, NULL)').run(context.eventId, serialized, now());
      });
    },
    listWakes(bindingRef, limit = 25) {
      if (bindingRef !== config.bindingRef) throw new WakeError('binding_not_found');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new WakeError('invalid_batch_limit');
      return db.prepare('SELECT * FROM merchant_wake_events WHERE acknowledged_at IS NULL ORDER BY received_at, event_id LIMIT ?').all(limit).map(projection);
    },
    acknowledgeWake(wake) {
      assertCommercePaymentWake(wake);
      return transaction(() => {
        const row = read.get(wake.eventId);
        if (!row) throw new WakeError('wake_not_found');
        const expected = projection(row);
        if (Object.keys(expected).some(key => expected[key] !== wake[key])) throw new WakeError('wake_association_mismatch');
        if (row.acknowledged_at !== null) return true;
        return db.prepare('UPDATE merchant_wake_events SET acknowledged_at=? WHERE event_id=? AND acknowledged_at IS NULL').run(now(), wake.eventId).changes === 1;
      });
    },
    wakeStats() {
      const row = db.prepare('SELECT count(*) AS received, count(acknowledged_at) AS acknowledged, max(received_at) AS lastReceivedAt FROM merchant_wake_events').get();
      return { received: row.received, acknowledged: row.acknowledged, pending: row.received - row.acknowledged, lastReceivedAt: row.lastReceivedAt };
    },
  };
}
