// Initialize only disabled, unselected admission in the existing private, snapshotted Payments DB.
// Never select/enable, overwrite a chosen ID or reset its original freshness cutoff.
import { readFileSync, lstatSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { commerceShipAdmission, privateShipGeneration } from './commerce-ship.mjs';
let db;
try {
  const config = JSON.parse(readFileSync('/etc/backroadbum/payments.json', 'utf8'));
  const generation = privateShipGeneration();
  process.umask(0o077);
  const path = '/var/lib/backroadbum/payments/attempts.db', stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw Error('existing_private_store_required');
  db = new DatabaseSync(path); db.exec('PRAGMA busy_timeout=5000;');
  const binding = JSON.stringify([config.issuer, config.subject, config.siteId, config.origin, config.audience, config.bindingRef, config.stripeAccountId, 'test']);
  if (db.prepare('SELECT value FROM merchant_binding WHERE id=1').get()?.value !== binding) throw Error('merchant_binding_mismatch');
  const kept = commerceShipAdmission(db, config, generation).initialize();
  if (kept.orderId !== null || kept.enabled || kept.revision !== 0) throw Error('unselected_admission_required');
  console.log('Commerce Ship admission initialized/verified: unselected and disabled.');
} catch { console.error('Commerce Ship initialization refused; no configuration or credentials emitted.'); process.exitCode = 1; }
finally { db?.close(); }
