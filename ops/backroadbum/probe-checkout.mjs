// Explicit operator transport probe, not a Commerce checkout or a paid-order proof.
// Creates one unpaid $1 TEST session and expires it immediately. No card is submitted.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createCheckoutSessionService } from '../../src/checkout/sessions.ts';
import { createStripeCheckout } from '../../src/stripe/checkout.ts';
import { createStripeClient } from '../../src/stripe/onboarding.ts';
import { openAttemptStore, validateConfig } from './runtime.mjs';
if (!process.argv.includes('--run')) {
  console.log('No action. --run creates and immediately expires one unpaid TEST session.');
  process.exit(0);
}
process.umask(0o077);
let store, stripe, sessionId;
try {
  const config = validateConfig(JSON.parse(readFileSync('/etc/backroadbum/payments.json', 'utf8')), process.env.STRIPE_API_KEY);
  stripe = createStripeClient(process.env.STRIPE_API_KEY, 'test');
  const account = await stripe.accounts.retrieveCurrent();
  assert.equal(account.id, config.stripeAccountId);
  store = openAttemptStore('/var/lib/backroadbum/payments/attempts.db', config);
  const binding = { bindingRef: config.bindingRef, providerId: 'stripe', stripeAccountId: config.stripeAccountId, mode: 'test' };
  const owner = { accountId: JSON.stringify([config.issuer, config.subject]), siteId: config.siteId };
  const provider = createStripeCheckout({ apiKey: process.env.STRIPE_API_KEY, mode: 'test', ownAccountId: config.stripeAccountId });
  const service = createCheckoutSessionService({ store, provider, mode: 'test',
    readyBinding: async () => binding, existingBinding: async () => binding,
    successUrl: `${config.origin}/test-store`, cancelUrl: `${config.origin}/test-store` });
  const request = { attemptId: `operator-transport-${randomUUID()}`, bindingRef: config.bindingRef,
    lines: [{ catalogItemId: 'operator-diagnostic-not-for-sale', quantity: 1, name: 'Transport diagnostic — not a store order', unitPrice: { currency: 'USD', minor: '100' } }],
    total: { currency: 'USD', minor: '100' }, paymentWindow: { minSeconds: 1800, maxSeconds: 1860 }, paymentMethods: ['card'] };
  const outcome = await service.ensureSessionFor(owner, request);
  // Save the reference before assertions so cleanup can expire any created session.
  sessionId = service.readAttempt(request.attemptId)?.stripeSessionId;
  assert.equal(outcome.outcome, 'open');
  assert.match(sessionId, /^cs_test_/);
  const retrieved = await provider.retrieveSession(sessionId, config.stripeAccountId);
  assert.equal(retrieved.livemode, false);
  assert.equal(retrieved.amountTotal, 100);
  assert.equal(retrieved.paymentStatus, 'unpaid');
  assert.equal((await service.lookupFor(owner, request)).outcome, 'open');
  const expired = await stripe.checkout.sessions.expire(sessionId);
  assert.equal(expired.status, 'expired');
  sessionId = null;
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), mode: 'test', identityMatches: true,
    createdAndRetrievedUnpaidSession: true, expiredImmediately: true, amountMinor: '100', currency: 'USD',
    v1ChargesEnabled: account.charges_enabled ?? null, commerceOrder: false, paidOrderVerified: false }, null, 2));
} catch {
  console.error('TEST transport probe failed; no provider exception or credentials emitted.');
  process.exitCode = 1;
} finally {
  if (stripe && sessionId) {
    try { await stripe.checkout.sessions.expire(sessionId); }
    catch { console.error('An unpaid TEST probe may remain open until its normal expiry.'); }
  }
  store?.close();
}
