# Backroad Bum private Payments host

Merchant-only Node 24 operations code on `saarius/payments:backroadbum/test-runtime`, based on the same v0.5.0 source as the installed Registry plugin. It composes Payments' existing Checkout Session, provider, authentication and HTTP ports with durable SQLite claims; Commerce still owns prices, checkout snapshots, attempts, orders and receipts. This is not a new package entry point, upstream proposal, or replacement Registry plugin.

`runtime.mjs` listens only on `127.0.0.1:8787`. It rejects non-test keys and verifies that the key belongs to the configured own-account sandbox before listening or admitting a new session. This is not connected-account readiness: the actual sandbox accepted an unpaid TEST session while its v1 `charges_enabled` flag was false. Stripe documents sandbox use before live activation at https://docs.stripe.com/get-started/account/activate. A private ES256 issuer binds five-minute passes to this single merchant, site, origin, audience and scope; immutable binding metadata and attempts survive restart. HTTP 5xx responses never include processor exception text.

## Operator setup

On this host only, install dependencies on Node 24, run `sudo node ops/backroadbum/configure.mjs` once, and create `/var/lib/backroadbum/payments` owned by `agent`, mode 0700. The bootstrap creates `/etc/backroadbum/payments.json` with mode 0600 and refuses to replace an existing file. Stripe credentials remain in the operator-managed `/etc/backroadbum/stripe.env`; do not copy them into the repository or change that file.

Install the supplied systemd unit, reload systemd, and enable `backroadbum-payments.service`. Run `node --import tsx --test tests/backroadbum-runtime.test.mjs` for the focused tests. `check.mjs` is a read-only authenticated check. With the private test environment loaded, `diagnose-account.mjs` emits only redacted readiness facts; `probe-checkout.mjs --run` explicitly creates one unpaid $1 TEST session through Payments, retrieves it, and immediately expires it. The probe has no card input and is not a Commerce order or paid-order proof. No package publication or shared DinkusKit service deployment is involved.

## Explicitly unfinished

The storefront is **not connected**. Its pinned Commerce Registry bundle exchanges store keys only at a fixed DinkusKit.com address and does not admit this merchant's service host. Any future wiring must deliberately bind the merchant-owned issuer and transport without impersonating DinkusKit.com or relaxing sandbox allowlists. Keep shopper checkout closed until Commerce-backed Stripe Test checkout, a paid order, receipt/recovery, and browser checks pass.

Webhooks, durable wake delivery, Commerce reconciliation, and Ship integration are not wired here. In particular, v0.5.0's webhook matcher expects a connected-account `event.account`, while direct own-account events need separately verified account provenance; do not synthesize that field or treat an event as payment proof. Provider lookup remains the authority. There are no Sales, catalog, cart, order or receipt tables in this runtime.

The normal site backup includes a consistent copy of `payments/attempts.db`. Each database is copied consistently, not as one cross-service transaction; a restore must reconcile outstanding attempts with the provider. Secrets require separate operator recovery and must never enter a public artifact. Local snapshots alone are not off-host recovery.
