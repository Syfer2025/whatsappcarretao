const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const tenantManager = require('./tenantManager');
const { handleWebhookEvent } = require('./billing');

function unique(label) {
  return `${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

async function removeTenant(tenant) {
  if (!tenantManager.getTenant(tenant.id)) return;
  await tenantManager.deleteTenant(tenant.id);
}

test('public-style provisioning permits equal company names without sharing a tenant key', async () => {
  const base = tenantManager.tenantSlugBase('Clínica São José');
  const first = tenantManager.createTenant({
    name: 'Clínica São José',
    slug: base,
    uniqueSlug: true
  });
  const second = tenantManager.createTenant({
    name: 'Clínica São José',
    slug: base,
    uniqueSlug: true
  });
  try {
    assert.equal(first.slug, 'clinica-sao-jose');
    assert.notEqual(second.slug, first.slug);
    assert.match(second.slug, /^clinica-sao-jose-[a-f0-9]{8}$/);
    assert.notEqual(first.id, second.id);
    assert.notEqual(tenantManager.getTenantDbPath(first.id), tenantManager.getTenantDbPath(second.id));
  } finally {
    await removeTenant(first);
    await removeTenant(second);
  }
});

test('deferred tenant stays inaccessible until admin and directory ownership are durable', async () => {
  const slug = unique('deferred');
  const tenant = tenantManager.createTenant({
    name: 'Deferred Provisioning',
    slug,
    deferActivation: true
  });
  const username = `${unique('deferred-admin')}@example.test`;
  try {
    assert.equal(tenant.status, 'provisioning');
    assert.equal(tenantManager.getTenantBySubdomain(tenant.subdomain), undefined);
    assert.throws(
      () => tenantManager.activateTenant(tenant.id),
      error => error.statusCode === 409 && /Provisionamento incompleto/.test(error.message)
    );

    tenantManager.getTenantDb(tenant.id).prepare(`
      INSERT INTO admins (name, username, password, super_admin)
      VALUES ('Owner', ?, 'hash-for-test', 0)
    `).run(username);
    assert.throws(
      () => tenantManager.activateTenant(tenant.id),
      error => error.statusCode === 409 && /Provisionamento incompleto/.test(error.message)
    );

    tenantManager.registerDirectoryUser(username, tenant.id, 'admin');
    const active = tenantManager.activateTenant(tenant.id);
    assert.equal(active.status, 'active');
    assert.equal(tenantManager.getTenantBySubdomain(tenant.subdomain).id, tenant.id);
  } finally {
    await removeTenant(tenant);
  }
});

test('stale provisioning is discoverable for boot recovery without exposing it as active', async () => {
  const tenant = tenantManager.createTenant({
    name: 'Stale Provisioning',
    slug: unique('stale-provisioning'),
    deferActivation: true
  });
  try {
    tenantManager.master.prepare(`
      UPDATE tenants SET created_at = datetime('now', '-1 hour') WHERE id = ?
    `).run(tenant.id);
    const stale = tenantManager.listStaleProvisioningTenants(15 * 60 * 1000);
    assert.equal(stale.some(item => Number(item.id) === Number(tenant.id)), true);
    assert.equal(tenantManager.getTenantBySubdomain(tenant.subdomain), undefined);
  } finally {
    await removeTenant(tenant);
  }
});

test('runtime tenant capacity is reserved atomically before accepting another company', async () => {
  const currentCommercial = Number(tenantManager.master.prepare(`
    SELECT COUNT(*) AS total
    FROM tenants
    WHERE lower(slug) <> 'default'
      AND status IN ('active', 'provisioning')
  `).get().total);
  const limit = currentCommercial + 1;
  const tenant = tenantManager.createTenant({
    name: 'Capacity Reservation',
    slug: unique('runtime-capacity'),
    runtimeTenantLimit: limit
  });
  try {
    assert.throws(
      () => tenantManager.createTenant({
        name: 'Capacity Overflow',
        slug: unique('runtime-overflow'),
        runtimeTenantLimit: limit
      }),
      error => error.statusCode === 503 && error.code === 'TENANT_RUNTIME_CAPACITY_REACHED'
    );
  } finally {
    await removeTenant(tenant);
  }
});

test('abandoned checkout reservations are discoverable without selecting live or subscribed tenants', async () => {
  const expired = tenantManager.createTenant({
    name: 'Expired Checkout',
    slug: unique('expired-checkout')
  });
  const live = tenantManager.createTenant({
    name: 'Live Checkout',
    slug: unique('live-checkout')
  });
  const subscribed = tenantManager.createTenant({
    name: 'Subscribed Checkout',
    slug: unique('subscribed-checkout')
  });
  try {
    const now = Date.now();
    tenantManager.setBillingFields(expired.id, {
      billing_status: 'checkout_pending',
      stripe_checkout_session_id: `cs_expired_${expired.id}`,
      checkout_expires_at: new Date(now - 1000).toISOString()
    });
    tenantManager.setBillingFields(live.id, {
      billing_status: 'checkout_pending',
      stripe_checkout_session_id: `cs_live_${live.id}`,
      checkout_expires_at: new Date(now + 60_000).toISOString()
    });
    tenantManager.setBillingFields(subscribed.id, {
      billing_status: 'trialing',
      stripe_checkout_session_id: `cs_subscribed_${subscribed.id}`,
      stripe_subscription_id: `sub_${subscribed.id}`,
      checkout_expires_at: new Date(now - 1000).toISOString()
    });
    const candidates = tenantManager.listExpiredCheckoutReservations({ now });
    assert.equal(candidates.some(row => row.id === expired.id), true);
    assert.equal(candidates.some(row => row.id === live.id), false);
    assert.equal(candidates.some(row => row.id === subscribed.id), false);
  } finally {
    await removeTenant(expired);
    await removeTenant(live);
    await removeTenant(subscribed);
  }
});

test('directory ownership is immutable under duplicate registration and failed rename', async () => {
  const first = tenantManager.createTenant({ name: 'Owner A', slug: unique('owner-a') });
  const second = tenantManager.createTenant({ name: 'Owner B', slug: unique('owner-b') });
  const shared = `${unique('login')}@example.test`;
  const occupied = `${unique('occupied')}@example.test`;
  try {
    tenantManager.registerDirectoryUser(shared, first.id, 'admin');
    tenantManager.registerDirectoryUser(occupied, second.id, 'admin');

    assert.throws(
      () => tenantManager.registerDirectoryUser(shared, second.id, 'admin'),
      error => error.statusCode === 409
    );
    assert.equal(Number(tenantManager.findDirectoryUser(shared).tenant_id), Number(first.id));

    assert.throws(
      () => tenantManager.renameDirectoryUser(shared, occupied, first.id, 'admin'),
      error => error.statusCode === 409
    );
    assert.equal(Number(tenantManager.findDirectoryUser(shared).tenant_id), Number(first.id));
    assert.equal(Number(tenantManager.findDirectoryUser(occupied).tenant_id), Number(second.id));
  } finally {
    await removeTenant(first);
    await removeTenant(second);
  }
});

test('Stripe customer, subscription and checkout identifiers have one tenant owner', async () => {
  const first = tenantManager.createTenant({ name: 'Stripe A', slug: unique('stripe-a') });
  const second = tenantManager.createTenant({ name: 'Stripe B', slug: unique('stripe-b') });
  try {
    tenantManager.setBillingFields(first.id, {
      stripe_customer_id: 'cus_unique_owner',
      stripe_subscription_id: 'sub_unique_owner',
      stripe_checkout_session_id: 'cs_unique_owner'
    });
    for (const fields of [
      { stripe_customer_id: 'cus_unique_owner' },
      { stripe_subscription_id: 'sub_unique_owner' },
      { stripe_checkout_session_id: 'cs_unique_owner' }
    ]) {
      assert.throws(() => tenantManager.setBillingFields(second.id, fields), /UNIQUE constraint failed/);
    }
    const untouched = tenantManager.getTenant(second.id);
    assert.equal(untouched.stripe_customer_id, null);
    assert.equal(untouched.stripe_subscription_id, null);
    assert.equal(untouched.stripe_checkout_session_id, null);
  } finally {
    await removeTenant(first);
    await removeTenant(second);
  }
});

test('Stripe webhook processing uses a lease instead of running the same event concurrently', () => {
  const eventId = `evt_lease_${unique('stripe-event')}`;
  const event = { id: eventId, type: 'invoice.paid', created: 1234 };

  const first = tenantManager.beginStripeEvent(event);
  const concurrent = tenantManager.beginStripeEvent(event);

  assert.equal(first.shouldProcess, true);
  assert.equal(concurrent.shouldProcess, false);
  assert.equal(concurrent.inProgress, true);
  assert.equal(concurrent.record.attempts, 1);

  tenantManager.failStripeEvent(eventId, new Error('falha simulada'));
  const retry = tenantManager.beginStripeEvent(event);
  assert.equal(retry.shouldProcess, true);
  assert.equal(retry.record.attempts, 2);
  tenantManager.finishStripeEvent(eventId, { status: 'ignored' });
});

test('Stripe suspension wins events tied in the same second regardless of arrival order', async () => {
  const tenant = tenantManager.createTenant({ name: 'Stripe Tie', slug: unique('stripe-tie') });
  try {
    tenantManager.setBillingFields(tenant.id, { billing_status: 'active' });
    tenantManager.setBillingFieldsFromStripe(tenant.id, { billing_status: 'active' }, {
      eventCreated: 100,
      eventId: 'evt_tie_active_first'
    });
    tenantManager.setBillingFieldsFromStripe(tenant.id, { billing_status: 'suspended' }, {
      eventCreated: 100,
      eventId: 'evt_tie_suspend_second'
    });
    const blocked = tenantManager.setBillingFieldsFromStripe(tenant.id, { billing_status: 'active' }, {
      eventCreated: 100,
      eventId: 'evt_tie_late_reactivation'
    });
    assert.equal(blocked.applied, false);
    assert.equal(blocked.tieBlocked, true);
    assert.equal(tenantManager.getTenant(tenant.id).billing_status, 'suspended');
    assert.equal(tenantManager.getTenant(tenant.id).stripe_last_event_id, 'evt_tie_suspend_second');
  } finally {
    await removeTenant(tenant);
  }
});

test('real billing persistence never lets invoices release terminal cancellation or plan mismatch blocks', async () => {
  const tenant = tenantManager.createTenant({ name: 'Stripe Terminal', slug: unique('stripe-terminal') });
  const eventDeps = {
    env: {
      STRIPE_PRICE_ID_BASIC: 'price_basic',
      STRIPE_PRICE_ID_PRO: 'price_professional'
    },
    notifyPaymentFailed: () => Promise.resolve(true)
  };
  const subscriptionEvent = (id, created, type, priceId, plan, status = 'active') => ({
    id,
    created,
    type,
    data: {
      object: {
        id: 'sub_terminal',
        customer: 'cus_terminal',
        status,
        metadata: { tenant_id: String(tenant.id), plan },
        items: { data: [{ price: { id: priceId } }] }
      }
    }
  });
  const invoiceEvent = (id, created, type) => ({
    id,
    created,
    type,
    data: {
      object: {
        id: `in_${id}`,
        customer: 'cus_terminal',
        amount_paid: type === 'invoice.paid' ? 1000 : 0,
        parent: {
          subscription_details: {
            subscription: 'sub_terminal',
            metadata: { tenant_id: String(tenant.id) }
          }
        }
      }
    }
  });
  try {
    tenantManager.setBillingFields(tenant.id, {
      billing_status: 'active',
      stripe_customer_id: 'cus_terminal',
      stripe_subscription_id: 'sub_terminal',
      stripe_price_id: 'price_basic'
    });
    handleWebhookEvent(
      subscriptionEvent(
        `evt_terminal_delete_${tenant.id}`,
        300,
        'customer.subscription.deleted',
        'price_basic',
        'basico',
        'canceled'
      ),
      null,
      eventDeps
    );
    handleWebhookEvent(invoiceEvent(`evt_terminal_failed_${tenant.id}`, 300, 'invoice.payment_failed'), null, eventDeps);
    handleWebhookEvent(invoiceEvent(`evt_terminal_paid_${tenant.id}`, 301, 'invoice.paid'), null, eventDeps);
    assert.equal(tenantManager.getTenant(tenant.id).billing_status, 'suspended');
    assert.equal(tenantManager.getTenant(tenant.id).billing_block_reason, 'subscription_inactive');

    handleWebhookEvent(
      subscriptionEvent(
        `evt_terminal_mismatch_${tenant.id}`,
        400,
        'customer.subscription.updated',
        'price_professional',
        'basico'
      ),
      null,
      eventDeps
    );
    handleWebhookEvent(invoiceEvent(`evt_mismatch_failed_${tenant.id}`, 401, 'invoice.payment_failed'), null, eventDeps);
    handleWebhookEvent(invoiceEvent(`evt_mismatch_paid_${tenant.id}`, 402, 'invoice.paid'), null, eventDeps);
    assert.equal(tenantManager.getTenant(tenant.id).billing_status, 'suspended');
    assert.equal(tenantManager.getTenant(tenant.id).billing_block_reason, 'plan_mismatch');
  } finally {
    await removeTenant(tenant);
  }
});

test('plan reduction fails closed when active users exceed the proposed limit', async () => {
  const tenant = tenantManager.createTenant({
    name: 'Capacity',
    slug: unique('capacity'),
    plan: 'profissional'
  });
  try {
    const tenantDb = tenantManager.getTenantDb(tenant.id);
    const insert = tenantDb.prepare(`
      INSERT INTO vendors (name, username, password, active)
      VALUES (?, ?, 'hash-for-test', 1)
    `);
    for (let index = 1; index <= 6; index += 1) {
      insert.run(`User ${index}`, `${unique(`user-${index}`)}@example.test`);
    }

    assert.throws(
      () => tenantManager.updateTenant(tenant.id, { plan: 'basico' }),
      error => error.statusCode === 409 && /6 usuarios ativos/.test(error.message)
    );
    assert.equal(tenantManager.getTenant(tenant.id).plan, 'profissional');

    const updated = tenantManager.updateTenant(tenant.id, {
      plan: 'basico',
      user_limit_override: 6
    });
    assert.equal(updated.plan, 'basico');
    assert.equal(updated.user_limit_override, 6);
  } finally {
    await removeTenant(tenant);
  }
});

test('Stripe plan downgrade suspends instead of oversubscribing the five-user plan', async () => {
  const tenant = tenantManager.createTenant({
    name: 'Stripe Capacity',
    slug: unique('stripe-capacity'),
    plan: 'profissional'
  });
  try {
    const tenantDb = tenantManager.getTenantDb(tenant.id);
    const insert = tenantDb.prepare(`
      INSERT INTO vendors (name, username, password, active)
      VALUES (?, ?, 'hash-for-test', 1)
    `);
    for (let index = 1; index <= 6; index += 1) {
      insert.run(`Stripe User ${index}`, `${unique(`stripe-user-${index}`)}@example.test`);
    }
    const result = tenantManager.setBillingFieldsFromStripe(tenant.id, {
      billing_status: 'active',
      plan: 'basico',
      stripe_price_id: 'price_basic'
    }, {
      eventCreated: 200,
      eventId: 'evt_capacity_downgrade'
    });
    assert.equal(result.capacityBlocked, true);
    assert.equal(result.tenant.plan, 'basico');
    assert.equal(result.tenant.billing_status, 'suspended');
    assert.equal(result.tenant.billing_block_reason, 'plan_capacity');
    assert.equal(result.tenant.billing_resume_status, 'active');

    tenantDb.prepare('UPDATE vendors SET active = 0 WHERE id = (SELECT MAX(id) FROM vendors)').run();
    const recovered = tenantManager.recoverPlanCapacityBlock(tenant.id);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.activeUsers, 5);
    assert.equal(recovered.limit, 5);
    assert.equal(recovered.tenant.billing_status, 'active');
    assert.equal(recovered.tenant.billing_block_reason, null);
    assert.equal(recovered.tenant.billing_resume_status, null);
  } finally {
    await removeTenant(tenant);
  }
});

test('tenant updates validate identity fields and distinguish missing records', async () => {
  const tenant = tenantManager.createTenant({ name: 'Validation', slug: unique('validation') });
  try {
    assert.throws(
      () => tenantManager.updateTenant(tenant.id, { slug: '../outro-tenant' }),
      error => error.statusCode === 400
    );
    assert.throws(
      () => tenantManager.updateTenant(Number.MAX_SAFE_INTEGER, { name: 'Missing' }),
      error => error.statusCode === 404
    );
  } finally {
    await removeTenant(tenant);
  }
});

test('artifact initialization failure rolls back the master tenant record', () => {
  const fsModule = require('fs');
  const originalMkdirSync = fsModule.mkdirSync;
  const slug = unique('disk-failure');
  const authRoot = path.resolve(process.env.WA_AUTH_DIR || path.join(__dirname, '.wwebjs_auth'));
  let injected = false;
  fsModule.mkdirSync = function (target, options) {
    const resolved = path.resolve(String(target));
    if (!injected && resolved.startsWith(`${authRoot}${path.sep}tenant_`)) {
      injected = true;
      const error = new Error('falha de disco simulada');
      error.code = 'EIO';
      throw error;
    }
    return originalMkdirSync.call(this, target, options);
  };
  try {
    assert.throws(
      () => tenantManager.createTenant({ name: 'Disk Failure', slug }),
      /falha de disco simulada/
    );
    assert.equal(tenantManager.getTenantBySlug(slug), undefined);
  } finally {
    fsModule.mkdirSync = originalMkdirSync;
  }
});

test('deletion removes only registered tenant-namespaced media and records durable cleanup', async () => {
  const tenant = tenantManager.createTenant({ name: 'Delete Media', slug: unique('delete-media') });
  const mediaRoot = path.resolve(process.env.MEDIA_ROOT || path.join(__dirname, 'media'));
  fs.mkdirSync(mediaRoot, { recursive: true });
  const ownedFilename = `t${tenant.id}-owned.jpg`;
  const supportFilename = `t${tenant.id}-support.pdf`;
  const otherFilename = `t999999-other.jpg`;
  const ownedPath = path.join(mediaRoot, ownedFilename);
  const supportPath = path.join(mediaRoot, supportFilename);
  const otherPath = path.join(mediaRoot, otherFilename);
  fs.writeFileSync(ownedPath, 'owned');
  fs.writeFileSync(supportPath, 'support');
  fs.writeFileSync(otherPath, 'other');

  const tenantDb = tenantManager.getTenantDb(tenant.id);
  const conversation = tenantDb.prepare(`
    INSERT INTO conversations (phone, status) VALUES ('5511999999999@c.us', 'active')
  `).run();
  tenantDb.prepare(`
    INSERT INTO messages (conversation_id, from_type, content, media_url)
    VALUES (?, 'customer', '', ?)
  `).run(conversation.lastInsertRowid, `/media/${ownedFilename}`);
  const thread = tenantManager.master.prepare(`
    INSERT INTO support_threads (tenant_id) VALUES (?)
  `).run(tenant.id);
  tenantManager.master.prepare(`
    INSERT INTO support_messages
      (thread_id, tenant_id, sender_type, content, media_url)
    VALUES (?, ?, 'tenant', '', ?)
  `).run(thread.lastInsertRowid, tenant.id, `/support-media/${supportFilename}`);

  const deletion = await tenantManager.deleteTenant(tenant.id);
  assert.equal(deletion.cleanup.processed, true);
  assert.equal(deletion.cleanup.mediaFiles, 2);
  assert.equal(fs.existsSync(ownedPath), false);
  assert.equal(fs.existsSync(supportPath), false);
  assert.equal(fs.existsSync(otherPath), true);
  assert.equal(tenantManager.getTenant(tenant.id), undefined);
  fs.rmSync(otherPath, { force: true });
});

test('external deletion uncertainty stays forward-only and is resumed without restoring access', async () => {
  const tenant = tenantManager.createTenant({ name: 'Rollback Delete', slug: unique('rollback-delete') });
  const username = `${unique('rollback-admin')}@example.test`;
  const tenantDb = tenantManager.getTenantDb(tenant.id);
  tenantDb.prepare(`
    INSERT INTO admins (name, username, password, super_admin)
    VALUES ('Rollback', ?, 'hash-for-test', 0)
  `).run(username);
  tenantManager.registerDirectoryUser(username, tenant.id, 'admin');
  const dbPath = tenantManager.getTenantDbPath(tenant.id);
  let observedDurableIntent = false;
  let deletionError;

  try {
    await tenantManager.deleteTenant(tenant.id, {
      afterQuarantine: async () => {
        const intent = tenantManager.master.prepare(`
          SELECT status, commit_state FROM tenant_deletion_restore
          WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1
        `).get(tenant.id);
        observedDurableIntent = intent?.status === 'pending'
          && intent?.commit_state === 'forward_only'
          && tenantManager.getTenant(tenant.id)?.status === 'suspended'
          && !fs.existsSync(dbPath);
        throw new Error('Stripe temporariamente indisponivel');
      }
    });
  } catch (error) {
    deletionError = error;
  }

  assert.equal(observedDurableIntent, true);
  assert.match(deletionError?.message || '', /Stripe temporariamente indisponivel/);
  assert.equal(deletionError?.deletionPending, true);
  assert.equal(tenantManager.getTenant(tenant.id).status, 'suspended');
  assert.equal(fs.existsSync(dbPath), false);
  assert.throws(
    () => tenantManager.getTenantDb(tenant.id),
    error => error.code === 'TENANT_DELETION_PENDING'
  );
  assert.equal(fs.existsSync(dbPath), false);
  assert.equal(Number(tenantManager.findDirectoryUser(username).tenant_id), Number(tenant.id));

  let resumedExternalCalls = 0;
  const resumed = await tenantManager.processForwardTenantDeletions(async current => {
    resumedExternalCalls += 1;
    assert.equal(Number(current.id), Number(tenant.id));
  }, deletionError.deletionId);
  assert.equal(resumedExternalCalls, 1);
  assert.equal(resumed[0].committed, true);
  assert.equal(resumed[0].cleanup.processed, true);
  assert.equal(tenantManager.getTenant(tenant.id), undefined);
  assert.equal(tenantManager.findDirectoryUser(username), undefined);
  assert.equal(fs.existsSync(dbPath), false);
});

test('missing tenant database fails closed and is never silently recreated', async () => {
  const tenant = tenantManager.createTenant({ name: 'Missing DB', slug: unique('missing-db') });
  const dbPath = tenantManager.getTenantDbPath(tenant.id);
  tenantManager.closeTenantDb(tenant.id);
  for (const filename of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    fs.rmSync(filename, { force: true });
  }
  try {
    assert.throws(
      () => tenantManager.getTenantDb(tenant.id),
      error => error.statusCode === 503 && error.code === 'TENANT_DB_MISSING'
    );
    assert.equal(fs.existsSync(dbPath), false);
  } finally {
    await removeTenant(tenant);
  }
});

test('physical deletion failures remain durable and succeed on retry', async () => {
  const tenant = tenantManager.createTenant({ name: 'Cleanup Retry', slug: unique('cleanup-retry') });
  const fsModule = require('fs');
  const originalRmSync = fsModule.rmSync;
  let injected = false;
  fsModule.rmSync = function (target, options) {
    if (!injected && String(target).includes('.deleting-')) {
      injected = true;
      const error = new Error('arquivo ocupado');
      error.code = 'EBUSY';
      throw error;
    }
    return originalRmSync.call(this, target, options);
  };

  let deletion;
  try {
    deletion = await tenantManager.deleteTenant(tenant.id);
  } finally {
    fsModule.rmSync = originalRmSync;
  }
  assert.equal(deletion.cleanup.processed, false);
  assert.equal(tenantManager.getTenant(tenant.id), undefined);

  const retried = tenantManager.processTenantDeletionCleanup(deletion.cleanup.deletionId)[0];
  assert.equal(retried.processed, true);
  const job = tenantManager.master.prepare(`
    SELECT status, attempts FROM tenant_deletion_cleanup WHERE deletion_id = ?
  `).get(deletion.cleanup.deletionId);
  assert.equal(job.status, 'processed');
  assert.equal(job.attempts, 2);
});

test('failure before the irreversible boundary restores the original tenant status', async () => {
  const tenant = tenantManager.createTenant({ name: 'Restore Retry', slug: unique('restore-retry') });
  let deletionError;
  try {
    await tenantManager.deleteTenant(tenant.id, {
      beforeDelete: async () => { throw new Error('falha reversivel'); }
    });
  } catch (error) {
    deletionError = error;
  }
  assert.match(deletionError?.message || '', /falha reversivel/);
  assert.equal(deletionError?.deletionPending, undefined);
  assert.equal(tenantManager.getTenant(tenant.id).status, 'active');
  assert.equal(fs.existsSync(tenantManager.getTenantDbPath(tenant.id)), true);
  await removeTenant(tenant);
});

test('the operational default tenant cannot be deleted', async () => {
  const defaultTenant = tenantManager.getTenantBySlug('default');
  await assert.rejects(
    tenantManager.deleteTenant(defaultTenant.id),
    error => error.statusCode === 409
  );
  assert.ok(tenantManager.getTenant(defaultTenant.id));
});

test.after(() => tenantManager.closeAllDbs());
