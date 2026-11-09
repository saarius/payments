// Read-only, public-safe account diagnostics. Requires the operator's test environment.
import { readFileSync } from 'node:fs';
import Stripe from 'stripe';
import { createStripeClient, accountReadiness, ACCOUNTS_STRIPE_API_VERSION } from '../../src/stripe/onboarding.ts';
async function main() {
const config = JSON.parse(readFileSync('/etc/backroadbum/payments.json', 'utf8'));
const key = process.env.STRIPE_API_KEY;
if (!key?.startsWith('sk_test_')) throw Error('test_key_required');
const account = await createStripeClient(key, 'test').accounts.retrieveCurrent();
const report = { checkedAt: new Date().toISOString(), identityMatches: account.id === config.stripeAccountId,
  v1: { chargesEnabled: account.charges_enabled ?? null, detailsSubmitted: account.details_submitted ?? null,
    cardPayments: account.capabilities?.card_payments ?? null, disabledReason: account.requirements?.disabled_reason ?? null,
    currentlyDueCount: account.requirements?.currently_due?.length ?? null, pastDueCount: account.requirements?.past_due?.length ?? null }, v2: null };
try {
  const stripe = new Stripe(key, { apiVersion: ACCOUNTS_STRIPE_API_VERSION, timeout: 10000, maxNetworkRetries: 0 });
  const v2 = await stripe.v2.core.accounts.retrieve(config.stripeAccountId, { include: ['configuration.merchant', 'requirements'] });
  report.v2 = accountReadiness(v2, config.stripeAccountId, 'test');
  // The identity is already reported as a boolean; don't repeat an account reference.
  delete report.v2.id;
} catch { report.v2 = { state: 'unavailable' }; }
console.log(JSON.stringify(report, null, 2));
}
main().catch(() => {
  console.error('Account diagnostic refused; no provider exception or credentials emitted.');
  process.exitCode = 1;
});
