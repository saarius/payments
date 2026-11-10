// Merchant issuer extension, not a Payments product capability or shared Connect grant.
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
export const SHIP_AUDIENCE = 'backroadbum-ship';
export const SHIP_SCOPE = 'ship:admin';
export const SHIP_GRANT_PATH = '/etc/backroadbum/ship-grant.json';
export function validateShipGrant(value, config) {
  if (config.origin !== 'https://backroadbum.com' || config.issuer !== config.origin || config.siteId !== 'backroadbum' ||
      !value || Object.keys(value).sort().join() !== 'enabled,schema,siteId,storeKey' ||
      value.schema !== 'backroadbum.ship-grant/v1' || value.siteId !== config.siteId || typeof value.enabled !== 'boolean' ||
      typeof value.storeKey !== 'string' || !/^dk_store_[A-Za-z0-9_-]{43}$/.test(value.storeKey) || value.storeKey === config.storeKey) {
    throw Error('invalid_ship_grant');
  }
  return value;
}
/** Read on each exchange: missing, disabled, linked, oversized or permissive files grant nothing. */
export function readShipGrant(config, path = SHIP_GRANT_PATH) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) return null;
    const value = validateShipGrant(JSON.parse(readFileSync(fd, 'utf8')), config);
    return value.enabled ? value : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
