import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { enqueueDue, dispatchOne, retryRejected, recordProviderStatus, type SmsAdapter } from '../src/sms.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL }); const app = createApp(pool);
afterAll(() => pool.end());
const now = new Date(Date.now() + 3 * 60_000);
const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(p => [p.type, p.value]));
const day = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
async function setup() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const reg = await request(app).post('/api/auth/register').send({ storeName: `Fixture ${suffix}`, email: `sms-${suffix}@example.test`, password: 'Synthetic strong passphrase 2026' });
  expect(reg.status).toBe(201);
  const headers = { Cookie: reg.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': reg.body.data.csrf };
  const cust = await request(app).post('/api/customers').set(headers).send({ name: 'Fixture Customer', phone: '901234567', consentEvidence: 'Synthetic paper consent document' });
  expect(cust.status).toBe(201);
  const debt = await request(app).post('/api/debts').set(headers).send({ customerId: cust.body.data.id, dueDate: day, items: [{ title: 'Fixture', quantity: 1, unitPrice: 1000 }] });
  expect(debt.status).toBe(201);
  const minute = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).split(':')[1]);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).split(':')[0]);
  const settings = await request(app).patch('/api/stores/settings').set(headers).send({ smsEnabled: true, sender: 'FixtureSMS', dailyCap: 2, smsCostCap: 200, smsUnitCost: 100, smsHour: hour, smsMinute: minute });
  expect(settings.status).toBe(200);
  return { headers, cust: cust.body.data, debt: debt.body.data, store: reg.body.data.store };
}
describe('persisted SMS outbox against PostgreSQL', () => {
  it('dedupes across runs, stops paid debt at dispatch and honors opt-out', async () => {
    const s = await setup(); expect(await enqueueDue(pool, now)).toBeGreaterThanOrEqual(1);
    expect(await enqueueDue(pool, now)).toBe(0);
    await request(app).post('/api/payments').set(s.headers).set('Idempotency-Key', crypto.randomUUID()).send({ customerId: s.cust.id, allocations: [{ debtId: s.debt.id, amount: 1000 }] });
    const adapter: SmsAdapter = { send: async () => { throw new Error('Must not send paid debt'); } };
    await dispatchOne(pool, adapter, now);
    const { rows } = await pool.query('SELECT status FROM sms_outbox WHERE debt_id=$1', [s.debt.id]); expect(rows[0].status).toBe('cancelled');
    const s2 = await setup(); await request(app).patch(`/api/customers/${s2.cust.id}`).set(s2.headers).send({ optedOut: true });
    await enqueueDue(pool, now); expect((await pool.query('SELECT count(*)::int AS count FROM sms_outbox WHERE debt_id=$1', [s2.debt.id])).rows[0].count).toBe(0);
  });
  it('records acceptance vs delivery; retry only explicit rejection, unknown never auto-retries', async () => {
    const s = await setup(); await enqueueDue(pool, now);

    const ids: string[] = []; const rejected: SmsAdapter = { send: async msg => { ids.push(msg.id); return 'rejected'; } };
    await dispatchOne(pool, rejected, now);
    let row = (await pool.query('SELECT * FROM sms_outbox WHERE debt_id=$1', [s.debt.id])).rows[0]; expect(row.status).toBe('failed'); expect(row.attempts).toBe(1);
    expect(await retryRejected(pool, s.store.id, row.id)).toBe(true);
    await pool.query('UPDATE sms_outbox SET next_attempt_at=$2 WHERE id=$1', [row.id, now]);
    await dispatchOne(pool, { send: async msg => { ids.push(msg.id); return 'accepted'; } }, now);
    row = (await pool.query('SELECT * FROM sms_outbox WHERE debt_id=$1', [s.debt.id])).rows[0]; expect(row.status).toBe('accepted'); expect(row.attempts).toBe(2); expect(ids[0]).not.toBe(ids[1]);
    await recordProviderStatus(pool, { messages: [{ 'message-id': ids[1], channel: 'sms', status: 'Delivered', 'status-date': now.toISOString() }] });
    expect((await pool.query('SELECT status FROM sms_outbox WHERE id=$1', [row.id])).rows[0].status).toBe('delivered');
    await recordProviderStatus(pool, { messages: [{ 'message-id': ids[1], channel: 'sms', status: 'Transmitted', 'status-date': now.toISOString() }] });
    expect((await pool.query('SELECT status FROM sms_outbox WHERE id=$1', [row.id])).rows[0].status).toBe('delivered');
    const s2 = await setup(); await enqueueDue(pool, now);
    await dispatchOne(pool, { send: async () => 'unknown' }, now);
    const pending = (await pool.query('SELECT * FROM sms_outbox WHERE debt_id=$1', [s2.debt.id])).rows[0]; expect(pending.status).toBe('unknown'); expect(await retryRejected(pool, s2.store.id, pending.id)).toBe(false);
  });
  it('does not resend interrupted processing, and stops when account expires at dispatch', async () => {
    const s = await setup(); await enqueueDue(pool, now);
    await pool.query("UPDATE sms_outbox SET status='processing',updated_at=now()-interval '3 minutes' WHERE debt_id=$1", [s.debt.id]);
    await pool.query("UPDATE sms_outbox SET status='unknown' WHERE debt_id=$1 AND status='processing' AND updated_at<now()-interval '2 minutes'", [s.debt.id]);
    expect(await enqueueDue(pool, now)).toBe(0);
    let sends = 0;
    await dispatchOne(pool, { send: async () => { sends++; return 'accepted'; } }, now);
    expect(sends).toBe(0);
    const s2 = await setup(); await enqueueDue(pool, now);
    await pool.query("UPDATE stores SET trial_started_at=now()-interval '15 days',trial_ends_at=now()-interval '1 day' WHERE id=$1", [s2.store.id]);
    await dispatchOne(pool, { send: async () => { sends++; return 'accepted'; } }, now);
    expect(sends).toBe(0);
    expect((await pool.query('SELECT status FROM sms_outbox WHERE debt_id=$1', [s2.debt.id])).rows[0].status).toBe('cancelled');
  });
  it('refuses a configured sender that differs from the operator-approved sender', async () => {
    const s = await setup(); await enqueueDue(pool, now);
    let sends = 0;
    await dispatchOne(pool, { send: async () => { sends++; return 'accepted'; } }, now, 'ApprovedID');
    expect(sends).toBe(0);
    expect((await pool.query('SELECT status FROM sms_outbox WHERE debt_id=$1', [s.debt.id])).rows[0].status).toBe('cancelled');
  });
});
