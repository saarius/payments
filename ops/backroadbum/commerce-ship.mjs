// Merchant issuer configuration, not an order/payment model. One immutable generation and chosen ID.
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
export function validateCommerceShip(value, config, generation) {
  if (config.mode !== 'test' || config.origin !== 'https://backroadbum.com' || config.issuer !== config.origin || config.siteId !== 'backroadbum' ||
      !value || Object.keys(value).sort().join() !== 'enabled,generation,notBefore,orderId,revision,schema' ||
      value.schema !== 'backroadbum.commerce-ship/v1' || value.generation !== generation ||
      typeof generation !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(generation) ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.enabled !== 'boolean' ||
      value.orderId !== null && (typeof value.orderId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.orderId)) ||
      value.enabled && !value.orderId || value.revision === 0 && (value.orderId !== null || value.enabled) ||
      typeof value.notBefore !== 'string' || !Number.isFinite(Date.parse(value.notBefore)) || new Date(value.notBefore).toISOString() !== value.notBefore) throw Error('invalid_commerce_ship_admission');
  return value;
}
export function commerceShipAdmission(db, config, generation) {
  const validate = value => validateCommerceShip(value, config, generation);
  const read = () => validate(JSON.parse(db.prepare('SELECT value FROM merchant_ship_admission WHERE id=1').get()?.value));
  return {
    read,
    initialize() {
      db.exec('BEGIN IMMEDIATE');
      try {
        const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='merchant_ship_admission'").get();
        if (!exists) {
          const initial = validate({ schema: 'backroadbum.commerce-ship/v1', generation, revision: 0, orderId: null, enabled: false, notBefore: new Date().toISOString() });
          db.exec('CREATE TABLE merchant_ship_admission (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
          db.prepare('INSERT INTO merchant_ship_admission VALUES (1, ?)').run(JSON.stringify(initial));
        }
        const kept = read(); db.exec('COMMIT'); return kept;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    // Loopback/operator tooling only; never exposed by the issuer HTTP handler.
    change(command) {
      if (!command || Object.keys(command).sort().join() !== 'enabled,orderId,revision' || !Number.isSafeInteger(command.revision) || command.revision < 0) throw Error('invalid_admission_command');
      db.exec('BEGIN IMMEDIATE');
      try {
        const kept = read();
        validate({ ...kept, ...command, revision: kept.revision + 1 });
        if (command.revision !== kept.revision || kept.revision >= Number.MAX_SAFE_INTEGER) throw Error('stale_admission');
        if (kept.orderId !== null && command.orderId !== kept.orderId) throw Error('order_pinned');
        const next = kept.orderId === command.orderId && kept.enabled === command.enabled ? kept : validate({ ...kept, ...command, revision: kept.revision + 1 });
        db.prepare('UPDATE merchant_ship_admission SET value=? WHERE id=1').run(JSON.stringify(next));
        db.exec('COMMIT'); return next;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}
export function privateShipGeneration(path = '/etc/backroadbum/ship.json') {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) throw Error('private_ship_configuration_required');
    const ship = JSON.parse(readFileSync(fd, 'utf8'));
    if (ship.schema !== 'backroadbum.ship-node/v1' || ship.allowedOrderId !== '') throw Error('dynamic_host_required');
    return ship.generation;
  } finally { if (fd !== undefined) closeSync(fd); }
}
/** Current durable row and matching private host generation; no missing-row reset or Payments failure. */
export function readCommerceShip(config, db, shipPath) {
  try { return commerceShipAdmission(db, config, privateShipGeneration(shipPath)).read(); }
  catch { return null; }
}
