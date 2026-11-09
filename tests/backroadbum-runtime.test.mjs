import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { generateKeyPair, exportPKCS8, exportSPKI, SignJWT } from 'jose';
import { createMerchantRuntime, openAttemptStore, validateConfig, createLoopbackServer } from '../ops/backroadbum/runtime.mjs';

async function fixture(t) {
  const keys = await generateKeyPair('ES256', { extractable: true });
  const config = {
    schema: 'backroadbum.payments-node/v1', mode: 'test', origin: 'https://store.example.invalid',
    issuer: 'https://store.example.invalid', subject: 'merchant', audience: 'merchant-payments',
    siteId: 'store', bindingRef: 'binding', stripeAccountId: 'acct_owner', storeKey: `dk_store_${'a'.repeat(43)}`,
    privateKey: await exportPKCS8(keys.privateKey), publicKey: await exportSPKI(keys.publicKey),
  };
  const dir = mkdtempSync(join(tmpdir(), 'brb-payments-'));
  const path = join(dir, 'attempts.db');
  let store = openAttemptStore(path, config);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const calls = [];
  let account = { object: 'account', id: 'acct_owner', charges_enabled: false };
  let session;
  const provider = {
    async createSession(input) {
      calls.push(input);
      session ??= { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123', status: 'open', paymentStatus: 'unpaid',
        amountTotal: Number(input.total.minor), currency: 'usd', created: input.expiresAtSeconds - 1860,
        expiresAt: input.expiresAtSeconds, livemode: false, paymentIntentId: null, paymentMethodTypes: ['card'],
        metadata: { dinkus_attempt: input.attemptId, dinkus_binding: input.bindingRef, dinkus_site: input.siteId } };
      return structuredClone(session);
    },
    async retrieveSession() { return structuredClone(session); },
    async retrievePaymentIntent() { throw Error('not used'); },
  };
  const build = () => createMerchantRuntime({ config, apiKey: 'sk_test_fixture', store, provider, accountStatus: async () => {
    if (account instanceof Error) throw account;
    return account;
  } });
  let runtime = await build();
  async function pass(scope = 'payments:checkout', body = {}) {
    return runtime.fetch(new Request(`${config.origin}/api/store-passes`, { method: 'POST',
      headers: { authorization: `Bearer ${config.storeKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ site_id: config.siteId, scope, audience: config.audience, ...body }) }));
  }
  async function request(pathname, body, token, headers = {}) {
    token ??= (await (await pass(body || pathname.includes('/checkout') ? 'payments:checkout' : 'payments:admin')).json()).access_token;
    return runtime.fetch(new Request(config.origin + pathname, {
      method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}`, 'x-dinkus-site': config.siteId, ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
  }
  return { config, keys, path, calls, pass, request, provider,
    raw: request => runtime.fetch(request),
    setAccount(value) { account = value; },
    async restart() { store.close(); store = openAttemptStore(path, config); runtime = await build(); },
  };
}
const payment = (overrides = {}) => ({
  attemptId: 'commerce-attempt', bindingRef: 'binding',
  lines: [{ catalogItemId: 'cap', quantity: 3, name: 'Long Way Cap', unitPrice: { currency: 'USD', minor: '2400' } }],
  total: { currency: 'USD', minor: '7200' }, paymentWindow: { minSeconds: 1800, maxSeconds: 1860 }, paymentMethods: ['card'], ...overrides,
});

test('configuration refuses live/empty keys, non-test mode, insecure origins and weak keys', async t => {
  const f = await fixture(t);
  for (const key of [undefined, '', 'sk_test_', 'sk_live_never', 'rk_test_no']) assert.throws(() => validateConfig(f.config, key), /test_key_required/);
  for (const overrides of [{ mode: 'live' }, { origin: 'http://store.example.invalid' }, { issuer: 'https://x.invalid/path' }, { storeKey: 'weak' }]) {
    assert.throws(() => validateConfig({ ...f.config, ...overrides }, 'sk_test_fixture'));
  }
});
test('pass exchange requires the private key, exact site/audience/scope and shape', async t => {
  const f = await fixture(t);
  assert.equal((await f.raw(new Request(f.config.origin + '/api/store-passes', { method: 'POST', body: '{}' }))).status, 401);
  for (const body of [{ site_id: 'other' }, { audience: 'other' }, { scope: 'payments:admin payments:checkout' }, { extra: true }]) {
    assert.equal((await f.pass('payments:checkout', body)).status, 400);
  }
  assert.equal((await f.pass()).status, 200);
});
test('service rejects missing, expired, wrong-scope and wrong-site passes', async t => {
  const f = await fixture(t);
  assert.equal((await f.raw(new Request(f.config.origin + '/v1/status'))).status, 401);
  const checkout = (await (await f.pass()).json()).access_token;
  assert.equal((await f.request('/v1/connect/diagnostics', null, checkout)).status, 401);
  const token = (await (await f.pass('payments:admin')).json()).access_token;
  assert.equal((await f.request('/v1/status', null, token, { 'x-dinkus-site': 'other' })).status, 401);
  const expired = await new SignJWT({ site_id: 'store', site_origin: f.config.origin, scope: 'payments:admin' })
    .setProtectedHeader({ alg: 'ES256' }).setIssuer(f.config.issuer).setAudience(f.config.audience)
    .setSubject(f.config.subject).setIssuedAt(1).setExpirationTime(2).sign(f.keys.privateKey);
  assert.equal((await f.request('/v1/status', null, expired)).status, 401);
});
test('only the verified own-account TEST identity admits a binding', async t => {
  const f = await fixture(t);
  assert.equal((await (await f.request('/v1/status')).json()).state, 'ready');
  for (const account of [{ object: 'account', id: 'acct_other' }, { id: 'acct_owner' }]) {
    f.setAccount(account);
    assert.equal((await (await f.request('/v1/status')).json()).state, 'checking');
    assert.equal((await (await f.request('/v1/checkout/session', payment())).json()).outcome, 'unknown');
    assert.equal((await f.request('/v1/checkout-binding?bindingRef=binding')).status, 409);
  }
  assert.equal(f.calls.length, 0);
});
test('own-account sandbox readiness does not require live activation flags', async t => {
  const f = await fixture(t);
  f.setAccount({ object: 'account', id: 'acct_owner', charges_enabled: false });
  assert.equal((await (await f.request('/v1/status')).json()).state, 'ready');
  assert.equal((await (await f.request('/v1/checkout/session', payment())).json()).outcome, 'open');
});
test('provider failure text never escapes in HTTP 5xx responses', async t => {
  const f = await fixture(t);
  f.setAccount(Error('Invalid API key: sk_test_do_not_disclose'));
  const response = await f.request('/v1/status');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'payments_unavailable' });
});
test('SQLite persists one immutable claim/session across restart and rejects changed totals', async t => {
  const f = await fixture(t);
  const first = await (await f.request('/v1/checkout/session', payment())).json();
  assert.equal(first.outcome, 'open');
  assert.equal(first.session.sessionId, 'cs_test_123');
  assert.equal(f.calls[0].idempotencyKey, 'dinkus-checkout:commerce-attempt');
  assert.equal(f.calls[0].total.minor, '7200');
  assert.equal(f.calls[0].testCardMessage, true);
  await f.restart();
  const retry = await (await f.request('/v1/checkout/session', payment())).json();
  assert.equal(retry.session.sessionId, first.session.sessionId);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.request('/v1/checkout/session', payment({ total: { currency: 'USD', minor: '1' } }))).status, 400);
  assert.throws(() => openAttemptStore(f.path, { ...f.config, stripeAccountId: 'acct_other' }), /immutable_binding_mismatch/);
});
test('failed synchronous transactions roll back and async transactions are refused', t => {
  const dir = mkdtempSync(join(tmpdir(), 'brb-payments-db-'));
  const config = { issuer: 'a', subject: 'b', siteId: 'c', origin: 'd', audience: 'e', bindingRef: 'f', stripeAccountId: 'g' };
  const store = openAttemptStore(join(dir, 'db'), config);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => store.transaction(tx => { tx.write({ attemptId: 'x' }); throw Error('stop'); }), /stop/);
  assert.equal(store.transaction(tx => tx.read('x')), null);
  assert.throws(() => store.transaction(async () => 1), /synchronous_transaction_required/);
});
test('loopback HTTP bridge limits bodies and does not trust Host', async t => {
  const observed = [];
  const server = createLoopbackServer({ fetch: async request => { observed.push(request.url); return Response.json({ ok: true }); } }, 'https://store.example.invalid');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + '/health', { headers: { host: 'attacker.invalid' } })).status, 200);
  assert.equal(observed[0], 'https://store.example.invalid/health');
  assert.equal((await fetch(origin + '/v1/checkout/session', { method: 'POST', body: 'a'.repeat(128 * 1024 + 1) })).status, 413);
  assert.equal(observed.length, 1);
});
