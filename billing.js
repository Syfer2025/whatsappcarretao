const Stripe = require('stripe');
const tenantManager = require('./tenantManager');
const { notifyPaymentFailed } = require('./notifications');

const MIN_STRIPE_TRIAL_MS = 48 * 60 * 60 * 1000;
const MIN_CHECKOUT_RESERVATION_SECONDS = 30 * 60;
const MAX_CHECKOUT_RESERVATION_SECONDS = 24 * 60 * 60;
const DEFAULT_CHECKOUT_RESERVATION_SECONDS = 30 * 60;
const CHECKOUT_EXPIRATION_SAFETY_SECONDS = 60;

let stripeClient = null;
let stripeClientKey = null;
const checkoutInFlight = new Map();

// A chave do Stripe pode vir do painel do super admin (master.db) ou, como
// fallback, de variável de ambiente. O banco tem prioridade para que a UI seja
// a fonte da verdade quando preenchida.
function resolveStripeSecretKey() {
  const resolved =
    typeof tenantManager.getResolvedPlatformEnv === 'function'
      ? tenantManager.getResolvedPlatformEnv()
      : {};
  return resolved.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY || '';
}

function getStripe() {
  const secretKey = resolveStripeSecretKey();
  if (!secretKey) throw new Error('STRIPE_SECRET_KEY nao configurado');
  // Recria o client quando a chave muda (ex: operador troca no painel), senão o
  // client em cache continuaria usando a chave antiga até reiniciar o processo.
  if (!stripeClient || stripeClientKey !== secretKey) {
    stripeClient = new Stripe(secretKey, {
      maxNetworkRetries: Number(process.env.STRIPE_NETWORK_RETRIES || 2),
      timeout: Number(process.env.STRIPE_TIMEOUT_MS || 20000)
    });
    stripeClientKey = secretKey;
  }
  return stripeClient;
}

function resetStripeClient() {
  stripeClient = null;
  stripeClientKey = null;
}

function dependencies(overrides = {}) {
  const resolvedPlatformEnv =
    typeof tenantManager.getResolvedPlatformEnv === 'function'
      ? tenantManager.getResolvedPlatformEnv()
      : {};
  return {
    // Config do painel (Stripe/Turnstile/price ids) sobrepõe o process.env.
    env: { ...process.env, ...resolvedPlatformEnv },
    now: Date.now,
    getStripe,
    notifyPaymentFailed,
    ...tenantManager,
    ...overrides
  };
}

function stripeFrom(deps) {
  return deps.stripe || deps.getStripe();
}

function getStripePriceId(plan, env = process.env) {
  const normalizedPlan = tenantManager.normalizePlan(plan);
  const priceId = normalizedPlan === 'profissional'
    ? env.STRIPE_PRICE_ID_PRO || env.STRIPE_PRICE_ID
    : env.STRIPE_PRICE_ID_BASIC || env.STRIPE_PRICE_ID;
  if (!priceId) {
    const variable = normalizedPlan === 'profissional' ? 'STRIPE_PRICE_ID_PRO' : 'STRIPE_PRICE_ID_BASIC';
    throw new Error(`${variable} ou STRIPE_PRICE_ID nao configurado`);
  }
  return priceId;
}

function getStripeSecretConfigurationStatus(secretKey, production) {
  if (!secretKey) return { configured: false, reason: 'missing_secret_key' };
  const validPattern = production
    ? /^sk_live_[A-Za-z0-9]+$/
    : /^sk_(?:live|test)_[A-Za-z0-9]+$/;
  if (!validPattern.test(secretKey)) {
    return {
      configured: false,
      reason: production ? 'secret_key_not_live' : 'invalid_secret_key'
    };
  }
  return { configured: true };
}

function getStripePriceConfigurationStatus(env = process.env) {
  const fallbackPrice = String(env.STRIPE_PRICE_ID || '').trim();
  const basicPrice = String(env.STRIPE_PRICE_ID_BASIC || '').trim();
  const proPrice = String(env.STRIPE_PRICE_ID_PRO || '').trim();
  const invalid = reason => ({ configured: false, reason });
  const validPrice = value => /^price_[A-Za-z0-9]+$/.test(value);

  if (fallbackPrice) {
    if (!validPrice(fallbackPrice)) return invalid('invalid_fallback_price');
    if (basicPrice || proPrice) return invalid('mixed_price_strategies');
    return {
      configured: true,
      strategy: 'fallback',
      prices: [{ plan: 'fallback', id: fallbackPrice }]
    };
  }
  if (!validPrice(basicPrice) || !validPrice(proPrice)) return invalid('missing_or_invalid_plan_prices');
  if (basicPrice === proPrice) return invalid('duplicate_plan_prices');
  return {
    configured: true,
    strategy: 'per_plan',
    prices: [
      { plan: 'basic', id: basicPrice },
      { plan: 'professional', id: proPrice }
    ]
  };
}

function getBillingConfigurationStatus(env = process.env, {
  production = env.NODE_ENV === 'production'
} = {}) {
  const secretKey = String(env.STRIPE_SECRET_KEY || '').trim();
  const webhookSecret = String(env.STRIPE_WEBHOOK_SECRET || '').trim();
  const invalid = reason => ({ configured: false, reason });

  const secretStatus = getStripeSecretConfigurationStatus(secretKey, production);
  if (!secretStatus.configured) return invalid(secretStatus.reason);
  if (!/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) return invalid('missing_or_invalid_webhook_secret');

  const priceStatus = getStripePriceConfigurationStatus(env);
  if (!priceStatus.configured) return invalid(priceStatus.reason);
  return { configured: true, strategy: priceStatus.strategy };
}

function stripeConfigurationError(reason, message, {
  cause,
  priceId,
  plan,
  unavailable = false
} = {}) {
  const error = new Error(message);
  error.name = 'StripeConfigurationError';
  error.code = unavailable
    ? 'STRIPE_CONFIGURATION_UNAVAILABLE'
    : 'STRIPE_CONFIGURATION_INVALID';
  error.statusCode = unavailable ? 503 : 400;
  error.reason = reason;
  if (cause) {
    // Mantem o diagnostico disponivel para logs sem torna-lo serializavel por
    // acidente em uma resposta HTTP (erros da SDK podem carregar raw payload).
    Object.defineProperty(error, 'cause', { value: cause, enumerable: false });
  }
  if (priceId) error.priceId = priceId;
  if (plan) error.plan = plan;
  return error;
}

function stripeConnectivityRequestError(error, operation, price = null) {
  const authenticationFailure = error?.statusCode === 401
    || error?.type === 'StripeAuthenticationError';
  if (authenticationFailure) {
    return stripeConfigurationError(
      'secret_key_rejected',
      'A Stripe rejeitou a chave secreta configurada',
      { cause: error }
    );
  }
  if (price && isStripeMissingResourceError(error)) {
    return stripeConfigurationError(
      'price_not_found',
      `O preco Stripe configurado para ${price.plan} nao existe nesta conta`,
      { cause: error, priceId: price.id, plan: price.plan }
    );
  }
  return stripeConfigurationError(
    operation === 'account' ? 'account_retrieve_failed' : 'price_retrieve_failed',
    'Nao foi possivel validar a configuracao diretamente na Stripe',
    {
      cause: error,
      priceId: price?.id,
      plan: price?.plan,
      unavailable: true
    }
  );
}

async function validateStripeConfigurationConnectivity(env = process.env, {
  stripe,
  production = env.NODE_ENV === 'production'
} = {}) {
  const secretKey = String(env.STRIPE_SECRET_KEY || '').trim();
  const secretStatus = getStripeSecretConfigurationStatus(secretKey, production);
  if (!secretStatus.configured) {
    throw stripeConfigurationError(
      secretStatus.reason,
      'A chave secreta Stripe configurada e invalida'
    );
  }
  const priceStatus = getStripePriceConfigurationStatus(env);
  if (!priceStatus.configured) {
    throw stripeConfigurationError(
      priceStatus.reason,
      'Os precos Stripe configurados sao invalidos'
    );
  }

  // Este client e deliberadamente isolado do cache usado pelo trafego normal.
  // Assim uma validacao de configuracao nunca troca a credencial global antes
  // de todas as verificacoes terminarem com sucesso.
  const candidateStripe = stripe || new Stripe(secretKey, {
    maxNetworkRetries: Number(env.STRIPE_NETWORK_RETRIES || 2),
    timeout: Number(env.STRIPE_TIMEOUT_MS || 20000)
  });
  if (typeof candidateStripe.accounts?.retrieve !== 'function'
      || typeof candidateStripe.prices?.retrieve !== 'function') {
    throw stripeConfigurationError(
      'invalid_stripe_client',
      'O client Stripe nao oferece as operacoes necessarias para validacao'
    );
  }

  let account;
  try {
    account = await candidateStripe.accounts.retrieve(null);
  } catch (error) {
    throw stripeConnectivityRequestError(error, 'account');
  }
  if (!account?.id) {
    throw stripeConfigurationError(
      'invalid_account_response',
      'A Stripe nao retornou a conta vinculada a chave configurada',
      { unavailable: true }
    );
  }

  const expectedLivemode = secretKey.startsWith('sk_live_');
  const retrievedPrices = await Promise.all(priceStatus.prices.map(async priceConfig => {
    let price;
    try {
      // Recuperar cada Price pelo mesmo client que recuperou /v1/account prova
      // que ele pertence a conta autenticada; IDs de outra conta retornam 404.
      price = await candidateStripe.prices.retrieve(priceConfig.id);
    } catch (error) {
      throw stripeConnectivityRequestError(error, 'price', priceConfig);
    }
    if (!price || price.id !== priceConfig.id) {
      throw stripeConfigurationError(
        'invalid_price_response',
        `A Stripe retornou um preco inesperado para ${priceConfig.plan}`,
        { priceId: priceConfig.id, plan: priceConfig.plan, unavailable: true }
      );
    }
    if (price.active !== true) {
      throw stripeConfigurationError(
        'inactive_price',
        `O preco Stripe configurado para ${priceConfig.plan} esta inativo`,
        { priceId: priceConfig.id, plan: priceConfig.plan }
      );
    }
    if (price.type !== 'recurring' || !price.recurring) {
      throw stripeConfigurationError(
        'non_recurring_price',
        `O preco Stripe configurado para ${priceConfig.plan} nao e recorrente`,
        { priceId: priceConfig.id, plan: priceConfig.plan }
      );
    }
    if (price.livemode !== expectedLivemode) {
      throw stripeConfigurationError(
        'price_mode_mismatch',
        `O preco Stripe configurado para ${priceConfig.plan} esta no modo incorreto`,
        { priceId: priceConfig.id, plan: priceConfig.plan }
      );
    }
    return priceConfig;
  }));

  return {
    valid: true,
    accountId: account.id,
    livemode: expectedLivemode,
    strategy: priceStatus.strategy,
    priceIds: Object.fromEntries(retrievedPrices.map(price => [price.plan, price.id]))
  };
}

function getCheckoutReservationSeconds(env = process.env) {
  const raw = env.STRIPE_CHECKOUT_RESERVATION_MINUTES ?? '30';
  const minutes = Number(raw);
  const seconds = minutes * 60;
  if (!Number.isSafeInteger(minutes)
      || seconds < MIN_CHECKOUT_RESERVATION_SECONDS
      || seconds > MAX_CHECKOUT_RESERVATION_SECONDS) {
    const err = new Error('STRIPE_CHECKOUT_RESERVATION_MINUTES deve ser um inteiro entre 30 e 1440');
    err.statusCode = 500;
    throw err;
  }
  return seconds || DEFAULT_CHECKOUT_RESERVATION_SECONDS;
}

function checkoutExpirationIso(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

function assertCheckoutSessionBinding(tenant, session) {
  if (!session || session.id !== tenant.stripe_checkout_session_id) {
    throw new Error('Checkout Stripe nao corresponde a reserva local');
  }
  const metadataTenantId = Number(session.metadata?.tenant_id);
  const referenceTenantId = Number(session.client_reference_id);
  if (!Number.isSafeInteger(metadataTenantId)
      || !Number.isSafeInteger(referenceTenantId)
      || metadataTenantId !== Number(tenant.id)
      || referenceTenantId !== Number(tenant.id)) {
    throw new Error('Checkout Stripe possui vinculo de tenant invalido');
  }
  const customerId = objectId(session.customer);
  if (tenant.stripe_customer_id && customerId !== tenant.stripe_customer_id) {
    throw new Error('Checkout Stripe pertence a outro customer');
  }
}

function eligibleTrialEnd(tenant, now = Date.now()) {
  if (!['trialing', 'checkout_pending'].includes(tenant.billing_status) || tenant.stripe_subscription_id) return null;
  const trialEndMs = new Date(tenant.trial_ends_at || '').getTime();
  if (!Number.isFinite(trialEndMs) || trialEndMs - now < MIN_STRIPE_TRIAL_MS) return null;
  return Math.floor(trialEndMs / 1000);
}

function clampedTrialEndIso(tenant, stripeTrialEndSeconds) {
  const durableEndMs = new Date(tenant?.trial_ends_at || '').getTime();
  const stripeEndMs = Number(stripeTrialEndSeconds) * 1000;
  if (!Number.isFinite(durableEndMs) || !Number.isFinite(stripeEndMs) || stripeEndMs <= 0) {
    return undefined;
  }
  // Stripe pode encurtar o trial, nunca ampliá-lo. O timestamp local nasceu
  // no cadastro (ou no fallback de Checkout antes do acesso) e é o teto
  // durável de exatamente três dias.
  return new Date(Math.min(durableEndMs, stripeEndMs)).toISOString();
}

function subscriptionPriceId(subscription) {
  const items = Array.isArray(subscription?.items?.data) ? subscription.items.data : [];
  const ids = [...new Set(items.map(item => objectId(item?.price)).filter(Boolean))];
  return ids.length === 1 ? ids[0] : null;
}

function resolveSubscriptionPlan(subscription, tenant, env = process.env, fallbackPriceId = null) {
  const priceId = subscriptionPriceId(subscription) || fallbackPriceId || null;
  let metadataPlan = null;
  if (subscription?.metadata?.plan) {
    try { metadataPlan = tenantManager.normalizePlan(subscription.metadata.plan); } catch {
      return { valid: false, reason: 'invalid_plan_metadata', plan: null, priceId };
    }
  }
  const fallback = String(env.STRIPE_PRICE_ID || '').trim();
  const basic = String(env.STRIPE_PRICE_ID_BASIC || '').trim();
  const professional = String(env.STRIPE_PRICE_ID_PRO || '').trim();
  const historicalPrice = String(tenant?.stripe_price_id || '').trim();
  let mappedPlan = null;

  if (basic && professional) {
    if (basic === professional) {
      return { valid: false, reason: 'ambiguous_price_configuration', plan: null, priceId };
    }
    if (priceId === basic) mappedPlan = 'basico';
    else if (priceId === professional) mappedPlan = 'profissional';
  } else if (fallback && priceId === fallback) {
    // Um preço único atende os dois limites; nesse modo o plano assinado fica
    // no metadata imutável criado pelo nosso Checkout.
    mappedPlan = metadataPlan;
  }

  if (!mappedPlan && historicalPrice && priceId === historicalPrice) {
    try {
      // Price IDs sao imutaveis na Stripe. O par (stripe_price_id, plan)
      // persistido no tenant e o vinculo duravel das assinaturas criadas antes
      // de uma rotacao dos Prices configurados no painel.
      mappedPlan = tenantManager.normalizePlan(tenant.plan);
    } catch {
      return { valid: false, reason: 'invalid_tenant_plan', plan: null, priceId };
    }
  }

  if (!priceId || !mappedPlan) {
    return { valid: false, reason: 'unknown_subscription_price', plan: null, priceId };
  }
  if (metadataPlan && metadataPlan !== mappedPlan) {
    return { valid: false, reason: 'price_plan_mismatch', plan: null, priceId };
  }
  return {
    valid: true,
    reason: null,
    plan: mappedPlan || tenantManager.normalizePlan(tenant.plan),
    priceId
  };
}

async function ensureStripeCustomer(tenant, email, overrides = {}) {
  const deps = dependencies(overrides);
  if (tenant.stripe_customer_id) return tenant.stripe_customer_id;
  const stripe = stripeFrom(deps);
  const customer = await stripe.customers.create(
    {
      name: tenant.name,
      email,
      metadata: { tenant_id: String(tenant.id) }
    },
    { idempotencyKey: `tenant-${tenant.id}-customer-v1` }
  );
  if (!customer?.id) throw new Error('Stripe nao retornou o cliente criado');
  try {
    deps.setBillingFields(tenant.id, { stripe_customer_id: customer.id });
  } catch (error) {
    // Sem o vínculo local, a chave idempotente devolveria o mesmo customer em
    // novas tentativas, mas ele ficaria órfão se o tenant fosse compensado.
    try {
      await stripe.customers.del(customer.id);
    } catch (cleanupError) {
      error.stripeCleanupError = cleanupError;
    }
    throw error;
  }
  return customer.id;
}

async function createCheckoutSessionUnlocked(tenant, email, { successUrl, cancelUrl }, overrides = {}) {
  const deps = dependencies(overrides);
  const stripe = stripeFrom(deps);
  let replacingTerminalSubscription = false;
  if (tenant.stripe_subscription_id) {
    if (typeof stripe.subscriptions?.retrieve !== 'function') {
      const err = new Error('Este tenant ja possui assinatura Stripe; use o portal de cobranca');
      err.statusCode = 409;
      throw err;
    }
    try {
      const existingSubscription = await stripe.subscriptions.retrieve(tenant.stripe_subscription_id);
      replacingTerminalSubscription = ['canceled', 'incomplete_expired'].includes(existingSubscription?.status);
    } catch (error) {
      if (isStripeMissingResourceError(error)) replacingTerminalSubscription = true;
      else throw error;
    }
    if (!replacingTerminalSubscription) {
      const err = new Error('Este tenant ja possui assinatura Stripe; use o portal de cobranca');
      err.statusCode = 409;
      throw err;
    }
  }
  const normalizedPlan = tenantManager.normalizePlan(tenant.plan);
  if (tenant.stripe_checkout_session_id
      && typeof stripe.checkout?.sessions?.retrieve === 'function') {
    try {
      const existing = await stripe.checkout.sessions.retrieve(tenant.stripe_checkout_session_id);
      assertCheckoutSessionBinding(tenant, existing);
      if (existing?.status === 'open' && existing?.metadata?.plan === normalizedPlan && existing.url) {
        const existingExpiry = Number(existing.expires_at);
        if (Number.isSafeInteger(existingExpiry) && existingExpiry > 0) {
          deps.setBillingFields(tenant.id, { checkout_expires_at: checkoutExpirationIso(existingExpiry) });
        }
        return existing;
      }
      if (existing?.status === 'open' && existing?.metadata?.plan !== normalizedPlan
          && typeof stripe.checkout.sessions.expire === 'function') {
        await stripe.checkout.sessions.expire(existing.id);
      } else if (existing?.status === 'complete' && !replacingTerminalSubscription) {
        const err = new Error('Checkout concluido; aguardando confirmacao da Stripe');
        err.statusCode = 409;
        throw err;
      } else if (existing?.status === 'expired') {
        if (!replacingTerminalSubscription) {
          const err = new Error('A reserva de capacidade deste cadastro expirou; faca um novo cadastro');
          err.statusCode = 410;
          err.code = 'CHECKOUT_RESERVATION_EXPIRED';
          throw err;
        }
      }
    } catch (err) {
      if ([409, 410].includes(err.statusCode)) throw err;
      if (!isStripeMissingResourceError(err)) throw err;
      // Uma assinatura terminal ja prova que a vaga continua pertencendo a
      // este tenant. No primeiro cadastro, porem, uma sessao ausente nao pode
      // ser renovada: ela ainda pode concorrer com uma conclusao.
      if (!replacingTerminalSubscription) {
        const missing = new Error('Nao foi possivel validar a reserva anterior na Stripe');
        missing.statusCode = 409;
        missing.code = 'CHECKOUT_RESERVATION_UNVERIFIED';
        throw missing;
      }
    }
  }
  const customerId = await ensureStripeCustomer(tenant, email, deps);
  const priceId = getStripePriceId(tenant.plan, deps.env);
  const metadata = {
    tenant_id: String(tenant.id),
    plan: tenantManager.normalizePlan(tenant.plan)
  };
  const subscriptionData = { metadata };
  const nowMs = deps.now();
  const reservationSeconds = getCheckoutReservationSeconds(deps.env);
  // A margem evita cair abaixo do minimo de 30 minutos por latencia de rede.
  // `floor` e a margem no teto evitam ultrapassar as 24 horas aceitas pela
  // Stripe mesmo com milissegundos locais ou pequeno desvio entre relogios.
  const checkoutExpiresAt = Math.floor(nowMs / 1000)
    + Math.min(
      reservationSeconds + CHECKOUT_EXPIRATION_SAFETY_SECONDS,
      MAX_CHECKOUT_RESERVATION_SECONDS - CHECKOUT_EXPIRATION_SAFETY_SECONDS
    );
  const trialEnd = eligibleTrialEnd(tenant, nowMs);
  if (trialEnd) subscriptionData.trial_end = trialEnd;
  else if (tenant.billing_status === 'checkout_pending' && !tenant.stripe_subscription_id) {
    // Enquanto o Checkout nao foi concluido nao houve acesso ao produto. Se a
    // sessao anterior expirou, inicia os tres dias na assinatura efetiva.
    subscriptionData.trial_period_days = tenantManager.TRIAL_DAYS;
  }

  const session = await stripe.checkout.sessions.create(
    {
      mode: 'subscription',
      customer: customerId,
      payment_method_collection: 'always',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: String(tenant.id),
      metadata,
      subscription_data: subscriptionData,
      expires_at: checkoutExpiresAt
    },
    {
      idempotencyKey: `tenant-${tenant.id}-checkout-${normalizedPlan}-${tenant.stripe_checkout_session_id || 'initial'}`
    }
  );
  if (!session?.id) throw new Error('Stripe nao retornou a sessao de Checkout');
  deps.setBillingFields(tenant.id, {
    stripe_checkout_session_id: session.id,
    checkout_expires_at: checkoutExpirationIso(
      Number.isSafeInteger(Number(session.expires_at)) && Number(session.expires_at) > 0
        ? Number(session.expires_at)
        : checkoutExpiresAt
    ),
    stripe_price_id: priceId,
    ...(subscriptionData.trial_period_days
      ? { trial_ends_at: new Date(nowMs + tenantManager.TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString() }
      : {})
  });
  return session;
}

async function releaseExpiredCheckoutReservation(tenant, overrides = {}) {
  if (!tenant?.stripe_checkout_session_id || tenant.stripe_subscription_id) {
    return { released: false, reason: tenant?.stripe_subscription_id ? 'subscription_exists' : 'checkout_missing' };
  }
  const deps = dependencies(overrides);
  const sessions = stripeFrom(deps).checkout?.sessions;
  if (typeof sessions?.retrieve !== 'function' || typeof sessions?.expire !== 'function') {
    throw new Error('Stripe nao oferece as operacoes necessarias para liberar a reserva');
  }

  const classify = session => {
    assertCheckoutSessionBinding(tenant, session);
    if (session.subscription || session.status === 'complete') {
      return { released: false, reason: 'checkout_completed', session };
    }
    if (session.status === 'expired') {
      return { released: true, reason: 'checkout_expired', session };
    }
    if (session.status !== 'open') {
      throw new Error(`Estado inesperado do Checkout Stripe: ${session.status || 'ausente'}`);
    }
    const stripeExpiresAt = Number(session.expires_at);
    if (!Number.isSafeInteger(stripeExpiresAt) || stripeExpiresAt <= 0) {
      throw new Error('Checkout Stripe sem expiracao verificavel');
    }
    if (stripeExpiresAt * 1000 > deps.now()) {
      deps.setBillingFields(tenant.id, { checkout_expires_at: checkoutExpirationIso(stripeExpiresAt) });
      return { released: false, reason: 'checkout_still_open', session };
    }
    return null;
  };

  let session = await sessions.retrieve(tenant.stripe_checkout_session_id);
  const initial = classify(session);
  if (initial) return initial;
  try {
    session = await sessions.expire(tenant.stripe_checkout_session_id);
  } catch (error) {
    // A conclusao e a expiracao podem disputar o mesmo instante. Releia a
    // fonte da verdade: somente `expired` autoriza remover o tenant.
    try {
      session = await sessions.retrieve(tenant.stripe_checkout_session_id);
    } catch {
      throw error;
    }
  }
  const final = classify(session);
  if (!final) throw new Error('Stripe manteve o Checkout aberto depois da expiracao solicitada');
  return final;
}

function createCheckoutSession(tenant, email, urls, overrides = {}) {
  const key = Number(tenant?.id);
  if (!Number.isSafeInteger(key) || key <= 0) return Promise.reject(new Error('Tenant invalido'));
  const existing = checkoutInFlight.get(key);
  if (existing) return existing;
  const promise = createCheckoutSessionUnlocked(tenant, email, urls, overrides)
    .finally(() => checkoutInFlight.delete(key));
  checkoutInFlight.set(key, promise);
  return promise;
}

async function createPortalSession(tenant, returnUrl, overrides = {}) {
  if (!tenant.stripe_customer_id) throw new Error('Este tenant ainda nao tem cliente Stripe');
  const deps = dependencies(overrides);
  return stripeFrom(deps).billingPortal.sessions.create({
    customer: tenant.stripe_customer_id,
    return_url: returnUrl
  });
}

function isStripeMissingResourceError(err) {
  return err?.statusCode === 404 || err?.code === 'resource_missing' || err?.raw?.code === 'resource_missing';
}

async function deleteTenantBilling(tenant, overrides = {}) {
  if (!tenant) throw new Error('Tenant nao encontrado');
  if (!tenant.stripe_customer_id && !tenant.stripe_subscription_id) {
    return { customerDeleted: false, subscriptionCanceled: false };
  }
  const deps = dependencies(overrides);
  const stripe = stripeFrom(deps);
  if (tenant.stripe_customer_id) {
    try {
      await stripe.customers.del(tenant.stripe_customer_id);
    } catch (err) {
      if (!isStripeMissingResourceError(err)) throw err;
    }
    return { customerDeleted: true, subscriptionCanceled: Boolean(tenant.stripe_subscription_id) };
  }
  if (tenant.stripe_subscription_id) {
    try {
      await stripe.subscriptions.cancel(tenant.stripe_subscription_id);
    } catch (err) {
      if (!isStripeMissingResourceError(err)) throw err;
    }
    return { customerDeleted: false, subscriptionCanceled: true };
  }
  return { customerDeleted: false, subscriptionCanceled: false };
}

async function verifyTenantSubscriptionAccess(tenant, overrides = {}) {
  if (!tenant?.stripe_subscription_id) {
    const err = new Error('Tenant sem assinatura Stripe; use cortesia para uma liberacao manual');
    err.statusCode = 409;
    throw err;
  }
  const deps = dependencies(overrides);
  const subscription = await stripeFrom(deps).subscriptions.retrieve(tenant.stripe_subscription_id);
  const customerId = objectId(subscription.customer);
  const metadataTenantId = parseMetadataTenantId(subscription.metadata?.tenant_id);
  if (tenant.stripe_customer_id && customerId !== tenant.stripe_customer_id) {
    throw new Error('Assinatura Stripe vinculada a outro customer');
  }
  if (metadataTenantId && metadataTenantId !== Number(tenant.id)) {
    throw new Error('Assinatura Stripe vinculada a outro tenant');
  }
  const status = mapStripeStatus(subscription.status);
  if (!['active', 'trialing'].includes(status)) {
    const err = new Error(`Assinatura Stripe sem acesso (${subscription.status || 'inativa'})`);
    err.statusCode = 409;
    throw err;
  }
  const planBinding = resolveSubscriptionPlan(subscription, tenant, deps.env);
  if (!planBinding.valid) {
    const err = new Error(`Assinatura Stripe com plano/preco invalido (${planBinding.reason})`);
    err.statusCode = 409;
    throw err;
  }
  return {
    status,
    customerId,
    subscriptionId: subscription.id,
    plan: planBinding.plan,
    priceId: planBinding.priceId,
    trialEndsAt: status === 'trialing'
      ? clampedTrialEndIso(tenant, subscription.trial_end)
      : undefined
  };
}

function mapStripeStatus(stripeStatus) {
  if (stripeStatus === 'trialing') return 'trialing';
  if (stripeStatus === 'active') return 'active';
  return 'suspended';
}

function objectId(value) {
  if (typeof value === 'string') return value;
  return value?.id || null;
}

function parseMetadataTenantId(value) {
  if (value === undefined || value === null || value === '') return null;
  const tenantId = Number(value);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new Error('tenant_id invalido nos metadados Stripe');
  }
  return tenantId;
}

function getInvoiceSubscription(invoice) {
  return invoice.subscription
    || invoice.parent?.subscription_details?.subscription
    || invoice.subscription_details?.subscription
    || null;
}

function eventObjectIds(object, eventType) {
  const isInvoice = eventType.startsWith('invoice.');
  const isCheckout = eventType === 'checkout.session.completed';
  const subscriptionValue = isInvoice
    ? getInvoiceSubscription(object)
    : isCheckout ? object.subscription : object;
  return {
    customerId: objectId(object.customer),
    subscriptionId: objectId(subscriptionValue)
  };
}

function explicitTenantIds(object, eventType) {
  const candidates = [];
  const add = value => {
    const tenantId = parseMetadataTenantId(value);
    if (tenantId) candidates.push(tenantId);
  };
  add(object.metadata?.tenant_id);
  if (eventType === 'checkout.session.completed') add(object.client_reference_id);
  if (eventType.startsWith('invoice.')) {
    add(object.parent?.subscription_details?.metadata?.tenant_id);
    add(object.subscription_details?.metadata?.tenant_id);
  }
  if (new Set(candidates).size > 1) {
    throw new Error('Evento Stripe possui vinculos de tenant conflitantes');
  }
  return candidates[0] || null;
}

function resolveEventTenant(object, eventType, deps) {
  const tenants = deps.listTenants();
  const explicitTenantId = explicitTenantIds(object, eventType);
  const { customerId, subscriptionId } = eventObjectIds(object, eventType);
  const byExplicit = explicitTenantId
    ? (deps.getTenant ? deps.getTenant(explicitTenantId) : tenants.find(tenant => Number(tenant.id) === explicitTenantId))
    : null;
  const byCustomer = customerId
    ? tenants.find(tenant => tenant.stripe_customer_id === customerId) || null
    : null;
  const bySubscription = subscriptionId
    ? tenants.find(tenant => tenant.stripe_subscription_id === subscriptionId) || null
    : null;

  const candidates = [byExplicit, byCustomer, bySubscription].filter(Boolean);
  if (!candidates.length) return { tenant: null, customerId, subscriptionId };
  if (new Set(candidates.map(tenant => Number(tenant.id))).size > 1) {
    throw new Error('Evento Stripe nao pertence ao customer/tenant informado');
  }

  const tenant = candidates[0];
  if (customerId && tenant.stripe_customer_id && tenant.stripe_customer_id !== customerId) {
    throw new Error('Customer Stripe nao pertence ao tenant informado');
  }
  const subscriptionMismatch = Boolean(
    subscriptionId
    && tenant.stripe_subscription_id
    && tenant.stripe_subscription_id !== subscriptionId
  );
  return { tenant, customerId, subscriptionId, subscriptionMismatch };
}

function getTenantAdminEmail(tenantId, deps) {
  try {
    return deps.getTenantDb(tenantId).prepare('SELECT username FROM admins LIMIT 1').get()?.username || null;
  } catch {
    return null;
  }
}

function notifySuspension(tenant, logger, deps) {
  const email = getTenantAdminEmail(tenant.id, deps);
  if (!email) return;
  Promise.resolve(deps.notifyPaymentFailed({ to: email, companyName: tenant.name }, logger))
    .catch(err => logger?.error?.({ err, tenantId: tenant.id }, 'Falha ao notificar suspensao de cobranca'));
}

function applyOrderedBilling(tenant, fields, event, deps) {
  return deps.setBillingFieldsFromStripe(tenant.id, fields, {
    eventCreated: event.created,
    eventId: event.id
  });
}

function processCheckout(event, deps) {
  const session = event.data.object;
  const binding = resolveEventTenant(session, event.type, deps);
  if (!binding.tenant) return { ignored: true, reason: 'tenant_not_found' };

  const fields = {
    stripe_checkout_session_id: session.id,
    // Uma sessao concluida deixa de ser uma reserva temporaria; a assinatura
    // passa a ser o vinculo duravel de capacidade.
    checkout_expires_at: null
  };
  if (binding.customerId) fields.stripe_customer_id = binding.customerId;
  if (binding.subscriptionId) fields.stripe_subscription_id = binding.subscriptionId;

  const expandedSubscription = typeof session.subscription === 'object' ? session.subscription : null;
  let result;
  if (expandedSubscription?.status) {
    const planBinding = resolveSubscriptionPlan(
      expandedSubscription,
      binding.tenant,
      deps.env,
      binding.tenant.stripe_price_id
    );
    fields.billing_status = planBinding.valid
      ? mapStripeStatus(expandedSubscription.status)
      : 'suspended';
    fields.billing_block_reason = planBinding.valid ? null : 'plan_mismatch';
    if (planBinding.valid) {
      fields.plan = planBinding.plan;
      fields.stripe_price_id = planBinding.priceId;
    }
    const trialEndsAt = clampedTrialEndIso(binding.tenant, expandedSubscription.trial_end);
    if (trialEndsAt) fields.trial_ends_at = trialEndsAt;
    result = applyOrderedBilling(binding.tenant, fields, event, deps);
    if (!planBinding.valid && result.applied) {
      deps.logAudit('stripe', 'billing_plan_mismatch', binding.tenant.id, {
        eventId: event.id,
        reason: planBinding.reason,
        priceId: planBinding.priceId
      });
    }
  } else {
    // Checkout concluído já confirma a criação da assinatura. O webhook de
    // subscription trará o status exato em seguida; liberar como trialing aqui
    // evita uma janela falsa de bloqueio entre os dois eventos.
    if (binding.subscriptionId) {
      if (binding.tenant.billing_status === 'checkout_pending') {
        fields.billing_status = 'trialing';
      } else if (binding.subscriptionMismatch && binding.tenant.billing_status === 'suspended') {
        // Recontratacao: troca primeiro o id e sai do estado terminal, mas
        // continua sem acesso ate o webhook autoritativo da nova assinatura.
        // Isso tambem impede que o desempate conservador de eventos no mesmo
        // segundo rejeite `customer.subscription.created` da assinatura nova.
        fields.billing_status = 'checkout_pending';
        fields.billing_block_reason = null;
      }
    }
    result = applyOrderedBilling(binding.tenant, fields, event, deps);
  }
  return { ...result, status: result.tenant.billing_status };
}

function processSubscription(event, deps) {
  const subscription = event.data.object;
  const binding = resolveEventTenant(subscription, event.type, deps);
  if (!binding.tenant) return { ignored: true, reason: 'tenant_not_found' };
  if (binding.subscriptionMismatch) return { ignored: true, reason: 'subscription_mismatch', tenant: binding.tenant };

  const previousStatus = binding.tenant.billing_status;
  const forcedSuspension = ['customer.subscription.deleted', 'customer.subscription.paused'].includes(event.type);
  const planBinding = resolveSubscriptionPlan(subscription, binding.tenant, deps.env);
  const status = forcedSuspension || !planBinding.valid
    ? 'suspended'
    : mapStripeStatus(subscription.status);
  const fields = {
    billing_status: status,
    stripe_subscription_id: binding.subscriptionId || subscription.id,
    ...(['active', 'trialing'].includes(status) ? { checkout_expires_at: null } : {}),
    billing_block_reason: forcedSuspension
      ? 'subscription_inactive'
      : !planBinding.valid ? 'plan_mismatch'
        : status === 'suspended' ? 'subscription_inactive' : null
  };
  if (binding.customerId) fields.stripe_customer_id = binding.customerId;
  if (planBinding.valid) {
    fields.plan = planBinding.plan;
    fields.stripe_price_id = planBinding.priceId;
  }
  const trialEndsAt = status === 'trialing'
    ? clampedTrialEndIso(binding.tenant, subscription.trial_end)
    : undefined;
  if (trialEndsAt) fields.trial_ends_at = trialEndsAt;

  const result = applyOrderedBilling(binding.tenant, fields, event, deps);
  if (result.applied) {
    const effectiveStatus = result.tenant.billing_status;
    if (!planBinding.valid) {
      deps.logAudit('stripe', 'billing_plan_mismatch', binding.tenant.id, {
        eventId: event.id,
        eventType: event.type,
        reason: planBinding.reason,
        priceId: planBinding.priceId
      });
    }
    if (result.capacityBlocked) {
      deps.logAudit('stripe', 'billing_plan_capacity_blocked', binding.tenant.id, {
        eventId: event.id,
        requestedPlan: planBinding.plan
      });
    }
    deps.logAudit('stripe', `billing_${effectiveStatus}`, binding.tenant.id, {
      eventId: event.id,
      eventType: event.type,
      stripeStatus: subscription.status
    });
    const shouldNotify = effectiveStatus === 'suspended'
      && previousStatus !== 'suspended'
      && event.type !== 'customer.subscription.created';
    if (shouldNotify) notifySuspension(result.tenant, deps.logger, deps);
  }
  return { ...result, status: result.tenant.billing_status };
}

function processInvoice(event, deps) {
  const invoice = event.data.object;
  const binding = resolveEventTenant(invoice, event.type, deps);
  if (!binding.tenant) return { ignored: true, reason: 'tenant_not_found' };
  if (!binding.subscriptionId || binding.subscriptionMismatch) {
    return { ignored: true, reason: 'subscription_mismatch', tenant: binding.tenant };
  }

  const isFailure = event.type === 'invoice.payment_failed';
  const previousStatus = binding.tenant.billing_status;
  const terminalBlockReasons = new Set([
    'subscription_inactive',
    'plan_mismatch',
    'plan_capacity'
  ]);
  const terminalBlockReason = previousStatus === 'suspended'
    && terminalBlockReasons.has(binding.tenant.billing_block_reason)
    ? binding.tenant.billing_block_reason
    : null;
  const eventTimeMs = event.created * 1000;
  const trialEndMs = new Date(binding.tenant.trial_ends_at || '').getTime();
  const zeroValueTrialInvoice = !isFailure
    && binding.tenant.billing_status === 'trialing'
    && Number.isFinite(trialEndMs)
    && eventTimeMs < trialEndMs
    && Number(invoice.amount_paid || 0) === 0;
  // invoice.paid só recupera uma suspensão causada por payment_failed. Depois
  // de cancelamento, price mismatch ou capacity block, a reativação exige um
  // subscription.updated/resumed validado contra preço/plano.
  const mayRecoverPaymentFailure = previousStatus === 'suspended'
    && binding.tenant.billing_block_reason === 'payment_failed';
  const status = isFailure
    ? 'suspended'
    : previousStatus === 'suspended' && !mayRecoverPaymentFailure
      ? 'suspended'
      : zeroValueTrialInvoice ? 'trialing' : 'active';
  const result = applyOrderedBilling(binding.tenant, {
    billing_status: status,
    billing_block_reason: isFailure
      ? terminalBlockReason || 'payment_failed'
      : status === 'suspended' ? binding.tenant.billing_block_reason : null,
    stripe_customer_id: binding.customerId || binding.tenant.stripe_customer_id,
    stripe_subscription_id: binding.subscriptionId
  }, event, deps);

  if (result.applied) {
    deps.logAudit('stripe', `billing_${status}`, binding.tenant.id, {
      eventId: event.id,
      eventType: event.type,
      invoiceId: invoice.id
    });
    if (isFailure && previousStatus !== 'suspended') {
      notifySuspension(result.tenant, deps.logger, deps);
    }
  }
  return { ...result, status: result.tenant.billing_status };
}

function handleWebhookEvent(event, logger, overrides = {}) {
  const deps = dependencies({ logger, ...overrides });
  const claim = deps.beginStripeEvent(event);
  if (!claim.shouldProcess) {
    const tenant = claim.record.tenant_id && deps.getTenant ? deps.getTenant(claim.record.tenant_id) : null;
    return {
      processed: false,
      duplicate: true,
      ignored: claim.record.processing_status === 'ignored',
      tenant,
      tenantId: tenant?.id || claim.record.tenant_id || null,
      status: tenant?.billing_status || null
    };
  }

  try {
    let result;
    if (event.type === 'checkout.session.completed') {
      result = processCheckout(event, deps);
    } else if ([
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'customer.subscription.paused',
      'customer.subscription.resumed'
    ].includes(event.type)) {
      result = processSubscription(event, deps);
    } else if (['invoice.paid', 'invoice.payment_failed'].includes(event.type)) {
      result = processInvoice(event, deps);
    } else {
      result = { ignored: true, reason: 'unsupported_event' };
    }

    const tenant = result.tenant || null;
    const ignored = Boolean(result.ignored || result.stale);
    deps.finishStripeEvent(event.id, {
      tenantId: tenant?.id || null,
      status: ignored ? 'ignored' : 'processed',
      detail: {
        reason: result.reason || (result.stale ? 'stale_event' : null),
        billingStatus: tenant?.billing_status || result.status || null
      }
    });
    return {
      processed: !ignored,
      duplicate: false,
      ignored,
      stale: Boolean(result.stale),
      reason: result.reason || null,
      tenant,
      tenantId: tenant?.id || null,
      status: tenant?.billing_status || result.status || null
    };
  } catch (err) {
    try {
      deps.failStripeEvent(event.id, err);
    } catch (persistErr) {
      logger?.error?.({ err: persistErr, eventId: event.id }, 'Falha ao persistir erro de webhook Stripe');
    }
    throw err;
  }
}

async function getBillingOverview(overrides = {}) {
  const deps = dependencies(overrides);
  if (!deps.env.STRIPE_SECRET_KEY && !deps.stripe) return { configured: false };

  const subscriptions = [];
  let startingAfter = null;
  // Stripe pagina as assinaturas em lotes de no maximo 100. Percorrer todas
  // evita que o painel do superadmin e o MRR silenciosamente ignorem clientes.
  for (let pageNumber = 0; pageNumber < 1000; pageNumber += 1) {
    const page = await stripeFrom(deps).subscriptions.list({
      limit: 100,
      status: 'all',
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    subscriptions.push(...(page.data || []));
    if (!page.has_more) break;
    const lastId = page.data?.[page.data.length - 1]?.id;
    if (!lastId || lastId === startingAfter) throw new Error('Paginacao Stripe nao avancou');
    startingAfter = lastId;
    if (pageNumber === 999) throw new Error('Limite de paginacao Stripe excedido');
  }
  const tenants = deps.listTenants();
  const tenantByCustomerId = new Map(tenants.filter(t => t.stripe_customer_id).map(t => [t.stripe_customer_id, t]));
  const rows = subscriptions.map(sub => {
    const customerId = objectId(sub.customer);
    const tenant = tenantByCustomerId.get(customerId);
    const item = sub.items?.data?.[0];
    return {
      tenantId: tenant?.id || null,
      tenantName: tenant?.name || '(cliente sem tenant vinculado)',
      status: sub.status,
      amountCents: item?.price?.unit_amount || 0,
      currency: item?.price?.currency || 'brl',
      currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end)
    };
  });

  return {
    configured: true,
    priceConfigured: Boolean(
      deps.env.STRIPE_PRICE_ID
      || (deps.env.STRIPE_PRICE_ID_BASIC && deps.env.STRIPE_PRICE_ID_PRO)
    ),
    webhookConfigured: Boolean(deps.env.STRIPE_WEBHOOK_SECRET),
    mrrCents: rows
      .filter(row => row.status === 'active' || row.status === 'trialing')
      .reduce((sum, row) => sum + row.amountCents, 0),
    activeCount: rows.filter(row => row.status === 'active').length,
    trialingCount: rows.filter(row => row.status === 'trialing').length,
    pastDueCount: rows.filter(row => row.status === 'past_due' || row.status === 'unpaid').length,
    subscriptions: rows.sort((a, b) => (a.currentPeriodEnd || '').localeCompare(b.currentPeriodEnd || ''))
  };
}

async function listTenantInvoices(tenant, overrides = {}) {
  const deps = dependencies(overrides);
  if (!tenant.stripe_customer_id || (!deps.env.STRIPE_SECRET_KEY && !deps.stripe)) return [];
  const invoices = await stripeFrom(deps).invoices.list({ customer: tenant.stripe_customer_id, limit: 24 });
  return invoices.data.map(inv => ({
    id: inv.id,
    amountCents: inv.amount_paid || inv.amount_due || 0,
    currency: inv.currency,
    status: inv.status,
    created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
    hostedUrl: inv.hosted_invoice_url,
    pdfUrl: inv.invoice_pdf
  }));
}

module.exports = {
  MIN_STRIPE_TRIAL_MS,
  MIN_CHECKOUT_RESERVATION_SECONDS,
  MAX_CHECKOUT_RESERVATION_SECONDS,
  DEFAULT_CHECKOUT_RESERVATION_SECONDS,
  CHECKOUT_EXPIRATION_SAFETY_SECONDS,
  getStripe,
  resetStripeClient,
  getStripePriceId,
  getBillingConfigurationStatus,
  validateStripeConfigurationConnectivity,
  getCheckoutReservationSeconds,
  eligibleTrialEnd,
  clampedTrialEndIso,
  resolveSubscriptionPlan,
  ensureStripeCustomer,
  createCheckoutSession,
  releaseExpiredCheckoutReservation,
  createPortalSession,
  deleteTenantBilling,
  verifyTenantSubscriptionAccess,
  mapStripeStatus,
  handleWebhookEvent,
  getBillingOverview,
  listTenantInvoices,
  getEffectiveBillingStatus: tenantManager.getEffectiveBillingStatus
};
