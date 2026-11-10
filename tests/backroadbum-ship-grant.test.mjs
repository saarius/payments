import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, exportPKCS8, exportSPKI, jwtVerify } from 'jose';
import { createMerchantRuntime } from '../ops/backroadbum/runtime.mjs';
import { readShipGrant, validateShipGrant } from '../ops/backroadbum/ship-grant.mjs';
const config = { schema: 'backroadbum.payments-node/v1', mode: 'test', origin: 'https://backroadbum.com',
  issuer: 'https://backroadbum.com', siteId: 'backroadbum', subject: 'backroadbum-owner', audience: 'backroadbum-payments',
  bindingRef: 'binding', stripeAccountId: 'acct_fixture', storeKey: 'dk_store_' + 'a'.repeat(43) };
const grant = { schema: 'backroadbum.ship-grant/v1', siteId: 'backroadbum', enabled: true, storeKey: 'dk_store_' + 'b'.repeat(43) };
test('private Ship grant is exact, independent, bounded, and defaults closed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'brb-grant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'grant.json');
  assert.equal(readShipGrant(config, path), null);
  const write = value => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  write(grant); assert.deepEqual(readShipGrant(config, path), grant);
  chmodSync(path, 0o644); assert.equal(readShipGrant(config, path), null); chmodSync(path, 0o600);
  const link = join(dir, 'link'); symlinkSync(path, link); assert.equal(readShipGrant(config, link), null);
  for (const bad of [{ ...grant, enabled: false }, { ...grant, scope: 'ship:orders' }, { ...grant, storeKey: config.storeKey },
    { ...grant, siteId: 'other' }, { ...grant, enabled: 1 }, { ...grant, storeKey: 'weak' }]) {
    write(bad); assert.equal(readShipGrant(config, path), null);
  }
  writeFileSync(path, '{broken'); assert.equal(readShipGrant(config, path), null);
  writeFileSync(path, ' '.repeat(4097)); assert.equal(readShipGrant(config, path), null);
  for (const patch of [{ origin: 'https://foreign.invalid' }, { issuer: 'https://dinkuskit.com/account' }, { siteId: 'other' }]) {
    assert.throws(() => validateShipGrant(grant, { ...config, ...patch }));
  }
});
test('plugin grants cannot cross scopes/audiences; disable and rotation affect the next exchange', async () => {
  const keys = await generateKeyPair('ES256', { extractable: true });
  const signedConfig = { ...config, privateKey: await exportPKCS8(keys.privateKey), publicKey: await exportSPKI(keys.publicKey) };
  let current = grant;
  const runtime = await createMerchantRuntime({ config: signedConfig, apiKey: 'sk_test_fixture', store: {}, provider: {},
    accountStatus: async () => ({ object: 'account', id: config.stripeAccountId }), shipGrant: () => current });
  const exchange = (key, scope, audience = 'backroadbum-ship', patch = {}) => runtime.fetch(new Request(config.origin + '/api/store-passes', {
    method: 'POST', headers: { authorization: 'Bearer ' + key }, body: JSON.stringify({ site_id: config.siteId, audience, scope, ...patch }),
  }));
  const response = await exchange(grant.storeKey, 'ship:admin');
  assert.equal(response.status, 200);
  const body = await response.json();
  const { payload } = await jwtVerify(body.access_token, keys.publicKey, { issuer: config.issuer, audience: 'backroadbum-ship', algorithms: ['ES256'] });
  assert.equal(payload.scope, 'ship:admin'); assert.equal(payload.site_id, config.siteId); assert.equal(payload.site_origin, config.origin);
  assert.equal(payload.exp - payload.iat, 300); assert.equal(body.expires_in, 300);
  assert.equal((await exchange(config.storeKey, 'ship:admin')).status, 400);
  assert.equal((await exchange(config.storeKey, 'ship:orders')).status, 400);
  for (const [scope, audience] of [['ship:orders', 'backroadbum-ship'], ['ship:admin ship:orders', 'backroadbum-ship'],
    ['payments:checkout', config.audience], ['payments:admin', config.audience], ['commerce:settings', 'backroadbum-commerce']]) {
    assert.equal((await exchange(grant.storeKey, scope, audience)).status, 400);
  }
  for (const patch of [{ site_id: 'other' }, { extra: true }]) assert.equal((await exchange(grant.storeKey, 'ship:admin', undefined, patch)).status, 400);
  assert.equal((await exchange(grant.storeKey, 'payments:admin', config.audience)).status, 400);
  current = { ...grant, enabled: false }; assert.equal((await exchange(grant.storeKey, 'ship:admin')).status, 401);
  current = { ...grant, storeKey: 'dk_store_' + 'c'.repeat(43) }; assert.equal((await exchange(grant.storeKey, 'ship:admin')).status, 401);
  assert.equal((await exchange(current.storeKey, 'ship:admin')).status, 200);
  current = { ...grant, storeKey: config.storeKey }; assert.equal((await exchange(grant.storeKey, 'ship:admin')).status, 401);
  current = null;
  assert.equal((await exchange(config.storeKey, 'payments:checkout', config.audience)).status, 200);
  assert.equal((await exchange(config.storeKey, 'commerce:settings', 'backroadbum-commerce')).status, 200);
  // Ship passes never authorize Payments or merchant settings, even though the signing key is shared.
  for (const path of ['/v1/status', '/api/commerce-settings']) {
    assert.equal((await runtime.fetch(new Request(config.origin + path, { headers: { authorization: 'Bearer ' + body.access_token } }))).status, 401);
  }
});
