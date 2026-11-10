// Read-only inspection or explicit Stripe redelivery for the retained shopper
// proof. Never creates a Checkout Session, pays a card, ACKs or changes an order.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createStripeClient } from '../../src/stripe/onboarding.ts';
import { validateConfig } from './runtime.mjs';
if (!process.argv.includes('--check') && !process.argv.includes('--resend')) {
  console.log('No action. --check inspects the retained paid shopper proof; --resend asks Stripe to redeliver its real completed event.');
  process.exit(0);
}
let db;
try {
  const config = validateConfig(JSON.parse(readFileSync('/etc/backroadbum/payments.json', 'utf8')), process.env.STRIPE_API_KEY);
  const statePath = process.argv.find(value => value.startsWith('--state-file='))?.slice('--state-file='.length) ?? '/etc/backroadbum/shopper-browser.json';
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const saved = state.origins.find(entry => entry.origin === config.origin)?.localStorage.find(entry => entry.name === 'dinkus.guest-checkout.v1');
  const { attemptId } = JSON.parse(saved.value);
  assert.equal(typeof attemptId, 'string');
  db = new DatabaseSync('/var/lib/backroadbum/payments/attempts.db', { readOnly: true });
  const record = JSON.parse(db.prepare('SELECT value FROM attempts WHERE id=?').get(attemptId).value);
  for (const key of ['siteId', 'bindingRef', 'stripeAccountId', 'mode']) assert.equal(record[key], config[key]);
  const stripe = createStripeClient(process.env.STRIPE_API_KEY, 'test');
  assert.equal((await stripe.accounts.retrieveCurrent()).id, config.stripeAccountId);
  const session = await stripe.checkout.sessions.retrieve(record.stripeSessionId);
  assert.equal(session.livemode, false); assert.equal(session.payment_status, 'paid');
  assert.equal(String(session.amount_total), record.amountMinor); assert.equal(session.currency, 'usd');
  assert.equal(session.metadata.dinkus_attempt, attemptId);
  const intent = await stripe.paymentIntents.retrieve(session.payment_intent);
  assert.equal(intent.status, 'succeeded'); assert.equal(String(intent.amount), record.amountMinor);
  const event = (await stripe.events.list({ type: 'checkout.session.completed', limit: 100 })).data.find(value => value.data.object.id === session.id);
  assert.ok(event); assert.equal(event.account, undefined); assert.equal(event.livemode, false);
  const endpoint = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find(value => value.url === config.origin + '/v1/webhooks/stripe');
  assert.ok(endpoint); assert.equal(endpoint.livemode, false); assert.equal(endpoint.status, 'enabled');
  assert.ok(endpoint.enabled_events.includes('checkout.session.completed'));
  if (process.argv.includes('--resend')) {
    // Same operation used by `stripe events resend --webhook-endpoint`:
    // stripe-cli/pkg/cmd/resource/events_resend.go. Signing stays at Stripe.
    await stripe.rawRequest('POST', `/v1/events/${encodeURIComponent(event.id)}/retry`, { webhook_endpoint: endpoint.id });
  }
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), mode: 'test', providerPaid: true,
    canonicalOwnAccountEvent: true, endpointEnabled: true, stripeRedeliveryRequested: process.argv.includes('--resend'),
    eventId: event.id, amount: { currency: 'USD', minor: record.amountMinor } }, null, 2));
} catch {
  console.error('Webhook proof refused; no provider response, browser state or credentials emitted.'); process.exitCode = 1;
} finally { db?.close(); }
