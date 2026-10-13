import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { enqueueDue, dispatchOne } from '../src/sms.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = createApp(pool);
const uid = crypto.randomUUID().slice(0, 8);
const registration = async (name: string) => {
  const email = `${name}-${uid}@example.test`, password = 'Only synthetic test password 2026';
  const r = await request(app).post('/api/auth/register').send({ storeName: `Synthetic ${name}`, email, password });
  expect(r.status).toBe(201);
  return { email, password, cookie: r.headers['set-cookie'][0].split(';')[0], csrf: r.body.data.csrf as string, store: r.body.data.store };
};
const headers = (a: Awaited<ReturnType<typeof registration>>) => ({ Cookie: a.cookie, 'X-CSRF-Token': a.csrf });
const rpcAuth = () => `Basic ${Buffer.from(`Paycom:${process.env.PAYME_KEY}`).toString('base64')}`;
const rpc = (method: string, params: object, auth = rpcAuth()) => request(app).post('/api/provider/payme').set('Authorization', auth).send({ id: 12, method, params });
const customer = async (a: Awaited<ReturnType<typeof registration>>) => {
  const r = await request(app).post('/api/customers').set(headers(a)).send({ name: 'Synthetic customer', phone: '901234567', consentEvidence: 'Synthetic consent evidence' });
  expect(r.status).toBe(201); return r.body.data.id as string;
};
const debt = (a: Awaited<ReturnType<typeof registration>>, customerId: string) => request(app).post('/api/debts').set(headers(a)).send({ customerId, items: [{ title: 'Synthetic item', quantity: 1, unitPrice: 50000 }] });
beforeAll(async () => {
  await pool.query('SELECT 1');
  process.env.PAYME_CALLBACK_ENABLED = '1'; process.env.PAYME_CHECKOUT_MODE = 'sandbox';
  process.env.PAYME_MERCHANT_ID = 'synthetic-test-merchant'; process.env.PAYME_KEY = 'synthetic-test-key-not-a-real-merchant';
  process.env.PLATFORM_REPORT_TOKEN = 'synthetic-platform-token-long-enough-for-tests';
});
afterAll(async () => { delete process.env.PAYME_CALLBACK_ENABLED; delete process.env.PAYME_MERCHANT_ID; delete process.env.PAYME_KEY; delete process.env.PLATFORM_REPORT_TOKEN; await pool.end(); });

describe('subscription and Payme Merchant API (synthetic callbacks only)', () => {
  it('starts one 14-calendar-day trial; login cannot reset; exposes exact prices and T-3/T-1 warnings', async () => {
    const a = await registration('trial');
    const p = await request(app).get('/api/subscription/plans');
    expect(p.body.data.plans).toEqual([{ months: 1, amountUzs: 60000 }, { months: 2, amountUzs: 100000 }]);
    const initial = await request(app).get('/api/subscription').set(headers(a));
    expect(initial.body.data.state).toBe('trial');
    const dates = await pool.query("SELECT ((trial_ends_at AT TIME ZONE 'Asia/Tashkent')::date - (trial_started_at AT TIME ZONE 'Asia/Tashkent')::date) AS days FROM stores WHERE id=$1", [a.store.id]);
    expect(dates.rows[0].days).toBe(14);
    await pool.query("UPDATE stores SET trial_started_at=now()-interval '11 days',trial_ends_at=now()+interval '3 days' WHERE id=$1", [a.store.id]);
    expect((await request(app).get('/api/subscription').set(headers(a))).body.data.warning).toBe('TRIAL_T_MINUS_3');
    await pool.query("UPDATE stores SET trial_started_at=now()-interval '13 days',trial_ends_at=now()+interval '1 day' WHERE id=$1", [a.store.id]);
    expect((await request(app).get('/api/subscription').set(headers(a))).body.data.warning).toBe('TRIAL_T_MINUS_1');
    const beforeLogin = (await pool.query('SELECT trial_started_at FROM stores WHERE id=$1', [a.store.id])).rows[0].trial_started_at;
    const login = await request(app).post('/api/auth/login').send({ email: a.email, password: a.password });
    expect(login.status).toBe(200);
    expect((await pool.query('SELECT trial_started_at FROM stores WHERE id=$1', [a.store.id])).rows[0].trial_started_at).toEqual(beforeLogin);
    expect((await request(app).post('/api/auth/register').send({ storeName: 'Other synthetic', email: a.email, password: a.password })).status).toBe(409);
  });
  it('checkout is disabled without merchant settings and rejects spoofed Basic auth', async () => {
    const a = await registration('disabled');
    process.env.PAYME_CALLBACK_ENABLED = '0';
    try {
      expect((await request(app).post('/api/subscription/initiate').set(headers(a)).set('Idempotency-Key', crypto.randomUUID()).send({ months: 1 })).status).toBe(503);
      expect((await rpc('CheckPerformTransaction', {}, 'Basic spoofed')).status).toBe(503);
    } finally { process.env.PAYME_CALLBACK_ENABLED = '1'; }
    const spoof = await rpc('CheckPerformTransaction', {}, 'Basic spoofed');
    expect(spoof.status).toBe(200); expect(spoof.body.error.code).toBe(-32504);
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM subscription_attempts WHERE store_id=$1', [a.store.id])).rows[0].n).toBe(0);
  });
  it('deduplicates initiation, verifies amount/account/provider ID; activates once on authenticated Perform', async () => {
    const a = await registration('pay'); const b = await registration('tenant');
    const idempotency = crypto.randomUUID();
    const initiate = (actor: typeof a, months: number, key: string) => request(app).post('/api/subscription/initiate').set(headers(actor)).set('Idempotency-Key', key).send({ months });
    const [first, replay] = await Promise.all([initiate(a, 2, idempotency), initiate(a, 2, idempotency)]);
    expect(first.status).toBe(201); expect(replay.body.data.attemptId).toBe(first.body.data.attemptId);
    expect(first.body.data.amountUzs).toBe(100000);
    expect(first.body.data.checkoutUrl).toContain('test.paycom.uz/');
    expect((await initiate(a, 1, idempotency)).status).toBe(409);
    expect((await request(app).get('/api/subscription/history').set(headers(b))).body.data.attempts).toEqual([]);
    expect((await request(app).get('/api/subscription/history').set(headers(a))).body.data.attempts).toHaveLength(1);
    const employeeEmail = `sub-employee-${uid}@example.test`;
    expect((await request(app).post('/api/employees').set(headers(a)).send({ email: employeeEmail, password: a.password })).status).toBe(201);
    const employeeLogin = await request(app).post('/api/auth/login').send({ email: employeeEmail, password: a.password });
    const employeeCookie = employeeLogin.headers['set-cookie'][0].split(';')[0];
    expect((await request(app).post('/api/subscription/initiate').set({ Cookie: employeeCookie, 'X-CSRF-Token': employeeLogin.body.data.csrf }).set('Idempotency-Key', crypto.randomUUID()).send({ months: 1 })).status).toBe(403);
    const order = first.body.data.attemptId as string, providerId = `synthetic-${crypto.randomUUID()}`, time = Date.now();
    const params = { id: providerId, time, amount: 10_000_000, account: { order_id: order } };
    expect((await rpc('CheckPerformTransaction', { amount: 6_000_000, account: { order_id: order } })).body.error.code).toBe(-31001);
    expect((await rpc('CreateTransaction', { ...params, amount: 6_000_000 })).body.error.code).toBe(-31001);
    expect((await rpc('PerformTransaction', { id: providerId })).body.error.code).toBe(-31003);
    const created = await rpc('CreateTransaction', params);
    expect(created.body.result.state).toBe(1);
    expect((await rpc('CreateTransaction', params)).body.result).toEqual(created.body.result);
    expect((await rpc('CreateTransaction', { ...params, id: 'other-id' })).body.error.code).toBe(-31008);
    const paid = await rpc('PerformTransaction', { id: providerId });
    expect(paid.body.result.state).toBe(2);
    expect((await rpc('PerformTransaction', { id: providerId })).body.result).toEqual(paid.body.result);
    expect((await rpc('CheckTransaction', { id: providerId })).body.result.state).toBe(2);
    expect((await rpc('CancelTransaction', { id: providerId, reason: 1 })).body.error.code).toBe(-31007);
    const status = await request(app).get('/api/subscription').set(headers(a));
    expect(status.body.data.state).toBe('active'); expect(status.body.data.planMonths).toBe(2);
    const rows = await pool.query("SELECT status,period_start,period_end,amount_uzs FROM subscription_attempts WHERE id=$1", [order]);
    expect(rows.rows[0].amount_uzs).toBe(100000);
    expect(rows.rows[0].period_end > rows.rows[0].period_start).toBe(true);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM subscription_events WHERE attempt_id=$1 AND kind='paid'", [order])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT COUNT(*)::int AS n FROM audit WHERE entity_id=$1 AND action='subscription.activated'", [order])).rows[0].n).toBe(1);
    expect((await request(app).get('/api/platform/subscriptions/summary').set(headers(a))).status).toBe(403);
    const report = await request(app).get('/api/platform/subscriptions/summary').set('Authorization', `Bearer ${process.env.PLATFORM_REPORT_TOKEN}`);
    expect(report.status).toBe(200); expect(report.body.data.byPlan.some((r: any) => r.plan_months === 2)).toBe(true);
  });
  it('cancels unperformed provider transaction and keeps existing repayment/read/export after expiry', async () => {
    const a = await registration('expire'); const c = await customer(a);
    const d = await debt(a, c); expect(d.status).toBe(201);
    const r = await request(app).post('/api/subscription/initiate').set(headers(a)).set('Idempotency-Key', crypto.randomUUID()).send({ months: 1 });
    const providerId = `synthetic-${crypto.randomUUID()}`;
    expect((await rpc('CreateTransaction', { id: providerId, time: Date.now(), amount: 6_000_000, account: { order_id: r.body.data.attemptId } })).body.result.state).toBe(1);
    expect((await rpc('CancelTransaction', { id: providerId, reason: 4 })).body.result.state).toBe(-1);
    expect((await rpc('CancelTransaction', { id: providerId, reason: 4 })).body.result.state).toBe(-1);
    expect((await rpc('PerformTransaction', { id: providerId })).body.error.code).toBe(-31008);
    await pool.query("UPDATE stores SET trial_started_at=now()-interval '15 days',trial_ends_at=now()-interval '1 day' WHERE id=$1", [a.store.id]);
    expect((await request(app).get('/api/subscription').set(headers(a))).body.data.state).toBe('expired');
    expect((await debt(a, c)).status).toBe(402);
    expect((await request(app).get(`/api/debts/${d.body.data.id}`).set(headers(a))).status).toBe(200);
    expect((await request(app).get('/api/export').set(headers(a))).body.data.debts).toHaveLength(1);
    expect((await request(app).post('/api/payments').set(headers(a)).set('Idempotency-Key', crypto.randomUUID()).send({ customerId: c, allocations: [{ debtId: d.body.data.id, amount: 1000 }] })).status).toBe(201);
    expect((await enqueueDue(pool)).valueOf()).toBe(0);
    let sent = 0;
    await pool.query("INSERT INTO sms_outbox(store_id,debt_id,customer_id,local_date) VALUES($1,$2,$3,(now() AT TIME ZONE 'Asia/Tashkent')::date)", [a.store.id, d.body.data.id, c]);
    await dispatchOne(pool, { async send() { sent++; return 'accepted'; } });
    expect(sent).toBe(0);
  });
  it('renews from existing entitlement with calendar clamp, then preserves access on cancellation', async () => {
    const a = await registration('renew');
    await pool.query("UPDATE stores SET paid_until='2027-01-31 05:30:00+00' WHERE id=$1", [a.store.id]);
    const pay = async (months: number) => {
      const i = await request(app).post('/api/subscription/initiate').set(headers(a)).set('Idempotency-Key', crypto.randomUUID()).send({ months });
      expect(i.status).toBe(201);
      const id = `synthetic-${crypto.randomUUID()}`;
      expect((await rpc('CreateTransaction', { id, time: Date.now(), amount: i.body.data.amountUzs * 100, account: { order_id: i.body.data.attemptId } })).body.result.state).toBe(1);
      expect((await rpc('PerformTransaction', { id })).body.result.state).toBe(2);
      return i.body.data.attemptId as string;
    };
    const first = await pay(1);
    const feb = (await pool.query('SELECT period_start,period_end FROM subscription_attempts WHERE id=$1', [first])).rows[0];
    expect(feb.period_start.toISOString()).toBe('2027-01-31T05:30:00.000Z');
    expect(feb.period_end.toISOString()).toBe('2027-02-28T05:30:00.000Z');
    const second = await pay(2);
    const april = (await pool.query('SELECT period_start,period_end FROM subscription_attempts WHERE id=$1', [second])).rows[0];
    expect(april.period_start.toISOString()).toBe('2027-02-28T05:30:00.000Z');
    expect(april.period_end.toISOString()).toBe('2027-04-28T05:30:00.000Z');
    const cancelled = await request(app).post('/api/subscription/cancel').set(headers(a)).send({});
    expect(cancelled.status).toBe(200);
    expect((await request(app).get('/api/subscription').set(headers(a))).body.data.state).toBe('cancelled');
    const c = await customer(a);
    expect((await debt(a, c)).status).toBe(201);
  });
  it('PostgreSQL calendar-month arithmetic clamps Jan31 and leap day, retains local time independent of UTC', async () => {
    const { rows } = await pool.query(`SELECT
      (('2027-01-31 10:30'::timestamp + interval '1 month')::date)::text AS feb28,
      (('2028-01-31 10:30'::timestamp + interval '1 month')::date)::text AS feb29,
      (('2028-01-31 10:30'::timestamp + interval '2 months')::date)::text AS mar31,
      (('2028-02-29 10:30'::timestamp + interval '1 year')::date)::text AS leap_year,
      (('2028-01-31 10:30'::timestamp + interval '1 month') AT TIME ZONE 'Asia/Tashkent') AS utc_wall`);
    expect(rows[0]).toMatchObject({ feb28: '2027-02-28', feb29: '2028-02-29', mar31: '2028-03-31', leap_year: '2029-02-28' });
    expect(rows[0].utc_wall.toISOString()).toBe('2028-02-29T05:30:00.000Z');
  });
});
