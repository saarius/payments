// Read-only issuer/receiver check. Creates no checkout, order, label, PDF or event.
import { readFileSync, lstatSync } from 'node:fs';
import { importJWK, jwtVerify } from 'jose';
import { validateShipGrant, SHIP_GRANT_PATH } from './ship-grant.mjs';
const ORIGIN = 'https://backroadbum.com';
class CheckFailure extends Error {}
const check = (value, code) => { if (!value) throw new CheckFailure(code); };
try {
  const config = JSON.parse(readFileSync('/etc/backroadbum/payments.json', 'utf8'));
  check(config.mode === 'test', 'test_only');
  const stat = lstatSync(SHIP_GRANT_PATH);
  check(stat.isFile() && (stat.mode & 0o777) === 0o600 && stat.size <= 4096, 'private_grant_required');
  const grant = validateShipGrant(JSON.parse(readFileSync(SHIP_GRANT_PATH, 'utf8')), config);
  const exchange = (key, scope, audience = 'backroadbum-ship') => fetch(ORIGIN + '/api/store-passes', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000), headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ site_id: grant.siteId, scope, audience }),
  });
  const response = await exchange(grant.storeKey, 'ship:admin');
  if (process.argv.includes('--expect-disabled')) {
    check(grant.enabled === false && response.status === 401, 'disabled_grant_not_denied');
    console.log(JSON.stringify({ schema: 'backroadbum.ship-connection-check/v1', grant: 'disabled', exchangeHttp: response.status, effects: 'none' }));
  } else {
    check(grant.enabled && response.status === 200, 'grant_not_admitted');
    const body = await response.json();
    const jwksResponse = await fetch(ORIGIN + '/.well-known/jwks.json', { redirect: 'error', signal: AbortSignal.timeout(8000) });
    check(jwksResponse.status === 200, 'public_jwks_unavailable');
    const jwks = await jwksResponse.json();
    check(jwks.keys?.length === 1 && Object.keys(jwks.keys[0]).sort().join() === 'alg,crv,kid,kty,use,x,y' &&
      jwks.keys[0].kid === 'brb-owner-v1' && jwks.keys[0].alg === 'ES256' && jwks.keys[0].use === 'sig', 'public_jwks_mismatch');
    const { payload } = await jwtVerify(body.access_token, await importJWK(jwks.keys[0], 'ES256'), { issuer: ORIGIN, audience: 'backroadbum-ship', algorithms: ['ES256'] });
    check(payload.scope === 'ship:admin' && payload.site_id === 'backroadbum' && payload.site_origin === ORIGIN &&
      payload.sub === config.subject && payload.exp - payload.iat === 300, 'pass_binding_mismatch');
    const get = path => fetch(ORIGIN + path, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { authorization: 'Bearer ' + body.access_token } });
    const state = await get('/api/ship/v1/admin/status'); check(state.status === 200, 'host_unavailable');
    const status = await state.json();
    check(status.schema === 'backroadbum.ship-admin/v1' && status.mode === 'test' && status.provider === 'practice' &&
      status.admission === 'closed' && status.commerceConnected === false, 'unexpected_status');
    const orders = await get('/api/ship/v1/admin/orders'); check(orders.status === 200 && (await orders.json()).orders?.length === 0, 'host_not_empty');
    for (const [key, scope, audience] of [[config.storeKey, 'ship:admin', 'backroadbum-ship'], [config.storeKey, 'ship:orders', 'backroadbum-ship'],
      [grant.storeKey, 'ship:orders', 'backroadbum-ship'], [grant.storeKey, 'payments:checkout', config.audience],
      [grant.storeKey, 'commerce:settings', 'backroadbum-commerce']]) check((await exchange(key, scope, audience)).status === 400, 'cross_grant_admitted');
    const payments = await exchange(config.storeKey, 'payments:admin', config.audience); check(payments.status === 200, 'payments_regression');
    const paymentToken = (await payments.json()).access_token;
    check((await fetch(ORIGIN + '/api/ship/v1/admin/status', { redirect: 'error', headers: { authorization: 'Bearer ' + paymentToken } })).status === 401, 'payment_pass_admitted');
    for (const path of ['/api/ship/v1/orders', '/api/ship/v1/admin/settings', '/api/ship/v1/admin/orders/fixture/labels']) {
      check((await get(path)).status === 404, 'unexpected_proxy_route');
    }
    check((await get('/api/ship/print/fixture')).status === 410, 'invalid_pdf_capability_not_denied');
    check((await fetch(ORIGIN + '/api/ship/v1/admin/status', { method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + body.access_token } })).status === 404, 'write_route_proxied');
    for (const path of ['/api/ship/v1/admin/status', '/api/ship/v1/admin/orders']) check((await fetch(ORIGIN + path, { redirect: 'error' })).status === 401, 'anonymous_access');
    console.log(JSON.stringify({ schema: 'backroadbum.ship-connection-check/v1', grant: 'enabled', signature: 'ES256 verified',
      ttlSeconds: 300, jwksHttp: jwksResponse.status, statusHttp: state.status, ordersHttp: orders.status, ordersReturned: 0, admission: status.admission,
      commerceConnected: status.commerceConnected, crossGrantDenials: 5, paymentPassDenied: true, anonymousDenied: true, mutationProxyDenied: true, effects: 'none' }));
  }
} catch (error) {
  const reason = error instanceof CheckFailure ? ` (${error.message})` : '';
  console.error('Ship connection check refused' + reason + '; no provider response, browser state or credentials emitted.'); process.exitCode = 1;
}
