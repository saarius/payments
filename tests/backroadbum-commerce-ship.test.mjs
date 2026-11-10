import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportPKCS8, exportSPKI, jwtVerify } from 'jose';
import { createMerchantRuntime } from '../ops/backroadbum/runtime.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readCommerceShip, validateCommerceShip, commerceShipAdmission, privateShipGeneration } from '../ops/backroadbum/commerce-ship.mjs';
const config = { schema: 'backroadbum.payments-node/v1', mode: 'test', origin: 'https://backroadbum.com', issuer: 'https://backroadbum.com',
  siteId: 'backroadbum', subject: 'synthetic-owner', audience: 'backroadbum-payments', bindingRef: 'fixture', stripeAccountId: 'acct_fixture', storeKey: 'dk_store_' + 'a'.repeat(43) };
const initial = { schema: 'backroadbum.commerce-ship/v1', generation: 'synthetic', revision: 0, orderId: null, enabled: false, notBefore: '2026-11-10T00:00:00.000Z' };
test('durable admission pins one ID and original cutoff with revision CAS, disable and restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'brb-commerce-ship-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'db'), shipPath = join(dir, 'ship');
  writeFileSync(shipPath, JSON.stringify({ schema: 'backroadbum.ship-node/v1', generation: initial.generation, allowedOrderId: '' }), { mode: 0o600 });
  let db = new DatabaseSync(path); let control = commerceShipAdmission(db, config, initial.generation);
  try {
    assert.equal(readCommerceShip(config, db, shipPath), null);
    const first = control.initialize(); assert.equal(first.revision, 0); assert.equal(first.orderId, null); assert.equal(first.enabled, false);
    assert.deepEqual(control.initialize(), first);
    for (const patch of [{ revision: '0', orderId: null, enabled: false }, { revision: 1, orderId: 'fixture', enabled: true },
      { revision: 0, orderId: null, enabled: true }, { revision: 0, orderId: '../bad', enabled: false },
      { revision: 0, orderId: 'fixture', enabled: true, notBefore: initial.notBefore }]) assert.throws(() => control.change(patch));
    assert.deepEqual(control.read(), first);
    const selected = control.change({ revision: 0, orderId: 'fixture-order', enabled: false }); assert.equal(selected.revision, 1); assert.equal(selected.notBefore, first.notBefore);
    assert.throws(() => control.change({ revision: 1, orderId: 'foreign', enabled: true }), /order_pinned/);
    assert.throws(() => control.change({ revision: 1, orderId: null, enabled: false }), /order_pinned/);
    const enabled = control.change({ revision: 1, orderId: selected.orderId, enabled: true }); assert.equal(enabled.revision, 2);
    assert.deepEqual(readCommerceShip(config, db, shipPath), enabled);
    const disabled = control.change({ revision: 2, orderId: selected.orderId, enabled: false });
    db.close(); db = new DatabaseSync(path); control = commerceShipAdmission(db, config, initial.generation);
    assert.deepEqual(control.read(), disabled); assert.deepEqual(control.initialize(), disabled);
    assert.throws(() => commerceShipAdmission(db, config, 'foreign').read());
    for (const patch of [{ generation: 'foreign' }, { revision: -1 }, { notBefore: 'not a date' }, { notBefore: '2026-11-10' }, { provider: 'live' }, { enabled: 'true' }]) {
      db.prepare('UPDATE merchant_ship_admission SET value=?').run(JSON.stringify({ ...disabled, ...patch })); assert.equal(readCommerceShip(config, db, shipPath), null);
    }
    db.exec('DELETE FROM merchant_ship_admission'); assert.throws(() => control.initialize()); assert.equal(readCommerceShip(config, db, shipPath), null);
    for (const patch of [{ mode: 'live' }, { origin: 'https://foreign.invalid' }, { issuer: 'https://dinkuskit.com/account' }, { siteId: 'other' }]) assert.throws(() => validateCommerceShip(initial, { ...config, ...patch }, initial.generation));
    assert.equal(privateShipGeneration(shipPath), initial.generation);
    chmodSync(shipPath, 0o644); assert.throws(() => privateShipGeneration(shipPath)); chmodSync(shipPath, 0o600);
    symlinkSync(shipPath, join(dir, 'link')); assert.throws(() => privateShipGeneration(join(dir, 'link')));
    writeFileSync(shipPath, ' '.repeat(4097)); assert.throws(() => privateShipGeneration(shipPath));
  } finally { db.close(); }
});
test('issuer grants Commerce orders only during admission; admin/settings/payments grants stay disjoint', async () => {
  const keys = await generateKeyPair('ES256', { extractable: true });
  const signed = { ...config, privateKey: await exportPKCS8(keys.privateKey), publicKey: await exportSPKI(keys.publicKey) };
  let current = initial;
  const shipKey = 'dk_store_' + 'b'.repeat(43);
  const runtime = await createMerchantRuntime({ config: signed, apiKey: 'sk_test_fixture', store: {}, provider: {},
    accountStatus: async () => ({ object: 'account', id: config.stripeAccountId }), commerceShip: () => current,
    shipGrant: () => ({ schema: 'backroadbum.ship-grant/v1', siteId: config.siteId, storeKey: shipKey, enabled: true }) });
  const trade = (scope, audience, key = config.storeKey) => runtime.fetch(new Request(config.origin + '/api/store-passes', {
    method: 'POST', headers: { authorization: 'Bearer ' + key }, body: JSON.stringify({ site_id: config.siteId, scope, audience }) }));
  const get = (token, suffix = '') => runtime.fetch(new Request(config.origin + '/api/commerce-ship' + suffix, { headers: { authorization: 'Bearer ' + token, 'x-dinkus-site': config.siteId } }));
  assert.equal((await get('')).status, 401);
  const settings = (await (await trade('commerce:settings', 'backroadbum-commerce')).json()).access_token;
  assert.deepEqual(await (await get(settings)).json(), initial);
  assert.equal((await get(settings, '?enabled=true')).status, 400);
  assert.equal((await trade('ship:orders', 'backroadbum-ship')).status, 400);
  current = { ...initial, revision: 1, orderId: 'fixture-order', enabled: true };
  const response = await trade('ship:orders', 'backroadbum-ship'); assert.equal(response.status, 200);
  const token = (await response.json()).access_token;
  const { payload } = await jwtVerify(token, keys.publicKey, { issuer: config.issuer, audience: 'backroadbum-ship' });
  assert.equal(payload.scope, 'ship:orders'); assert.equal(payload.exp - payload.iat, 300); assert.equal(payload.site_origin, config.origin);
  assert.equal((await get(token)).status, 401);
  assert.equal((await trade('ship:admin', 'backroadbum-ship')).status, 400);
  assert.equal((await trade('ship:orders', 'backroadbum-payments')).status, 400);
  assert.equal((await trade('ship:orders', 'backroadbum-ship', shipKey)).status, 400);
  assert.equal((await trade('commerce:settings', 'backroadbum-commerce', shipKey)).status, 400);
  const admin = (await (await trade('ship:admin', 'backroadbum-ship', shipKey)).json()).access_token;
  assert.equal((await get(admin)).status, 401);
  for (const value of [{ ...current, revision: 2, enabled: false }, null, { ...current, mode: 'live' }]) {
    current = value; assert.equal((await trade('ship:orders', 'backroadbum-ship')).status, 400);
    assert.equal((await trade('payments:checkout', config.audience)).status, 200);
    assert.equal((await trade('ship:admin', 'backroadbum-ship', shipKey)).status, 200);
  }
  assert.equal((await get(settings)).status, 503);
});
