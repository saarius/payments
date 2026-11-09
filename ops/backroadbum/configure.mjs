// Operator-only bootstrap. Does not read or change stripe.env, or overwrite credentials.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync, chownSync } from 'node:fs';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const config = {
  schema: 'backroadbum.payments-node/v1', mode: 'test', origin: 'https://backroadbum.com',
  issuer: 'https://backroadbum.com', subject: 'backroadbum-owner', audience: 'backroadbum-payments',
  siteId: 'backroadbum', bindingRef: 'brb_stripe_test_v1', stripeAccountId: 'acct_1UYar0LKTp5cLbjq',
  storeKey: `dk_store_${randomBytes(32).toString('base64url')}`, privateKey, publicKey,
};
const path = '/etc/backroadbum/payments.json';
writeFileSync(path, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
chownSync(path, 1000, 1000);
console.log('Private merchant configuration created; existing Stripe credentials unchanged.');
