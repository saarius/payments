// This merchant has a direct own-account TEST key, not a Connect account.
// Never add event.account: independently retrieve the signed event ID in the
// verified key's own-account API context, then use Payments' session matcher.
import { WebhookError } from '../../src/checkout/webhook.ts';

function identity(event) {
  const session = event?.data?.object;
  if (!event || typeof event.id !== 'string' || !/^evt_[A-Za-z0-9]+$/.test(event.id) ||
      event.type !== 'checkout.session.completed' || event.livemode !== false ||
      event.account !== undefined || session?.object !== 'checkout.session' ||
      typeof session.id !== 'string' || !/^cs_test_[A-Za-z0-9]+$/.test(session.id) || session.livemode !== false) {
    throw new WebhookError('own_account_event_mismatch');
  }
  const fields = ['dinkus_attempt', 'dinkus_binding', 'dinkus_site'];
  if (fields.some(key => typeof session.metadata?.[key] !== 'string' || !session.metadata[key] || session.metadata[key].length > 200)) {
    throw new WebhookError('missing_attempt');
  }
  return JSON.stringify([event.id, event.type, event.livemode, session.id, ...fields.map(key => session.metadata[key])]);
}

export function createOwnAccountWebhook({ config, verify, retrieveEvent, verifyOwnAccount, sessions, store }) {
  return async (payload, signature, stripeAccountHeader) => {
    const event = await verify(payload, signature); // Raw bytes, before field access.
    if (event.type !== 'checkout.session.completed') return;
    const signedIdentity = identity(event);
    if (stripeAccountHeader && stripeAccountHeader !== config.stripeAccountId) throw new WebhookError('account_mismatch');
    await verifyOwnAccount();
    const canonical = await retrieveEvent(event.id); // No Stripe-Account header.
    if (identity(canonical) !== signedIdentity) throw new WebhookError('canonical_event_mismatch');
    const session = canonical.data.object;
    const record = sessions.readAttempt(session.metadata.dinkus_attempt);
    if (!record) throw new WebhookError('unknown_attempt');
    if (record.stripeSessionId !== session.id) throw new WebhookError('session_mismatch');
    if (record.bindingRef !== session.metadata.dinkus_binding || record.bindingRef !== config.bindingRef ||
        record.siteId !== session.metadata.dinkus_site || record.siteId !== config.siteId ||
        record.stripeAccountId !== config.stripeAccountId || record.mode !== 'test') throw new WebhookError('binding_mismatch');
    await sessions.retrieveAndMatch(record); // Existing Payments amount/window/session checks; never create.
    store.enqueueWake({ eventId: event.id, attemptId: record.attemptId, siteId: record.siteId,
      bindingRef: record.bindingRef, stripeAccountId: record.stripeAccountId, mode: record.mode });
    // A durable insert (or exact existing event) is required before HTTP200.
  };
}
