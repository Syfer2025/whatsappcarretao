const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createCheckoutSession,
  releaseExpiredCheckoutReservation,
  ensureStripeCustomer,
  deleteTenantBilling,
  verifyTenantSubscriptionAccess,
  getStripePriceId,
  handleWebhookEvent,
  mapStripeStatus,
  getCheckoutReservationSeconds,
  getBillingConfigurationStatus,
  validateStripeConfigurationConnectivity,
  resolveSubscriptionPlan,
  MAX_CHECKOUT_RESERVATION_SECONDS,
  CHECKOUT_EXPIRATION_SAFETY_SECONDS
} = require('./billing');

test('validates the effective production Stripe configuration as one atomic set', () => {
  const base = {
    NODE_ENV: 'production',
    STRIPE_SECRET_KEY: 'sk_live_valid123',
    STRIPE_WEBHOOK_SECRET: 'whsec_valid123'
  };

  assert.deepEqual(
    getBillingConfigurationStatus({ ...base, STRIPE_PRICE_ID: 'price_fallback123' }),
    { configured: true, strategy: 'fallback' }
  );
  assert.deepEqual(
    getBillingConfigurationStatus({
      ...base,
      STRIPE_PRICE_ID_BASIC: 'price_basic123',
      STRIPE_PRICE_ID_PRO: 'price_pro123'
    }),
    { configured: true, strategy: 'per_plan' }
  );
  assert.equal(getBillingConfigurationStatus({
    ...base,
    STRIPE_SECRET_KEY: 'sk_test_forbidden123',
    STRIPE_PRICE_ID: 'price_fallback123'
  }).reason, 'secret_key_not_live');
  assert.equal(getBillingConfigurationStatus({
    ...base,
    STRIPE_PRICE_ID: 'price_fallback123',
    STRIPE_PRICE_ID_BASIC: 'price_basic123',
    STRIPE_PRICE_ID_PRO: 'price_pro123'
  }).reason, 'mixed_price_strategies');
  assert.equal(getBillingConfigurationStatus({
    ...base,
    STRIPE_PRICE_ID_BASIC: 'price_same123',
    STRIPE_PRICE_ID_PRO: 'price_same123'
  }).reason, 'duplicate_plan_prices');
  assert.equal(getBillingConfigurationStatus({
    ...base,
    STRIPE_PRICE_ID_BASIC: 'price_basic123'
  }).reason, 'missing_or_invalid_plan_prices');
});

test('validates Stripe account and per-plan recurring prices through the same isolated client', async () => {
  const accountArguments = [];
  const retrievedPriceIds = [];
  const stripe = {
    accounts: {
      async retrieve(accountId) {
        accountArguments.push(accountId);
        return { id: 'acct_live_owner' };
      }
    },
    prices: {
      async retrieve(priceId) {
        retrievedPriceIds.push(priceId);
        return {
          id: priceId,
          active: true,
          livemode: true,
          type: 'recurring',
          recurring: { interval: 'month' }
        };
      }
    }
  };

  const result = await validateStripeConfigurationConnectivity({
    NODE_ENV: 'production',
    STRIPE_SECRET_KEY: 'sk_live_connectivity123',
    STRIPE_PRICE_ID_BASIC: 'price_basiclive123',
    STRIPE_PRICE_ID_PRO: 'price_prolive123'
  }, { stripe });

  assert.deepEqual(accountArguments, [null]);
  assert.deepEqual(retrievedPriceIds.sort(), ['price_basiclive123', 'price_prolive123']);
  assert.deepEqual(result, {
    valid: true,
    accountId: 'acct_live_owner',
    livemode: true,
    strategy: 'per_plan',
    priceIds: {
      basic: 'price_basiclive123',
      professional: 'price_prolive123'
    }
  });
});

test('validates the single-price strategy without requiring webhook connectivity', async () => {
  const retrievedPriceIds = [];
  const result = await validateStripeConfigurationConnectivity({
    NODE_ENV: 'test',
    STRIPE_SECRET_KEY: 'sk_test_connectivity123',
    STRIPE_PRICE_ID: 'price_sharedtest123'
  }, {
    stripe: {
      accounts: { retrieve: async () => ({ id: 'acct_test_owner' }) },
      prices: {
        async retrieve(priceId) {
          retrievedPriceIds.push(priceId);
          return {
            id: priceId,
            active: true,
            livemode: false,
            type: 'recurring',
            recurring: { interval: 'month' }
          };
        }
      }
    }
  });

  assert.deepEqual(retrievedPriceIds, ['price_sharedtest123']);
  assert.equal(result.strategy, 'fallback');
  assert.deepEqual(result.priceIds, { fallback: 'price_sharedtest123' });
});

test('Stripe connectivity validation rejects unusable prices and classifies API failures', async t => {
  const env = {
    NODE_ENV: 'production',
    STRIPE_SECRET_KEY: 'sk_live_connectivity123',
    STRIPE_PRICE_ID_BASIC: 'price_basiclive123',
    STRIPE_PRICE_ID_PRO: 'price_prolive123'
  };
  const validPrice = priceId => ({
    id: priceId,
    active: true,
    livemode: true,
    type: 'recurring',
    recurring: { interval: 'month' }
  });
  const stripeWithPrices = retrieve => ({
    accounts: { retrieve: async () => ({ id: 'acct_live_owner' }) },
    prices: { retrieve }
  });

  await t.test('inactive price', async () => {
    await assert.rejects(
      validateStripeConfigurationConnectivity(env, {
        stripe: stripeWithPrices(async priceId => ({ ...validPrice(priceId), active: false }))
      }),
      error => error.code === 'STRIPE_CONFIGURATION_INVALID'
        && error.statusCode === 400
        && error.reason === 'inactive_price'
    );
  });

  await t.test('one-time price', async () => {
    await assert.rejects(
      validateStripeConfigurationConnectivity(env, {
        stripe: stripeWithPrices(async priceId => ({
          ...validPrice(priceId),
          type: 'one_time',
          recurring: null
        }))
      }),
      error => error.code === 'STRIPE_CONFIGURATION_INVALID'
        && error.reason === 'non_recurring_price'
    );
  });

  await t.test('test price paired with live key', async () => {
    await assert.rejects(
      validateStripeConfigurationConnectivity(env, {
        stripe: stripeWithPrices(async priceId => ({ ...validPrice(priceId), livemode: false }))
      }),
      error => error.code === 'STRIPE_CONFIGURATION_INVALID'
        && error.reason === 'price_mode_mismatch'
    );
  });

  await t.test('price from another account', async () => {
    const missing = new Error('No such price');
    missing.statusCode = 404;
    missing.code = 'resource_missing';
    await assert.rejects(
      validateStripeConfigurationConnectivity(env, {
        stripe: stripeWithPrices(async () => { throw missing; })
      }),
      error => error.code === 'STRIPE_CONFIGURATION_INVALID'
        && error.statusCode === 400
        && error.reason === 'price_not_found'
        && error.cause === missing
        && !Object.prototype.propertyIsEnumerable.call(error, 'cause')
    );
  });

  await t.test('transient account API failure', async () => {
    const networkError = new Error('connection reset');
    await assert.rejects(
      validateStripeConfigurationConnectivity(env, {
        stripe: {
          accounts: { retrieve: async () => { throw networkError; } },
          prices: { retrieve: async priceId => validPrice(priceId) }
        }
      }),
      error => error.code === 'STRIPE_CONFIGURATION_UNAVAILABLE'
        && error.statusCode === 503
        && error.reason === 'account_retrieve_failed'
        && error.cause === networkError
    );
  });
});

test('historical tenant price remains valid after configured Stripe prices rotate', async () => {
  const tenant = {
    id: 41,
    plan: 'basico',
    stripe_customer_id: 'cus_41',
    stripe_subscription_id: 'sub_41',
    stripe_price_id: 'price_basicprevious'
  };
  const subscription = {
    id: 'sub_41',
    customer: 'cus_41',
    status: 'active',
    metadata: { tenant_id: '41', plan: 'basico' },
    items: { data: [{ price: { id: 'price_basicprevious' } }] }
  };
  const rotatedEnv = {
    STRIPE_PRICE_ID_BASIC: 'price_basiccurrent',
    STRIPE_PRICE_ID_PRO: 'price_procurrent'
  };

  assert.deepEqual(resolveSubscriptionPlan(subscription, tenant, rotatedEnv), {
    valid: true,
    reason: null,
    plan: 'basico',
    priceId: 'price_basicprevious'
  });
  const verified = await verifyTenantSubscriptionAccess(tenant, {
    stripe: { subscriptions: { retrieve: async () => subscription } },
    env: rotatedEnv
  });
  assert.equal(verified.status, 'active');
  assert.equal(verified.plan, 'basico');
  assert.equal(verified.priceId, 'price_basicprevious');

  const conflictingMetadata = {
    ...subscription,
    metadata: { tenant_id: '41', plan: 'profissional' }
  };
  assert.equal(
    resolveSubscriptionPlan(conflictingMetadata, tenant, rotatedEnv).reason,
    'price_plan_mismatch'
  );
});

test('selects price by plan and only carries the remaining local trial when at least 48 hours remain', async () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);
  const checkoutPayloads = [];
  const checkoutOptions = [];
  const customerPayloads = [];
  const customerOptions = [];
  let sessionSequence = 0;
  const stripe = {
    customers: {
      async create(payload, options) {
        customerPayloads.push(payload);
        customerOptions.push(options);
        return { id: 'cus_created' };
      }
    },
    checkout: {
      sessions: {
        async create(payload, options) {
          checkoutPayloads.push(payload);
          checkoutOptions.push(options);
          sessionSequence += 1;
          return { id: `cs_${sessionSequence}`, url: 'https://checkout.test' };
        }
      }
    }
  };
  const env = {
    STRIPE_PRICE_ID_BASIC: 'price_basic',
    STRIPE_PRICE_ID_PRO: 'price_pro',
    STRIPE_PRICE_ID: 'price_fallback'
  };
  const updateTenant = tenant => (id, fields) => {
    assert.equal(id, tenant.id);
    Object.assign(tenant, fields);
    return tenant;
  };

  const basicTenant = {
    id: 7,
    name: 'Basico',
    plan: 'basico',
    billing_status: 'trialing',
    trial_ends_at: new Date(now + 72 * 60 * 60 * 1000).toISOString(),
    stripe_customer_id: null,
    stripe_subscription_id: null
  };
  await createCheckoutSession(basicTenant, 'admin@example.test', {
    successUrl: 'https://app.test/success',
    cancelUrl: 'https://app.test/cancel'
  }, {
    stripe,
    env,
    now: () => now,
    setBillingFields: updateTenant(basicTenant)
  });

  assert.deepEqual(customerPayloads, [{
    name: 'Basico',
    email: 'admin@example.test',
    metadata: { tenant_id: '7' }
  }]);
  assert.equal(customerOptions[0].idempotencyKey, 'tenant-7-customer-v1');
  assert.equal(checkoutPayloads[0].payment_method_collection, 'always');
  assert.equal(checkoutPayloads[0].line_items[0].price, 'price_basic');
  assert.equal(checkoutPayloads[0].client_reference_id, '7');
  assert.equal(
    checkoutPayloads[0].expires_at,
    Math.floor(now / 1000) + 30 * 60 + CHECKOUT_EXPIRATION_SAFETY_SECONDS
  );
  assert.deepEqual(checkoutPayloads[0].metadata, { tenant_id: '7', plan: 'basico' });
  assert.equal(checkoutOptions[0].idempotencyKey, 'tenant-7-checkout-basico-initial');
  assert.equal(
    checkoutPayloads[0].subscription_data.trial_end,
    Math.floor(new Date(basicTenant.trial_ends_at).getTime() / 1000)
  );
  assert.equal(basicTenant.stripe_checkout_session_id, 'cs_1');
  assert.equal(
    basicTenant.checkout_expires_at,
    new Date((Math.floor(now / 1000) + 30 * 60 + CHECKOUT_EXPIRATION_SAFETY_SECONDS) * 1000).toISOString()
  );
  assert.equal(basicTenant.stripe_price_id, 'price_basic');

  const proTenant = {
    id: 8,
    name: 'Pro',
    plan: 'profissional',
    billing_status: 'trialing',
    trial_ends_at: new Date(now + (48 * 60 * 60 * 1000) - 1).toISOString(),
    stripe_customer_id: 'cus_pro',
    stripe_subscription_id: null
  };
  await createCheckoutSession(proTenant, 'pro@example.test', {
    successUrl: 'https://app.test/success',
    cancelUrl: 'https://app.test/cancel'
  }, {
    stripe,
    env,
    now: () => now,
    setBillingFields: updateTenant(proTenant)
  });

  assert.equal(checkoutPayloads[1].line_items[0].price, 'price_pro');
  assert.equal(Object.hasOwn(checkoutPayloads[1].subscription_data, 'trial_end'), false);
  assert.equal(getStripePriceId('basico', { STRIPE_PRICE_ID: 'fallback' }), 'fallback');
  assert.throws(() => getStripePriceId('profissional', {}), /STRIPE_PRICE_ID_PRO/);

  const pendingTenant = {
    ...basicTenant,
    id: 9,
    billing_status: 'checkout_pending',
    stripe_customer_id: 'cus_pending',
    stripe_checkout_session_id: null,
    trial_ends_at: new Date(now + 72 * 60 * 60 * 1000).toISOString()
  };
  await createCheckoutSession(pendingTenant, 'pending@example.test', {
    successUrl: 'https://app.test/success',
    cancelUrl: 'https://app.test/cancel'
  }, {
    stripe,
    env,
    now: () => now,
    setBillingFields: updateTenant(pendingTenant)
  });
  assert.equal(checkoutPayloads[2].subscription_data.trial_end, Math.floor(new Date(pendingTenant.trial_ends_at).getTime() / 1000));

  const expiredPending = {
    ...pendingTenant,
    id: 10,
    stripe_customer_id: 'cus_expired_pending',
    stripe_checkout_session_id: null,
    trial_ends_at: new Date(now - 1000).toISOString()
  };
  await createCheckoutSession(expiredPending, 'retry@example.test', {
    successUrl: 'https://app.test/success',
    cancelUrl: 'https://app.test/cancel'
  }, {
    stripe,
    env,
    now: () => now,
    setBillingFields: updateTenant(expiredPending)
  });
  assert.equal(checkoutPayloads[3].subscription_data.trial_period_days, 3);
  assert.equal(expiredPending.trial_ends_at, new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString());
});

test('checkout expiration never exceeds the Stripe 24-hour ceiling after applying the safety margin', async () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0, 250);
  let checkoutPayload;
  const tenant = {
    id: 11,
    name: 'Limite Stripe',
    plan: 'basico',
    billing_status: 'trialing',
    trial_ends_at: new Date(now + 72 * 60 * 60 * 1000).toISOString(),
    stripe_customer_id: 'cus_limit',
    stripe_subscription_id: null,
    stripe_checkout_session_id: null
  };

  await createCheckoutSession(tenant, 'limit@example.test', {
    successUrl: 'https://app.test/success',
    cancelUrl: 'https://app.test/cancel'
  }, {
    stripe: {
      checkout: {
        sessions: {
          async create(payload) {
            checkoutPayload = payload;
            return { id: 'cs_limit', url: 'https://checkout.test/limit' };
          }
        }
      }
    },
    env: {
      STRIPE_PRICE_ID_BASIC: 'price_basic',
      STRIPE_CHECKOUT_RESERVATION_MINUTES: '1440'
    },
    now: () => now,
    setBillingFields(id, fields) {
      assert.equal(id, tenant.id);
      Object.assign(tenant, fields);
      return tenant;
    }
  });

  const expectedExpiration = Math.floor(now / 1000)
    + MAX_CHECKOUT_RESERVATION_SECONDS
    - CHECKOUT_EXPIRATION_SAFETY_SECONDS;
  assert.equal(checkoutPayload.expires_at, expectedExpiration);
  assert.equal(tenant.checkout_expires_at, new Date(expectedExpiration * 1000).toISOString());
});

test('checkout capacity reservation is bounded and released only after Stripe proves expiration', async () => {
  const now = Date.UTC(2026, 6, 10, 12, 31, 0);
  const expiresAt = Math.floor((now - 60_000) / 1000);
  const tenant = {
    id: 77,
    stripe_customer_id: 'cus_77',
    stripe_checkout_session_id: 'cs_77',
    stripe_subscription_id: null
  };
  const baseSession = {
    id: 'cs_77',
    status: 'open',
    expires_at: expiresAt,
    customer: 'cus_77',
    client_reference_id: '77',
    metadata: { tenant_id: '77', plan: 'basico' },
    subscription: null
  };
  let retrieveCalls = 0;
  let expireCalls = 0;
  const stripe = {
    checkout: {
      sessions: {
        async retrieve() {
          retrieveCalls += 1;
          return { ...baseSession };
        },
        async expire() {
          expireCalls += 1;
          return { ...baseSession, status: 'expired' };
        }
      }
    }
  };
  const released = await releaseExpiredCheckoutReservation(tenant, {
    stripe,
    now: () => now,
    setBillingFields() { throw new Error('nao deve prorrogar uma sessao vencida'); }
  });
  assert.equal(released.released, true);
  assert.equal(released.reason, 'checkout_expired');
  assert.equal(retrieveCalls, 1);
  assert.equal(expireCalls, 1);

  stripe.checkout.sessions.expire = async () => {
    expireCalls += 1;
    const error = new Error('already complete');
    error.code = 'checkout_session_completed';
    throw error;
  };
  stripe.checkout.sessions.retrieve = async () => {
    retrieveCalls += 1;
    return retrieveCalls % 2 === 0
      ? { ...baseSession }
      : { ...baseSession, status: 'complete', subscription: 'sub_77' };
  };
  const raced = await releaseExpiredCheckoutReservation(tenant, {
    stripe,
    now: () => now,
    setBillingFields() { throw new Error('nao deve atualizar'); }
  });
  assert.equal(raced.released, false);
  assert.equal(raced.reason, 'checkout_completed');

  assert.equal(getCheckoutReservationSeconds({}), 30 * 60);
  assert.equal(getCheckoutReservationSeconds({ STRIPE_CHECKOUT_RESERVATION_MINUTES: '1440' }), 24 * 60 * 60);
  assert.throws(
    () => getCheckoutReservationSeconds({ STRIPE_CHECKOUT_RESERVATION_MINUTES: '29' }),
    /entre 30 e 1440/
  );
});

test('expired checkout cannot be renewed indefinitely to monopolize runtime capacity', async () => {
  const tenant = {
    id: 78,
    name: 'Abandoned',
    plan: 'basico',
    billing_status: 'checkout_pending',
    stripe_customer_id: 'cus_78',
    stripe_checkout_session_id: 'cs_expired',
    stripe_subscription_id: null,
    trial_ends_at: new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
  };
  let created = false;
  await assert.rejects(
    createCheckoutSession(tenant, 'owner@example.test', {
      successUrl: 'https://app.test/success',
      cancelUrl: 'https://app.test/cancel'
    }, {
      stripe: {
        checkout: { sessions: {
          async retrieve() {
            return {
              id: 'cs_expired',
              status: 'expired',
              customer: 'cus_78',
              client_reference_id: '78',
              metadata: { tenant_id: '78', plan: 'basico' }
            };
          },
          async create() { created = true; }
        } }
      },
      env: { STRIPE_PRICE_ID_BASIC: 'price_basic' }
    }),
    error => error.statusCode === 410 && error.code === 'CHECKOUT_RESERVATION_EXPIRED'
  );
  assert.equal(created, false);
});

function createWebhookDomain() {
  const tenant = {
    id: 1,
    name: 'Tenant A',
    plan: 'basico',
    billing_status: 'trialing',
    trial_ends_at: new Date(200 * 1000).toISOString(),
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: null,
    stripe_price_id: 'price_basic',
    stripe_last_event_created: 0
  };
  const events = new Map();
  const audits = [];
  const notifications = [];

  return {
    tenant,
    events,
    audits,
    notifications,
    deps: {
      env: {
        STRIPE_PRICE_ID_BASIC: 'price_basic',
        STRIPE_PRICE_ID_PRO: 'price_professional'
      },
      listTenants: () => [tenant],
      getTenant: id => Number(id) === tenant.id ? tenant : null,
      setBillingFields(id, fields) {
        assert.equal(Number(id), tenant.id);
        Object.assign(tenant, fields);
        return tenant;
      },
      setBillingFieldsFromStripe(id, fields, { eventCreated, eventId }) {
        assert.equal(Number(id), tenant.id);
        if (eventCreated < Number(tenant.stripe_last_event_created || 0)) {
          return { applied: false, stale: true, tenant };
        }
        Object.assign(tenant, fields, {
          stripe_last_event_created: eventCreated,
          stripe_last_event_id: eventId
        });
        return { applied: true, stale: false, tenant };
      },
      beginStripeEvent(event) {
        const existing = events.get(event.id);
        if (existing && ['processed', 'ignored'].includes(existing.processing_status)) {
          return { shouldProcess: false, duplicate: true, record: existing };
        }
        const record = existing || {
          event_id: event.id,
          event_type: event.type,
          event_created: event.created,
          tenant_id: null,
          attempts: 0
        };
        record.processing_status = 'processing';
        record.attempts += 1;
        events.set(event.id, record);
        return { shouldProcess: true, duplicate: false, record };
      },
      finishStripeEvent(eventId, { tenantId, status, detail }) {
        Object.assign(events.get(eventId), {
          tenant_id: tenantId,
          processing_status: status,
          detail
        });
      },
      failStripeEvent(eventId, error) {
        Object.assign(events.get(eventId), {
          processing_status: 'failed',
          detail: error.message
        });
      },
      logAudit(actor, action, tenantId, detail) {
        audits.push({ actor, action, tenantId, detail });
      },
      getTenantDb() {
        return { prepare: () => ({ get: () => ({ username: 'admin@example.test' }) }) };
      },
      notifyPaymentFailed(payload) {
        notifications.push(payload);
        return Promise.resolve(true);
      }
    }
  };
}

function subscriptionEvent(id, type, created, status) {
  return {
    id,
    type,
    created,
    data: {
      object: {
        id: 'sub_1',
        customer: 'cus_1',
        status,
        trial_end: status === 'trialing' ? 200 : null,
        metadata: { tenant_id: '1', plan: 'basico' },
        items: { data: [{ price: { id: 'price_basic' } }] }
      }
    }
  };
}

function invoiceEvent(id, type, created, amountPaid = 1000) {
  return {
    id,
    type,
    created,
    data: {
      object: {
        id: `in_${id}`,
        customer: 'cus_1',
        amount_paid: amountPaid,
        parent: {
          subscription_details: {
            subscription: 'sub_1',
            metadata: { tenant_id: '1' }
          }
        }
      }
    }
  };
}

test('webhooks preserve status, cover lifecycle/invoices, reject stale events and are idempotent', async () => {
  const domain = createWebhookDomain();

  const checkout = {
    id: 'evt_checkout',
    type: 'checkout.session.completed',
    created: 90,
    data: {
      object: {
        id: 'cs_1',
        customer: 'cus_1',
        subscription: 'sub_1',
        client_reference_id: '1',
        metadata: { tenant_id: '1' }
      }
    }
  };
  let result = handleWebhookEvent(checkout, null, domain.deps);
  assert.equal(result.status, 'trialing');
  assert.equal(domain.tenant.stripe_subscription_id, 'sub_1');

  result = handleWebhookEvent(subscriptionEvent('evt_created', 'customer.subscription.created', 100, 'trialing'), null, domain.deps);
  assert.equal(result.status, 'trialing');
  assert.equal(mapStripeStatus('trialing'), 'trialing');

  result = handleWebhookEvent(subscriptionEvent('evt_updated', 'customer.subscription.updated', 110, 'active'), null, domain.deps);
  assert.equal(result.status, 'active');

  result = handleWebhookEvent(subscriptionEvent('evt_paused', 'customer.subscription.paused', 120, 'paused'), null, domain.deps);
  assert.equal(result.status, 'suspended');

  result = handleWebhookEvent(subscriptionEvent('evt_resumed', 'customer.subscription.resumed', 130, 'active'), null, domain.deps);
  assert.equal(result.status, 'active');

  result = handleWebhookEvent(invoiceEvent('evt_failed', 'invoice.payment_failed', 140), null, domain.deps);
  assert.equal(result.status, 'suspended');

  result = handleWebhookEvent(invoiceEvent('evt_paid', 'invoice.paid', 150), null, domain.deps);
  assert.equal(result.status, 'active');

  const deleted = subscriptionEvent('evt_deleted', 'customer.subscription.deleted', 160, 'canceled');
  result = handleWebhookEvent(deleted, null, domain.deps);
  assert.equal(result.status, 'suspended');

  const stale = subscriptionEvent('evt_stale', 'customer.subscription.updated', 155, 'active');
  result = handleWebhookEvent(stale, null, domain.deps);
  assert.equal(result.ignored, true);
  assert.equal(result.stale, true);
  assert.equal(domain.tenant.billing_status, 'suspended');

  result = handleWebhookEvent(deleted, null, domain.deps);
  assert.equal(result.duplicate, true);
  assert.equal(domain.events.get('evt_deleted').attempts, 1);
  assert.ok(domain.audits.some(audit => audit.action === 'billing_active'));
  assert.ok(domain.audits.some(audit => audit.action === 'billing_suspended'));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(domain.notifications.length >= 1);
});

test('Stripe checkout, subscription webhook and verification can shorten but never extend the durable three-day trial', async () => {
  const checkoutDomain = createWebhookDomain();
  const durableTrialEnd = checkoutDomain.tenant.trial_ends_at;
  const checkout = {
    id: 'evt_checkout_long_trial',
    type: 'checkout.session.completed',
    created: 90,
    data: {
      object: {
        id: 'cs_long_trial',
        customer: 'cus_1',
        subscription: {
          id: 'sub_1',
          customer: 'cus_1',
          status: 'trialing',
          trial_end: 900,
          metadata: { tenant_id: '1' }
        },
        client_reference_id: '1',
        metadata: { tenant_id: '1' }
      }
    }
  };
  handleWebhookEvent(checkout, null, checkoutDomain.deps);
  assert.equal(checkoutDomain.tenant.trial_ends_at, durableTrialEnd);

  const subscriptionDomain = createWebhookDomain();
  subscriptionDomain.tenant.stripe_subscription_id = 'sub_1';
  const subscription = subscriptionEvent(
    'evt_subscription_long_trial',
    'customer.subscription.updated',
    100,
    'trialing'
  );
  subscription.data.object.trial_end = 900;
  handleWebhookEvent(subscription, null, subscriptionDomain.deps);
  assert.equal(subscriptionDomain.tenant.trial_ends_at, durableTrialEnd);

  const verified = await verifyTenantSubscriptionAccess({
    id: 1,
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    plan: 'basico',
    trial_ends_at: durableTrialEnd
  }, {
    stripe: {
      subscriptions: {
        retrieve: async () => ({
          id: 'sub_1',
          customer: 'cus_1',
          status: 'trialing',
          trial_end: 900,
          metadata: { tenant_id: '1', plan: 'basico' },
          items: { data: [{ price: { id: 'price_basic' } }] }
        })
      }
    },
    env: { STRIPE_PRICE_ID_BASIC: 'price_basic', STRIPE_PRICE_ID_PRO: 'price_professional' }
  });
  assert.equal(verified.trialEndsAt, durableTrialEnd);
});

test('subscription price and plan metadata must agree before limits or access are updated', () => {
  const domain = createWebhookDomain();
  domain.tenant.stripe_subscription_id = 'sub_1';
  const mismatch = subscriptionEvent(
    'evt_plan_mismatch',
    'customer.subscription.updated',
    100,
    'active'
  );
  mismatch.data.object.items.data[0].price.id = 'price_professional';
  mismatch.data.object.metadata.plan = 'basico';
  let result = handleWebhookEvent(mismatch, null, domain.deps);
  assert.equal(result.status, 'suspended');
  assert.equal(domain.tenant.plan, 'basico');
  assert.ok(domain.audits.some(audit => audit.action === 'billing_plan_mismatch'));

  // Uma invoice posterior não contorna o fail-closed; somente um evento de
  // subscription válido e autoritativo pode reativar e trocar o plano.
  result = handleWebhookEvent(invoiceEvent('evt_paid_after_mismatch', 'invoice.paid', 101), null, domain.deps);
  assert.equal(result.status, 'suspended');

  const corrected = subscriptionEvent(
    'evt_plan_corrected',
    'customer.subscription.updated',
    102,
    'active'
  );
  corrected.data.object.items.data[0].price.id = 'price_professional';
  corrected.data.object.metadata.plan = 'profissional';
  result = handleWebhookEvent(corrected, null, domain.deps);
  assert.equal(result.status, 'active');
  assert.equal(domain.tenant.plan, 'profissional');
  assert.equal(domain.tenant.stripe_price_id, 'price_professional');
});

test('invoice failure and payment cannot overwrite or release terminal subscription and plan blocks', () => {
  for (const terminalReason of ['subscription_inactive', 'plan_mismatch', 'plan_capacity']) {
    const domain = createWebhookDomain();
    domain.tenant.stripe_subscription_id = 'sub_1';
    domain.tenant.billing_status = 'suspended';
    domain.tenant.billing_block_reason = terminalReason;

    let result = handleWebhookEvent(
      invoiceEvent(`evt_failed_${terminalReason}`, 'invoice.payment_failed', 200),
      null,
      domain.deps
    );
    assert.equal(result.status, 'suspended');
    assert.equal(domain.tenant.billing_block_reason, terminalReason);

    result = handleWebhookEvent(
      invoiceEvent(`evt_paid_${terminalReason}`, 'invoice.paid', 201),
      null,
      domain.deps
    );
    assert.equal(result.status, 'suspended');
    assert.equal(domain.tenant.billing_block_reason, terminalReason);
  }
});

test('webhook validates customer ownership and persists failure for Stripe retry', () => {
  const domain = createWebhookDomain();
  const event = subscriptionEvent('evt_wrong_customer', 'customer.subscription.updated', 100, 'active');
  event.data.object.customer = 'cus_other';

  assert.throws(
    () => handleWebhookEvent(event, null, domain.deps),
    /Customer Stripe nao pertence ao tenant/
  );
  assert.equal(domain.events.get(event.id).processing_status, 'failed');
  assert.equal(domain.tenant.billing_status, 'trialing');
});

test('completed checkout removes the temporary checkout_pending access window', () => {
  const domain = createWebhookDomain();
  domain.tenant.billing_status = 'checkout_pending';
  const result = handleWebhookEvent({
    id: 'evt_checkout_pending',
    type: 'checkout.session.completed',
    created: 90,
    data: {
      object: {
        id: 'cs_pending',
        customer: 'cus_1',
        subscription: 'sub_1',
        client_reference_id: '1',
        metadata: { tenant_id: '1' }
      }
    }
  }, null, domain.deps);
  assert.equal(result.status, 'trialing');
  assert.equal(domain.tenant.stripe_subscription_id, 'sub_1');
});

test('tenant deletion removes Stripe customer or cancels an orphan subscription', async () => {
  const deletedCustomers = [];
  const canceledSubscriptions = [];
  const stripe = {
    customers: { del: async id => { deletedCustomers.push(id); return { id, deleted: true }; } },
    subscriptions: { cancel: async id => { canceledSubscriptions.push(id); return { id, status: 'canceled' }; } }
  };
  await deleteTenantBilling({
    id: 1,
    stripe_customer_id: 'cus_delete',
    stripe_subscription_id: 'sub_delete'
  }, { stripe });
  await deleteTenantBilling({
    id: 2,
    stripe_customer_id: null,
    stripe_subscription_id: 'sub_orphan'
  }, { stripe });
  assert.deepEqual(deletedCustomers, ['cus_delete']);
  assert.deepEqual(canceledSubscriptions, ['sub_orphan']);
});

test('customer provisioning compensates Stripe when the durable local binding fails', async () => {
  const deleted = [];
  const tenant = { id: 91, name: 'Compensacao', stripe_customer_id: null };
  await assert.rejects(
    ensureStripeCustomer(tenant, 'admin@example.test', {
      stripe: {
        customers: {
          create: async () => ({ id: 'cus_orphan_candidate' }),
          del: async id => deleted.push(id)
        }
      },
      setBillingFields() {
        throw new Error('disco indisponivel');
      }
    }),
    /disco indisponivel/
  );
  assert.deepEqual(deleted, ['cus_orphan_candidate']);
});

test('first payment failure notifies the tenant admin after suspending access', async () => {
  const domain = createWebhookDomain();
  domain.tenant.stripe_subscription_id = 'sub_1';
  const result = handleWebhookEvent(invoiceEvent('evt_first_failure', 'invoice.payment_failed', 140), null, domain.deps);
  assert.equal(result.status, 'suspended');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(domain.notifications.length, 1);
});

test('checkout refuses to create a second subscription for the same tenant', async () => {
  await assert.rejects(
    createCheckoutSession({
      id: 77,
      name: 'Assinante',
      plan: 'basico',
      billing_status: 'trialing',
      stripe_customer_id: 'cus_77',
      stripe_subscription_id: 'sub_77'
    }, 'admin@example.test', {
      successUrl: 'https://app.test/success',
      cancelUrl: 'https://app.test/cancel'
    }, { stripe: {} }),
    error => error.statusCode === 409 && /ja possui assinatura/.test(error.message)
  );
});

test('a remotely canceled subscription can be replaced without granting a second trial', async () => {
  const now = Date.UTC(2026, 6, 13, 12, 0, 0);
  const tenant = {
    id: 79,
    name: 'Returning customer',
    plan: 'basico',
    billing_status: 'suspended',
    trial_ends_at: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    stripe_customer_id: 'cus_79',
    stripe_subscription_id: 'sub_canceled_79',
    stripe_checkout_session_id: 'cs_old_79'
  };
  let checkoutPayload;
  const stripe = {
    subscriptions: {
      retrieve: async id => ({ id, status: 'canceled', customer: 'cus_79' })
    },
    checkout: {
      sessions: {
        retrieve: async () => ({
          id: 'cs_old_79',
          status: 'complete',
          customer: 'cus_79',
          client_reference_id: '79',
          metadata: { tenant_id: '79', plan: 'basico' },
          subscription: 'sub_canceled_79'
        }),
        create: async payload => {
          checkoutPayload = payload;
          return { id: 'cs_new_79', url: 'https://checkout.test/new' };
        }
      }
    }
  };
  const session = await createCheckoutSession(tenant, 'returning@example.test', {
    successUrl: 'https://app.test/success',
    cancelUrl: 'https://app.test/cancel'
  }, {
    stripe,
    now: () => now,
    env: { STRIPE_PRICE_ID_BASIC: 'price_basic', STRIPE_PRICE_ID_PRO: 'price_pro' },
    setBillingFields(id, fields) {
      assert.equal(id, tenant.id);
      Object.assign(tenant, fields);
      return tenant;
    }
  });
  assert.equal(session.id, 'cs_new_79');
  assert.equal(tenant.stripe_checkout_session_id, 'cs_new_79');
  assert.equal(Object.hasOwn(checkoutPayload.subscription_data, 'trial_end'), false);
  assert.equal(Object.hasOwn(checkoutPayload.subscription_data, 'trial_period_days'), false);

  const domain = createWebhookDomain();
  domain.tenant.stripe_subscription_id = 'sub_canceled_1';
  domain.tenant.billing_status = 'suspended';
  const result = handleWebhookEvent({
    id: 'evt_replacement_checkout',
    type: 'checkout.session.completed',
    created: 300,
    data: {
      object: {
        id: 'cs_replacement',
        customer: 'cus_1',
        subscription: 'sub_replacement_1',
        client_reference_id: '1',
        metadata: { tenant_id: '1', plan: 'basico' }
      }
    }
  }, null, domain.deps);
  assert.equal(result.status, 'checkout_pending');
  assert.equal(domain.tenant.stripe_subscription_id, 'sub_replacement_1');
  const replacementCreated = subscriptionEvent(
    'evt_replacement_created',
    'customer.subscription.created',
    300,
    'active'
  );
  replacementCreated.data.object.id = 'sub_replacement_1';
  const activated = handleWebhookEvent(replacementCreated, null, domain.deps);
  assert.equal(activated.status, 'active');
});

test('manual billing reactivation requires the tenant real active Stripe subscription', async () => {
  const tenant = {
    id: 5,
    plan: 'basico',
    stripe_customer_id: 'cus_5',
    stripe_subscription_id: 'sub_5'
  };
  const verified = await verifyTenantSubscriptionAccess(tenant, {
    stripe: {
      subscriptions: {
        retrieve: async () => ({
          id: 'sub_5', customer: 'cus_5', status: 'trialing', trial_end: 200,
          metadata: { tenant_id: '5', plan: 'basico' },
          items: { data: [{ price: { id: 'price_basic' } }] }
        })
      }
    },
    env: { STRIPE_PRICE_ID_BASIC: 'price_basic', STRIPE_PRICE_ID_PRO: 'price_professional' }
  });
  assert.equal(verified.status, 'trialing');
  await assert.rejects(
    verifyTenantSubscriptionAccess({ id: 6 }, { stripe: {} }),
    error => error.statusCode === 409 && /sem assinatura Stripe/.test(error.message)
  );
});

test('production effective billing blocks non-comp local activation without Stripe', () => {
  const tenantManager = require('./tenantManager');
  const suffix = `${process.pid}-${Date.now()}`;
  const tenant = tenantManager.createTenant({
    name: 'Local sem Stripe',
    slug: `local-${suffix}`,
    subdomain: `local-${suffix}`
  });
  tenantManager.setBillingFields(tenant.id, { billing_status: 'active' });
  const previousNodeEnv = process.env.NODE_ENV;
  const previousBillingRequired = process.env.BILLING_REQUIRED;
  try {
    process.env.NODE_ENV = 'production';
    process.env.BILLING_REQUIRED = 'true';
    assert.equal(tenantManager.getEffectiveBillingStatus(tenantManager.getTenant(tenant.id)), 'checkout_pending');
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousBillingRequired === undefined) delete process.env.BILLING_REQUIRED;
    else process.env.BILLING_REQUIRED = previousBillingRequired;
  }
});
