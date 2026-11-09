// Read-only operator check. Never creates a Checkout Session or emits credentials.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
async function main() {
const config = JSON.parse(readFileSync('/etc/backroadbum/payments.json', 'utf8'));
const base = 'http://127.0.0.1:8787';
const unauthorized = await fetch(base + '/v1/status');
assert.equal(unauthorized.status, 401);
const pass = await fetch(base + '/api/store-passes', { method: 'POST',
  headers: { authorization: `Bearer ${config.storeKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ site_id: config.siteId, scope: 'payments:admin', audience: config.audience }) });
assert.equal(pass.status, 200);
const token = (await pass.json()).access_token;
assert.equal(typeof token, 'string');
const response = await fetch(base + '/v1/status', { headers: { authorization: `Bearer ${token}`, 'x-dinkus-site': config.siteId } });
assert.equal(response.status, 200);
const status = await response.json();
assert.equal(status.mode, 'test');
assert.equal(status.connectionEvidence?.accountRef, config.stripeAccountId);
console.log(JSON.stringify({ checkedAt: new Date().toISOString(), unauthenticatedHttp: unauthorized.status,
  authenticatedHttp: response.status, mode: status.mode, providerReadiness: status.state,
  configuredAccountMatches: true, storefrontConnected: false, paidOrderVerified: false }, null, 2));
}
main().catch(() => {
  console.error('Private Payments check failed; no response body or credentials emitted.');
  process.exitCode = 1;
});
