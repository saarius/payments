import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Stripe from 'stripe';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { createMerchantRuntime, openAttemptStore } from '../ops/backroadbum/runtime.mjs';

const secret = 'whsec_unit_fixture';
const signer = new Stripe('sk_test_fixture');
async function fixture(t) {
  const keys = await generateKeyPair('ES256', { extractable: true });
  const config = { schema: 'backroadbum.payments-node/v1', mode: 'test', origin: 'https://store.example.invalid',
    issuer: 'https://store.example.invalid', subject: 'merchant', audience: 'merchant-payments', siteId: 'store',
    bindingRef: 'binding', stripeAccountId: 'acct_owner', storeKey: `dk_store_${'a'.repeat(43)}`,
    privateKey: await exportPKCS8(keys.privateKey), publicKey: await exportSPKI(keys.publicKey) };
  const dir = mkdtempSync(join(tmpdir(), 'brb-webhooks-')), path = join(dir, 'db');
  let store = openAttemptStore(path, config), runtime;
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const state = { session: null, account: { object: 'account', id: config.stripeAccountId }, event: null, retrievals: 0, creates: 0 };
  const provider = {
    async createSession(input) {
      state.creates++;
      return state.session = { id: 'cs_test_fixture', url: 'https://checkout.stripe.com/c/pay/cs_test_fixture',
        status: 'complete', paymentStatus: 'paid', amountTotal: Number(input.total.minor), currency: 'usd',
        created: input.expiresAtSeconds - 1860, expiresAt: input.expiresAtSeconds, livemode: false,
        paymentIntentId: 'pi_fixture', paymentMethodTypes: ['card'],
        metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId } };
    },
    async retrieveSession() { return structuredClone(state.session); },
    async retrievePaymentIntent() { return { id: 'pi_fixture', status: 'succeeded', amount: 2200, currency: 'usd', latestCharge: { state: 'known', status: 'succeeded' } }; },
  };
  const build = async () => runtime = await createMerchantRuntime({ config, apiKey: 'sk_test_fixture', store, provider,
    accountStatus: async () => state.account, webhookSecret: secret,
    retrieveEvent: async () => { state.retrievals++; if (state.event instanceof Error) throw state.event; return structuredClone(state.event); } });
  await build();
  const raw = request => runtime.fetch(request);
  async function request(pathname, body, scope = 'payments:checkout') {
    const pass = await (await raw(new Request(config.origin + '/api/store-passes', { method: 'POST',
      headers: { authorization: `Bearer ${config.storeKey}` }, body: JSON.stringify({ site_id: config.siteId, scope, audience: config.audience }) }))).json();
    return raw(new Request(config.origin + pathname, { method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${pass.access_token}`, 'x-dinkus-site': config.siteId }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  }
  await request('/v1/checkout/session', { attemptId: 'attempt', bindingRef: 'binding', total: { currency: 'USD', minor: '2200' },
    lines: [{ catalogItemId: 'mug', name: 'Mug', quantity: 1, unitPrice: { currency: 'USD', minor: '2200' } }],
    paymentWindow: { minSeconds: 1800, maxSeconds: 1860 }, paymentMethods: ['card'] });
  const original = { id: 'evt_fixture', object: 'event', type: 'checkout.session.completed', livemode: false,
    data: { object: { object: 'checkout.session', id: state.session.id, livemode: false, metadata: state.session.metadata } } };
  state.event = structuredClone(original);
  async function deliver(event = original, options = {}) {
    const payload = options.payload ?? JSON.stringify(event);
    const signature = options.signature ?? signer.webhooks.generateTestHeaderString({ payload, secret });
    return raw(new Request(config.origin + '/v1/webhooks/stripe' + (options.query ?? ''), { method: 'POST',
      headers: { 'stripe-signature': signature, ...(options.account ? { 'stripe-account': options.account } : {}) }, body: payload }));
  }
  return { config, state, original, deliver, request, raw, store: () => store,
    async pending() { return (await request('/v1/checkout/wakes?bindingRef=binding')).json(); },
    async restart() { store.close(); store = openAttemptStore(path, config); await build(); },
  };
}

test('raw signatures precede event access, canonical retrieval and all wake storage', async t => {
  const f = await fixture(t);
  assert.equal((await f.deliver(undefined, { signature: 'invalid' })).status, 400);
  const payload = JSON.stringify(f.original), signature = signer.webhooks.generateTestHeaderString({ payload, secret });
  assert.equal((await f.deliver(undefined, { payload: payload + ' ', signature })).status, 400);
  const stale = signer.webhooks.generateTestHeaderString({ payload, secret, timestamp: 1 });
  assert.equal((await f.deliver(undefined, { signature: stale })).status, 400);
  assert.equal(f.state.retrievals, 0);
  assert.deepEqual(await f.pending(), []);
  assert.equal((await f.deliver(undefined, { query: '?extra=1' })).status, 400);
});

test('direct account provenance is API-backed, never supplied by an account header or synthesized event field', async t => {
  const f = await fixture(t);
  assert.equal(f.original.account, undefined);
  assert.equal((await f.deliver()).status, 200);
  assert.equal(f.state.retrievals, 1);
  assert.equal(f.state.creates, 1); // Only fixture setup created a session.
  assert.equal((await f.pending()).length, 1);
  assert.equal(f.original.account, undefined);
});

test('wrong account, canonical event, live mode and unknown attempt fail without a wake', async t => {
  const cases = [
    f => { f.state.account.id = 'acct_other'; },
    f => { f.state.event.id = 'evt_other'; },
    f => { f.state.event.data.object.id = 'cs_test_other'; },
    f => { f.state.event = Error('provider temporarily unavailable'); },
  ];
  for (const mutate of cases) {
    const f = await fixture(t); mutate(f);
    assert.notEqual((await f.deliver()).status, 200);
    assert.deepEqual(await f.pending(), []);
  }
  for (const mutate of [
    event => { event.account = 'acct_owner'; },
    event => { event.livemode = true; },
    event => { event.data.object.livemode = true; },
    event => { event.data.object.id = 'cs_live_other'; },
    event => { event.data.object.metadata.dinkus_attempt = 'unknown'; },
    event => { event.data.object.metadata.dinkus_binding = 'other'; },
    event => { event.data.object.metadata.dinkus_site = 'other'; },
  ]) {
    const f = await fixture(t), event = structuredClone(f.original); mutate(event); f.state.event = structuredClone(event);
    assert.equal((await f.deliver(event, { account: 'acct_owner' })).status, 409);
    assert.deepEqual(await f.pending(), []);
  }
  const f = await fixture(t);
  assert.equal((await f.deliver(undefined, { account: 'acct_other' })).status, 409);
});

test('existing Payments provider amount/window matching still runs before durable enqueue', async t => {
  const f = await fixture(t);
  f.state.session.amountTotal = 1;
  assert.equal((await f.deliver()).status, 409);
  assert.deepEqual(await f.pending(), []);
});

test('failed durable insert is not HTTP200 and does not acknowledge provider delivery', async t => {
  const f = await fixture(t);
  f.store().enqueueWake = () => { throw Error('disk unavailable; sk_test_must_not_leak'); };
  const response = await f.deliver();
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'payments_unavailable' });
});

test('event-keyed wake survives restart, remains pending until exact authenticated ACK and never resurrects', async t => {
  const f = await fixture(t);
  await f.deliver(); await f.deliver();
  const [wake] = await f.pending();
  assert.deepEqual(Object.keys(wake).sort(), ['attemptId', 'bindingRef', 'deliveryGeneration', 'eventId', 'wokeAt']);
  await f.restart();
  assert.deepEqual(await f.pending(), [wake]);
  assert.equal((await f.raw(new Request(f.config.origin + '/v1/checkout/wakes?bindingRef=binding'))).status, 401);
  assert.equal((await f.request('/v1/checkout/wakes?bindingRef=binding', null, 'payments:admin')).status, 401);
  assert.equal((await f.request('/v1/checkout/wakes?bindingRef=other')).status, 409);
  for (const mutation of [{ attemptId: 'other' }, { bindingRef: 'other' }, { deliveryGeneration: 2 }, { wokeAt: wake.wokeAt + 1 }]) {
    assert.equal((await f.request('/v1/checkout/wakes/ack', { ...wake, ...mutation })).status, 409);
    assert.deepEqual(await f.pending(), [wake]);
  }
  assert.deepEqual(await (await f.request('/v1/checkout/wakes/ack', wake)).json(), { acknowledged: true });
  assert.deepEqual(await (await f.request('/v1/checkout/wakes/ack', wake)).json(), { acknowledged: true });
  await f.restart(); await f.deliver();
  assert.deepEqual(await f.pending(), []);
  assert.deepEqual(f.store().wakeStats(), { received: 1, acknowledged: 1, pending: 0, lastReceivedAt: wake.wokeAt });
});

test('an event ID cannot be reassigned to a different stored attempt', async t => {
  const f = await fixture(t); await f.deliver();
  f.store().transaction(tx => tx.write({ ...tx.read('attempt'), attemptId: 'other' }));
  assert.throws(() => f.store().enqueueWake({ eventId: 'evt_fixture', attemptId: 'other', siteId: 'store',
    bindingRef: 'binding', stripeAccountId: 'acct_owner', mode: 'test' }), /event_reuse/);
  assert.equal((await f.pending()).length, 1);
});
