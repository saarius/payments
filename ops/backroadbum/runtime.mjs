// Merchant-only Node 24 host for the pinned Payments v0.5.0 service ports.
// Not a plugin replacement, product setup flow, or source of Commerce prices/orders.
import { DatabaseSync } from 'node:sqlite';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createStripeClient } from '../../src/stripe/onboarding.ts';
import { importPKCS8, importSPKI, exportJWK, SignJWT } from 'jose';
import { createCheckoutSessionService } from '../../src/checkout/sessions.ts';
import { createStripeCheckout } from '../../src/stripe/checkout.ts';
import { createAccountAuthenticator } from '../../src/hosted/auth.ts';
import { createHostedHandler } from '../../src/hosted/http.ts';
import { createStripeWebhookVerifier } from '../../src/checkout/webhook.ts';
import { createWakeStorage } from './wakes.mjs';
import { createOwnAccountWebhook } from './webhook.mjs';
import { readShipGrant, validateShipGrant, SHIP_AUDIENCE, SHIP_SCOPE } from './ship-grant.mjs';

const json = (body, status = 200) => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
});
const equal = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export function validateConfig(config, apiKey) {
  if (!apiKey?.startsWith('sk_test_') || apiKey.length <= 'sk_test_'.length) throw Error('test_key_required');
  if (!config || config.schema !== 'backroadbum.payments-node/v1' || config.mode !== 'test') throw Error('invalid_configuration');
  for (const name of ['origin', 'issuer']) {
    const url = new URL(config[name]);
    if (url.protocol !== 'https:' || url.origin !== config[name]) throw Error('invalid_origin');
  }
  for (const name of ['siteId', 'subject', 'audience', 'bindingRef']) {
    if (typeof config[name] !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(config[name])) throw Error('invalid_identity');
  }
  if (!/^acct_[a-zA-Z0-9]+$/.test(config.stripeAccountId)) throw Error('invalid_account');
  if (!/^dk_store_[a-zA-Z0-9_-]{43}$/.test(config.storeKey)) throw Error('invalid_store_key');
  return config;
}

/** Synchronous SQLite claims remain atomic across processes and restart. */
export function openAttemptStore(path, config) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
  db.exec('CREATE TABLE IF NOT EXISTS merchant_binding (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const binding = JSON.stringify([config.issuer, config.subject, config.siteId, config.origin, config.audience, config.bindingRef, config.stripeAccountId, 'test']);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO merchant_binding VALUES (1, ?)').run(binding);
    if (db.prepare('SELECT value FROM merchant_binding WHERE id=1').get().value !== binding) throw Error('immutable_binding_mismatch');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  const read = db.prepare('SELECT value FROM attempts WHERE id=?');
  const write = db.prepare('INSERT INTO attempts VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value');
  return {
    ...createWakeStorage(db, config),
    close: () => db.close(),
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn({
          read(id) { const row = read.get(id); return row ? JSON.parse(row.value) : null; },
          write(value) { write.run(value.attemptId, JSON.stringify(value)); },
        });
        if (result && typeof result.then === 'function') throw Error('synchronous_transaction_required');
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}

/** Merchant-owned configuration; no secret or browser-supplied money enters it. */
export function merchantCheckoutSettings(config) {
  return { schema: 'dinkuskit.commerce.registry-checkout/v1', enabled: true, commerceOrigin: config.origin,
    siteId: config.siteId, paymentsOrigin: config.origin, bindingRef: config.bindingRef,
    providerId: 'stripe', stripeAccountId: config.stripeAccountId, mode: 'test',
    pricingSchema: 'dinkuskit.commerce.checkout-pricing/v1', issuer: config.issuer, audience: config.audience,
    shipping: { configurationId: 'brb_free_test_v1', revision: 1, mode: 'free' } };
}

/** Transport composition only: all amount/window/session matching stays in Payments. */
export async function createMerchantRuntime({ config, apiKey, store, provider, accountStatus, webhookSecret, retrieveEvent, shipGrant = () => null }) {
  validateConfig(config, apiKey);
  const privateKey = await importPKCS8(config.privateKey, 'ES256');
  const publicKey = await importSPKI(config.publicKey, 'ES256', { extractable: true });
  const jwks = { keys: [{ ...await exportJWK(publicKey), kid: 'brb-owner-v1', alg: 'ES256', use: 'sig' }] };
  const authenticatePass = createAccountAuthenticator({
    issuer: config.issuer, audience: config.audience, jwksUrl: `${config.issuer}/.well-known/jwks.json`,
  }, async () => publicKey);
  const settingsAudience = 'backroadbum-commerce';
  const authenticateSettings = createAccountAuthenticator({
    issuer: config.issuer, audience: settingsAudience, jwksUrl: `${config.issuer}/.well-known/jwks.json`,
  }, async () => publicKey);
  const owner = { accountId: JSON.stringify([config.issuer, config.subject]), siteId: config.siteId, siteOrigin: config.origin };
  const owned = principal => principal.accountId === owner.accountId && principal.siteId === owner.siteId && principal.siteOrigin === owner.siteOrigin;
  const binding = { bindingRef: config.bindingRef, providerId: 'stripe', stripeAccountId: config.stripeAccountId, mode: 'test' };
  const existingBinding = (principal, ref) => owned(principal) && ref === binding.bindingRef ? binding : null;
  async function readyBinding(principal, ref) {
    if (!existingBinding(principal, ref)) return null;
    const account = await accountStatus();
    // This key belongs to the TEST sandbox itself, not a connected merchant.
    // v1 charges_enabled was false here while real TEST Checkout succeeded.
    // This own-account check is NOT connected-account or live readiness.
    return account.object === 'account' && account.id === binding.stripeAccountId ? binding : null;
  }
  const sessions = createCheckoutSessionService({
    store, provider, mode: 'test', readyBinding, existingBinding,
    successUrl: `${config.origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${config.origin}/checkout`,
  });
  const connection = {
    async status(principal) {
      const ready = await readyBinding(principal, binding.bindingRef);
      return { state: ready ? 'ready' : 'checking', mode: 'test', bindingRef: binding.bindingRef,
        connectionEvidence: { provider: 'stripe', mode: 'test', result: ready ? 'verified' : 'unknown', accountRef: config.stripeAccountId } };
    },
    async connect() { throw Error('operator_setup_required'); },
    checkoutBinding: readyBinding, existingBinding,
  };
  let webhook;
  if (webhookSecret) {
    if (typeof retrieveEvent !== 'function') throw Error('event_retriever_required');
    const verifier = createStripeWebhookVerifier({ apiKey, webhookSecret });
    webhook = createOwnAccountWebhook({ config, sessions, store,
      async verify(payload, signature) {
        try { return await verifier.verify(payload, signature); }
        catch (error) {
          if (error?.type === 'StripeSignatureVerificationError' || error instanceof SyntaxError) throw Error('invalid_signature');
          throw Error('verification_unavailable');
        }
      }, retrieveEvent,
      async verifyOwnAccount() {
        const account = await accountStatus();
        if (account.object !== 'account' || account.id !== config.stripeAccountId) throw Error('stripe_account_mismatch');
      },
    });
  }
  const hosted = createHostedHandler({
    webhook,
    wakes: () => ({ list: (ref, limit) => store.listWakes(ref, limit), acknowledge: wake => store.acknowledgeWake(wake) }),
    async authenticate(request, scope) {
      const principal = await authenticatePass(request, scope);
      if (!owned(principal)) throw Error('unauthorized');
      return principal;
    },
    service: () => connection,
    checkout: principal => sessions.forPrincipal(principal),
  });
  return {
    sessions,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/health' && request.method === 'GET' && !url.search) {
        const stats = webhook ? store.wakeStats() : null;
        return json({ service: 'backroadbum-payments', mode: 'test', webhookConfigured: Boolean(webhook),
          webhookConnected: Boolean(stats?.received), pendingWakes: stats?.pending ?? null,
          acknowledgedWakes: stats?.acknowledged ?? null, lastWebhookAt: stats?.lastReceivedAt ?? null });
      }
      if (url.pathname === '/.well-known/jwks.json') {
        if (request.method !== 'GET' || url.search) return json({ error: 'unexpected_input' }, 405);
        return json(jwks);
      }
      if (url.pathname === '/api/store-passes') {
        if (request.method !== 'POST' || url.search) return json({ error: 'method_not_allowed' }, 405);
        const bearer = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? '';
        // Distinct plugin keys have disjoint grants. A broken Ship grant cannot stop Payments.
        const commerce = equal(bearer, config.storeKey);
        let ship = false;
        if (!commerce) {
          try {
            const grant = validateShipGrant(await shipGrant(), config);
            ship = grant.enabled && equal(bearer, grant.storeKey);
          } catch { /* no Ship grant */ }
        }
        if (!commerce && !ship) return json({ error: 'unauthorized' }, 401);
        try {
          const body = await request.json();
          if (!body || Object.keys(body).sort().join() !== 'audience,scope,site_id' || body.site_id !== config.siteId ||
              !(commerce && (body.audience === config.audience && ['payments:checkout', 'payments:admin'].includes(body.scope) ||
                body.audience === settingsAudience && body.scope === 'commerce:settings') ||
                ship && body.audience === SHIP_AUDIENCE && body.scope === SHIP_SCOPE)) return json({ error: 'invalid_pass_request' }, 400);
          const token = await new SignJWT({ site_id: config.siteId, site_origin: config.origin, scope: body.scope })
            .setProtectedHeader({ alg: 'ES256', kid: 'brb-owner-v1' }).setIssuer(config.issuer).setAudience(body.audience)
            .setSubject(config.subject).setIssuedAt().setExpirationTime('5m').sign(privateKey);
          return json({ access_token: token, token_type: 'Bearer', expires_in: 300 });
        } catch { return json({ error: 'invalid_pass_request' }, 400); }
      }
      if (url.pathname === '/api/commerce-settings') {
        if (request.method !== 'GET' || url.search) return json({ error: 'unexpected_input' }, 400);
        try {
          const principal = await authenticateSettings(request, 'commerce:settings');
          return owned(principal) ? json(merchantCheckoutSettings(config)) : json({ error: 'unauthorized' }, 401);
        } catch { return json({ error: 'unauthorized' }, 401); }
      }
      if (url.pathname === '/v1/webhooks/stripe' && url.search) return json({ error: 'unexpected_input' }, 400);
      const response = await hosted(request);
      // Provider exceptions can include secret key fragments. Never forward 5xx messages.
      return response.status >= 500 ? json({ error: 'payments_unavailable' }, response.status) : response;
    },
  };
}

/** Bound and buffer before constructing a Web Request; never trust the Host header. */
export function createLoopbackServer(runtime, origin) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) { outgoing.writeHead(400).end(); return; }
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 128 * 1024) { outgoing.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(origin + incoming.url, { method: incoming.method, headers: incoming.headers,
        ...(!['GET', 'HEAD'].includes(incoming.method) && body ? { body } : {}) });
      const response = await runtime.fetch(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { if (!outgoing.headersSent) outgoing.writeHead(503); outgoing.end(); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 64;
  return server;
}

async function main() {
  process.umask(0o077);
  const config = validateConfig(JSON.parse(readFileSync('/etc/backroadbum/payments.json', 'utf8')), process.env.STRIPE_API_KEY);
  const stripe = createStripeClient(process.env.STRIPE_API_KEY, 'test');
  const accountStatus = () => stripe.accounts.retrieveCurrent();
  // Confirm credentials belong to the immutable receiving account before listening.
  if ((await accountStatus()).id !== config.stripeAccountId) throw Error('stripe_account_mismatch');
  const store = openAttemptStore('/var/lib/backroadbum/payments/attempts.db', config);
  const provider = createStripeCheckout({ apiKey: process.env.STRIPE_API_KEY, mode: 'test', ownAccountId: config.stripeAccountId });
  const runtime = await createMerchantRuntime({ config, apiKey: process.env.STRIPE_API_KEY, store, provider, accountStatus,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET, retrieveEvent: id => stripe.events.retrieve(id),
    shipGrant: () => readShipGrant(config) });
  const server = createLoopbackServer(runtime, config.origin);
  server.listen(8787, '127.0.0.1', () => console.log('Merchant Payments listening on loopback; test mode only.'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { store.close(); process.exit(0); }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Merchant Payments startup refused; check private configuration.'); process.exitCode = 1; });
}
