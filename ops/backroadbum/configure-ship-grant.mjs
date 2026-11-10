// One separate, initially disabled plugin key. Never modify the Payments/Stripe identity.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { validateShipGrant, SHIP_GRANT_PATH } from './ship-grant.mjs';
process.umask(0o077);
try {
  const config = JSON.parse(readFileSync('/etc/backroadbum/payments.json', 'utf8'));
  if (existsSync(SHIP_GRANT_PATH)) {
    validateShipGrant(JSON.parse(readFileSync(SHIP_GRANT_PATH, 'utf8')), config);
    console.log('Existing Ship grant preserved; no credentials emitted.');
  } else {
    const value = validateShipGrant({ schema: 'backroadbum.ship-grant/v1', siteId: 'backroadbum', enabled: false,
      storeKey: 'dk_store_' + randomBytes(32).toString('base64url') }, config);
    writeFileSync(SHIP_GRANT_PATH, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    console.log('Separate Ship admin key created, disabled; no credentials emitted.');
  }
} catch { console.error('Ship grant preparation refused; no configuration or credentials emitted.'); process.exitCode = 1; }
