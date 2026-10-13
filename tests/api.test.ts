import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { Pool } from 'pg';
import { createApp } from '../src/app.js';
import { createHash } from 'node:crypto';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const app = createApp(pool);
const unique = crypto.randomUUID().slice(0, 8);
const auth = async (name: string) => {
  const res = await request(app).post('/api/auth/register').send({ storeName: `${name} synthetic`, email: `${name}-${unique}@example.test`, password: 'A sufficiently long fixture passphrase 2026' });
  expect(res.status).toBe(201);
  const cookie = res.headers['set-cookie'][0].split(';')[0];
  return { cookie, csrf: res.body.data.csrf, store: res.body.data.store };
};
const headers = (a: Awaited<ReturnType<typeof auth>>) => ({ Cookie: a.cookie, 'X-CSRF-Token': a.csrf });
const customer = async (a: Awaited<ReturnType<typeof auth>>, phone = '901234567') => {
  const res = await request(app).post('/api/customers').set(headers(a)).send({ name: 'Synthetic Customer', phone, consentEvidence: 'Synthetic signed paper consent for test' });
  expect(res.status).toBe(201); return res.body.data;
};
const debt = async (a: Awaited<ReturnType<typeof auth>>, customerId: string) => {
  const res = await request(app).post('/api/debts').set(headers(a)).send({ customerId, items: [{ title: 'Fixture item', quantity: 2, unitPrice: 15000 }] });
  expect(res.status).toBe(201); return res.body.data;
};
beforeAll(async () => { await pool.query('SELECT 1'); });
afterAll(async () => { await pool.end(); });

describe('real PostgreSQL API ledger', () => {
  it('serves crawlable public HTML, noindexes local/private routes and rotates CSRF on reload', async () => {
    const home = await request(app).get('/');
    expect(home.status).toBe(200); expect(home.text).toContain('Qarzlarni');
    expect(home.text).toContain('name="robots" content="noindex,nofollow"');
    expect((await request(app).get('/robots.txt')).text).toContain('Disallow: /');
    expect((await request(app).get('/sitemap.xml')).status).toBe(404);
    expect((await request(app).get('/app')).text).toContain('noindex,nofollow,noarchive');
    expect((await request(app).get('/assets/app.js')).status).toBe(200);
    expect((await request(app).get('/api/auth/csrf')).status).toBe(401);
    const a = await auth('reload');
    const refreshed = await request(app).get('/api/auth/csrf').set('Cookie', a.cookie);
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers['cache-control']).toBe('no-store');
    expect(refreshed.body.data.csrf).not.toBe(a.csrf);
    const input = { name: 'Fixture', phone: '901234569', consentEvidence: 'Fixture consent evidence' };
    expect((await request(app).post('/api/customers').set(headers(a)).send(input)).status).toBe(403);
    expect((await request(app).post('/api/customers').set({ Cookie: a.cookie, 'X-CSRF-Token': refreshed.body.data.csrf }).send(input)).status).toBe(201);
  });
  it('reports live database health and refuses unauthenticated data', async () => {
    const health = await request(app).get('/health');
    expect(health.status).toBe(200); expect(health.body).toEqual({ data: { status: 'ok' } });
    const privateResponse = await request(app).get('/api/debts');
    expect(privateResponse.status).toBe(401);
    expect(privateResponse.headers['cache-control']).toBe('no-store');
    expect(privateResponse.headers['x-content-type-options']).toBe('nosniff');
  });
  it('serves real loopback HTTP health and consistent error JSON', async () => {
    const server = app.listen(0, '127.0.0.1');
    try {
      await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Loopback port unavailable');
      const base = `http://127.0.0.1:${address.port}`;
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ data: { status: 'ok' } });
      const privateResponse = await fetch(`${base}/api/customers`);
      expect(privateResponse.status).toBe(401);
      expect((await privateResponse.json() as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
      const badJson = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
      expect(badJson.status).toBe(400);
      expect((await badJson.json() as { error: { code: string } }).error.code).toBe('INVALID_JSON');
    } finally { if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it('requires consent, normalizes phones, warns duplicate, rejects invalid inputs', async () => {
    const a = await auth('consent');
    expect((await request(app).post('/api/customers').set(headers(a)).send({ name: 'No consent', phone: '901234567' })).status).toBe(400);
    const c = await customer(a, '+998 90 123 45 67');
    expect(c.phone).toBe('998901234567');
    const dup = await request(app).post('/api/customers').set(headers(a)).send({ name: 'Again', phone: '901234567', consentEvidence: 'Fixture consent' });
    expect(dup.status).toBe(409); expect(dup.body.error.code).toBe('DUPLICATE_PHONE');
    expect((await request(app).post('/api/debts').set(headers(a)).send({ customerId: c.id, items: [{ title: 'X', quantity: 1, unitPrice: -1 }] })).status).toBe(400);
  });

  it('enforces tenant and csrf/role boundaries', async () => {
    const a = await auth('owner'); const b = await auth('other');
    const c = await customer(a); const d = await debt(a, c.id);
    expect((await request(app).get(`/api/debts/${d.id}`).set(headers(b))).status).toBe(404);
    expect((await request(app).post('/api/payments').set(headers(b)).set('Idempotency-Key', crypto.randomUUID()).send({ customerId: c.id, allocations: [{ debtId: d.id, amount: 1000 }] })).status).toBe(404);
    expect((await request(app).post('/api/customers').set('Cookie', a.cookie).send({ name: 'X', phone: '901234568', consentEvidence: 'yes' })).status).toBe(403);
    const invite = await request(app).post('/api/employees').set(headers(a)).send({ email: `emp-${unique}@example.test`, password: 'Employee fixture passphrase 2026' });
    expect(invite.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ email: `emp-${unique}@example.test`, password: 'Employee fixture passphrase 2026' });
    const e = { cookie: login.headers['set-cookie'][0].split(';')[0], csrf: login.body.data.csrf };
    expect((await request(app).patch('/api/stores/settings').set(headers(e as typeof a)).send({ smsEnabled: true })).status).toBe(403);
  });

  it('computes totals and atomic partial/full payment; rejects overpay, replays idem, reversal audited', async () => {
    const a = await auth('ledger'); const c = await customer(a); const d = await debt(a, c.id);
    expect(d.total).toBe(30000);
    const key = crypto.randomUUID();
    const body = { customerId: c.id, allocations: [{ debtId: d.id, amount: 12000 }] };
    const p = await request(app).post('/api/payments').set(headers(a)).set('Idempotency-Key', key).send(body);
    expect(p.status).toBe(201);
    expect((await request(app).post('/api/payments').set(headers(a)).set('Idempotency-Key', key).send(body)).body.data.id).toBe(p.body.data.id);
    expect((await request(app).post('/api/payments').set(headers(a)).set('Idempotency-Key', key).send({ ...body, allocations: [{ debtId: d.id, amount: 1 }] })).status).toBe(409);
    expect((await request(app).post('/api/payments').set(headers(a)).set('Idempotency-Key', crypto.randomUUID()).send({ customerId: c.id, allocations: [{ debtId: d.id, amount: 19000 }] })).status).toBe(409);
    const remaining = await request(app).get(`/api/debts/${d.id}`).set(headers(a)); expect(remaining.body.data.balance).toBe(18000);
    const pair = await Promise.all([1, 2].map(() => request(app).post('/api/payments').set(headers(a)).set('Idempotency-Key', crypto.randomUUID()).send({ customerId: c.id, allocations: [{ debtId: d.id, amount: 18000 }] })));
    expect(pair.map(x => x.status).sort()).toEqual([201, 409]);
    expect((await request(app).get(`/api/debts/${d.id}`).set(headers(a))).body.data.balance).toBe(0);
    const reverse = await request(app).post(`/api/payments/${p.body.data.id}/reverse`).set(headers(a)).send({ reason: 'Fixture correction' }); expect(reverse.status).toBe(200);
    expect((await request(app).get(`/api/debts/${d.id}`).set(headers(a))).body.data.balance).toBe(12000);
    expect((await request(app).post(`/api/payments/${p.body.data.id}/reverse`).set(headers(a)).send({ reason: 'Again' })).status).toBe(409);
    const log = await request(app).get('/api/audit').set(headers(a)); expect(log.body.data.some((r: any) => r.action === 'payment.reversed')).toBe(true);
  });

  it('allocates a payment across multiple debts without merging balances', async () => {
    const a = await auth('multi'); const c = await customer(a);
    const first = await request(app).post('/api/debts').set(headers(a)).send({ customerId: c.id, items: [{ title: 'First', quantity: 1, unitPrice: 150000 }] });
    const second = await request(app).post('/api/debts').set(headers(a)).send({ customerId: c.id, items: [{ title: 'Second', quantity: 1, unitPrice: 30000 }] });
    expect([first.status, second.status]).toEqual([201, 201]);
    const payment = await request(app).post('/api/payments').set(headers(a)).set('Idempotency-Key', crypto.randomUUID()).send({ customerId: c.id, allocations: [{ debtId: first.body.data.id, amount: 50000 }, { debtId: second.body.data.id, amount: 30000 }] });
    expect(payment.status).toBe(201); expect(payment.body.data.amount).toBe(80000);
    expect((await request(app).get(`/api/debts/${first.body.data.id}`).set(headers(a))).body.data.balance).toBe(100000);
    expect((await request(app).get(`/api/debts/${second.body.data.id}`).set(headers(a))).body.data.balance).toBe(0);
    const summary = await request(app).get('/api/reports/summary').set(headers(a));
    expect(summary.body.data.total_debt).toBe(180000); expect(summary.body.data.total_paid).toBe(80000);
    const exportData = await request(app).get('/api/export').set(headers(a));
    expect(exportData.body.data.allocations).toHaveLength(2);
  });

  it('trial expiry blocks new debts/SMS but permits repayments and reads', async () => {
    const a = await auth('expiry'); const c = await customer(a); const d = await debt(a, c.id);
    await pool.query("UPDATE stores SET trial_started_at=now()-interval '15 days',trial_ends_at=now()-interval '1 day' WHERE id=$1", [a.store.id]);
    expect((await request(app).post('/api/debts').set(headers(a)).send({ customerId: c.id, items: [{ title: 'new', quantity: 1, unitPrice: 1 }] })).status).toBe(402);
    expect((await request(app).get(`/api/debts/${d.id}`).set(headers(a))).status).toBe(200);
    expect((await request(app).post('/api/payments').set(headers(a)).set('Idempotency-Key', crypto.randomUUID()).send({ customerId: c.id, allocations: [{ debtId: d.id, amount: 100 }] })).status).toBe(201);
  });
  it('exports tenant-scoped spreadsheet-safe CSV, rejects employees and invalid table', async () => {
    const a = await auth('csv-owner'); const b = await auth('csv-other');
    const c = await request(app).post('/api/customers').set(headers(a)).send({ name: '=HYPERLINK("https://example.test","oops")', phone: '901234567', consentEvidence: 'Synthetic consent evidence' });
    expect(c.status).toBe(201);
    const d = await request(app).post('/api/debts').set(headers(a)).send({ customerId: c.body.data.id, items: [{ title: 'Fixture', quantity: 1, unitPrice: 150000 }] });
    expect(d.status).toBe(201);
    const payment = await request(app).post('/api/payments').set(headers(a)).set('Idempotency-Key', crypto.randomUUID()).send({ customerId: c.body.data.id, allocations: [{ debtId: d.body.data.id, amount: 50000 }] });
    expect(payment.status).toBe(201);
    const csv = await request(app).get('/api/export.csv?table=customers').set(headers(a));
    expect(csv.status).toBe(200);
    expect(csv.headers['cache-control']).toBe('no-store');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('"\'=HYPERLINK(""https://example.test"",""oops"")"');
    expect(csv.text).toContain(c.body.data.id);
    const otherCsv = await request(app).get('/api/export.csv?table=customers').set(headers(b));
    expect(otherCsv.status).toBe(200); expect(otherCsv.text).not.toContain(c.body.data.id);
    const debts = await request(app).get('/api/export.csv?table=debts').set(headers(a));
    expect(debts.status).toBe(200); expect(debts.text).toContain('"100000"');
    expect((await request(app).get('/api/export.csv?table=invalid').set(headers(a))).status).toBe(400);
    expect((await request(app).get('/api/export.csv?table=customers')).status).toBe(401);
    const invite = await request(app).post('/api/employees').set(headers(a)).send({ email: `csv-emp-${unique}@example.test`, password: 'Employee fixture passphrase 2026' });
    expect(invite.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ email: `csv-emp-${unique}@example.test`, password: 'Employee fixture passphrase 2026' });
    expect((await request(app).get('/api/export.csv?table=customers').set('Cookie', login.headers['set-cookie'][0].split(';')[0])).status).toBe(403);
  });
});
