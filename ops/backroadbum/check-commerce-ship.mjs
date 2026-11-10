// Read-only production closed-state proof. No selection, order/label request or raw response output.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { commerceShipAdmission, privateShipGeneration } from './commerce-ship.mjs';
const ORIGIN = 'https://backroadbum.com';
let db;
try {
  const config = JSON.parse(readFileSync('/etc/backroadbum/payments.json', 'utf8'));
  if (config.mode !== 'test') throw Error('test_required');
  db = new DatabaseSync('/var/lib/backroadbum/payments/attempts.db', { readOnly: true });
  const local = commerceShipAdmission(db, config, privateShipGeneration()).read();
  if (local.enabled || local.orderId !== null || local.revision !== 0) throw Error('unselected_admission_required');
  const exchange = (scope, audience) => fetch(ORIGIN + '/api/store-passes', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { authorization: 'Bearer ' + config.storeKey, 'content-type': 'application/json' }, body: JSON.stringify({ site_id: config.siteId, scope, audience }) });
  const traded = await exchange('commerce:settings', 'backroadbum-commerce'); if (traded.status !== 200) throw Error('settings_grant_required');
  const token = (await traded.json()).access_token;
  const response = await fetch(ORIGIN + '/api/commerce-ship', { redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { authorization: 'Bearer ' + token, 'x-dinkus-site': config.siteId, 'user-agent': 'BackroadBum-SelfCheck/1.0' } });
  if (response.status !== 200 || JSON.stringify(await response.json()) !== JSON.stringify(local)) throw Error('current_admission_mismatch');
  const denied = await exchange('ship:orders', 'backroadbum-ship'); if (denied.status !== 400) throw Error('disabled_machine_grant_admitted');
  const anonymous = await fetch(ORIGIN + '/api/commerce-ship', { redirect: 'error' }); if (anonymous.status !== 401) throw Error('anonymous_admission_read');
  const write = await fetch(ORIGIN + '/api/commerce-ship', { method: 'POST', redirect: 'error' }); if (write.status !== 404) throw Error('admission_write_exposed');
  console.log(JSON.stringify({ schema: 'backroadbum.commerce-ship-check/v1', at: new Date().toISOString(), revision: local.revision,
    selectedOrder: false, enabled: false, notBefore: local.notBefore, settingsReadHttp: response.status, machineGrantHttp: denied.status,
    anonymousReadHttp: anonymous.status, publicWriteHttp: write.status, effects: 'none' }));
} catch { console.error('Commerce Ship check refused; no response body or credentials emitted.'); process.exitCode = 1; }
finally { db?.close(); }
