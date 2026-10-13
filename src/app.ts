import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { Pool, type PoolClient } from 'pg';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import argon2 from 'argon2';
import { z, ZodError } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, desc } from 'drizzle-orm';
import { stores, audit } from './schema.js';
import { recordProviderStatus, retryRejected } from './sms.js';
import { PLANS, SMS_BILLING_POLICY, checkoutReady, subscriptionStatus, initiate, paymeRpc } from './subscription.js';

const uuid = z.uuid();
const positive = z.number().int().positive().max(1_000_000_000);
const credentials = z.object({ email: z.email().max(254).transform(v => v.toLowerCase()), password: z.string().min(12).max(200) }).strict();
const customerBody = z.object({ name: z.string().trim().min(1).max(120), phone: z.string().max(40), consentEvidence: z.string().trim().min(8).max(300) }).strict();
const debtBody = z.object({ customerId: uuid, items: z.array(z.object({ title: z.string().trim().min(1).max(120), quantity: z.number().int().positive().max(10000), unitPrice: positive }).strict()).min(1).max(50), description: z.string().max(500).optional(), dueDate: z.iso.date().optional() }).strict();
const paymentBody = z.object({ customerId: uuid, allocations: z.array(z.object({ debtId: uuid, amount: positive }).strict()).min(1).max(50) }).strict();
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ data });
class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message); };
const normalizePhone = (raw: string) => { const digits = raw.replace(/[\s()+-]/g, ''); const phone = digits.length === 9 ? `998${digits}` : digits; if (!/^998\d{9}$/.test(phone)) fail(400, 'INVALID_PHONE', 'Use an Uzbekistan mobile number'); return phone; };
const storeActive = (row: { trial_ends_at: Date; paid_until: Date | null }) => row.trial_ends_at > new Date() || (row.paid_until !== null && row.paid_until > new Date());
const auditEvent = async (client: PoolClient, storeId: string, actorId: string, action: string, entityId: string, details: object = {}) => { await client.query('INSERT INTO audit (store_id,actor_id,action,entity_id,details) VALUES ($1,$2,$3,$4,$5)', [storeId, actorId, action, entityId, JSON.stringify(details)]); };
async function transaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> { const c = await pool.connect(); try { await c.query('BEGIN'); const v = await fn(c); await c.query('COMMIT'); return v; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } }

type Principal = { id: string; storeId: string; role: 'admin' | 'employee'; csrfHash: string; sessionId: string };
declare global { namespace Express { interface Request { principal?: Principal } } }
const current = (req: Request) => { if (!req.principal) fail(401, 'UNAUTHENTICATED', 'Sign in required'); return req.principal!; };
const admin = (req: Request) => { const p = current(req); if (p.role !== 'admin') fail(403, 'FORBIDDEN', 'Admin only'); return p; };
const csrf = (req: Request) => { const p = current(req); const token = req.get('X-CSRF-Token') ?? ''; if (!safeEqual(sha(token), p.csrfHash)) fail(403, 'CSRF', 'CSRF token required'); return p; };

export function createApp(pool: Pool) {
  const app = express(); app.disable('x-powered-by'); app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
  const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
  const publicOrigin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, '');
  const indexed = Boolean(publicOrigin && /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(publicOrigin) && !publicOrigin.includes('localhost'));
  const landing = readFileSync(join(publicDir, 'index.html'), 'utf8');
  app.use('/assets', express.static(join(publicDir, 'assets'), { maxAge: '1h', index: false }));
  app.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(
      landing.replace('<!-- CANONICAL -->', indexed ? `<link rel="canonical" href="${publicOrigin}/">` : '<meta name="robots" content="noindex,nofollow">')
    );
  });
  app.get('/app', (_req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(join(publicDir, 'app.html')); });
  app.get('/robots.txt', (_req, res) => { res.type('text/plain').send(indexed ? `User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /api/\nSitemap: ${publicOrigin}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n'); });
  app.get('/sitemap.xml', (_req, res) => { if (!indexed) return res.sendStatus(404); res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${publicOrigin}/</loc></url></urlset>`); });
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(express.json({ limit: '32kb' }), cookieParser());
  const db = drizzle(pool);
  const limited = (_req: Request, res: Response) => res.status(429).json({ error: { code: 'RATE_LIMIT', message: 'Too many requests' } });
  const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, handler: limited });
  const mutationLimit = rateLimit({ windowMs: 60_000, limit: 100, standardHeaders: 'draft-8', legacyHeaders: false, handler: limited });
  app.get('/health', async (_req, res) => { await pool.query('SELECT 1'); ok(res, { status: 'ok' }); });
  app.post('/api/provider/payme', mutationLimit, (req, res) => paymeRpc(pool, req, res));
  // Register this high-entropy URL with the provider only after owner approval.
  // Proxy must redact URL paths from access logs and allowlist provider source IPs.
  app.post('/api/provider/playmobile/:secret', mutationLimit, async (req, res) => {
    const expected = process.env.SMS_CALLBACK_SECRET;
    if (!expected || expected.length < 32 || typeof req.params.secret !== 'string' || !safeEqual(req.params.secret, expected)) fail(404, 'NOT_FOUND', 'Not found');
    await recordProviderStatus(pool, req.body); ok(res, { received: true });
  });
  app.use('/api', async (req, _res, next) => { try {
    const token = req.cookies?.qd_session;
    if (typeof token === 'string' && /^[0-9a-f]{64}$/.test(token)) {
      const { rows } = await pool.query('SELECT s.id AS session_id,s.csrf_hash,u.id,u.store_id,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()', [sha(token)]);
      const user = rows[0]; if (user) req.principal = { id: user.id, storeId: user.store_id, role: user.role, csrfHash: user.csrf_hash, sessionId: user.session_id };
    }
    next();
  } catch (e) { next(e); } });
  app.use('/api', mutationLimit);
  const session = async (client: PoolClient, userId: string) => { const token = secret(), csrfToken = secret(); await client.query("INSERT INTO sessions (user_id,token_hash,csrf_hash,expires_at) VALUES ($1,$2,$3,now()+interval '7 days')", [userId, sha(token), sha(csrfToken)]); return { token, csrfToken }; };
  const setSession = (res: Response, token: string) => res.cookie('qd_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: 7 * 86400_000 });

  app.post('/api/auth/register', authLimit, async (req, res) => {
    const input = credentials.extend({ storeName: z.string().trim().min(2).max(120) }).parse(req.body);
    const hash = await argon2.hash(input.password, { type: argon2.argon2id });
    try { const result = await transaction(pool, async c => {
      const store = (await c.query("INSERT INTO stores (name,trial_ends_at) VALUES ($1,((now() AT TIME ZONE 'Asia/Tashkent') + interval '14 days') AT TIME ZONE 'Asia/Tashkent') RETURNING *", [input.storeName])).rows[0];
      const user = (await c.query("INSERT INTO users (store_id,email,password_hash,role) VALUES ($1,$2,$3,'admin') RETURNING id,email,role", [store.id, input.email, hash])).rows[0];
      const s = await session(c, user.id); await auditEvent(c, store.id, user.id, 'store.created', store.id);
      await c.query("INSERT INTO subscription_events (store_id,kind,details) VALUES ($1,'trial_started',$2)", [store.id, JSON.stringify({ startedAt: store.trial_started_at, endsAt: store.trial_ends_at })]);
      return { store, user, ...s };
    }); setSession(res, result.token); ok(res, { store: result.store, user: result.user, csrf: result.csrfToken }, 201);
    } catch (e: any) { if (e.code === '23505') fail(409, 'EMAIL_EXISTS', 'Email already registered'); throw e; }
  });
  app.post('/api/auth/login', authLimit, async (req, res) => {
    const input = credentials.parse(req.body);
    const { rows } = await pool.query('SELECT id,store_id,email,role,password_hash FROM users WHERE email=$1', [input.email]);
    const u = rows[0]; if (!u || !await argon2.verify(u.password_hash, input.password)) fail(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    const s = await transaction(pool, c => session(c, u.id)); setSession(res, s.token);
    ok(res, { user: { id: u.id, storeId: u.store_id, email: u.email, role: u.role }, csrf: s.csrfToken });
  });
  app.get('/api/auth/me', async (req, res) => { const p = current(req); const store = await db.select().from(stores).where(eq(stores.id, p.storeId)); ok(res, { user: { id: p.id, storeId: p.storeId, role: p.role }, store: store[0] }); });
  app.get('/api/auth/csrf', async (req, res) => { const p = current(req); const token = secret(); await pool.query('UPDATE sessions SET csrf_hash=$1 WHERE id=$2', [sha(token), p.sessionId]); res.set('Cache-Control', 'no-store'); ok(res, { csrf: token }); });
  app.post('/api/auth/logout', async (req, res) => { const p = csrf(req); await pool.query('DELETE FROM sessions WHERE id=$1', [p.sessionId]); res.clearCookie('qd_session', { path: '/', sameSite: 'strict', secure: process.env.NODE_ENV === 'production' }); ok(res, { loggedOut: true }); });
  app.post('/api/employees', async (req, res) => { const p = admin(req); csrf(req); const input = credentials.parse(req.body); const hash = await argon2.hash(input.password, { type: argon2.argon2id }); try { const row = await transaction(pool, async c => { const u = (await c.query("INSERT INTO users (store_id,email,password_hash,role) VALUES ($1,$2,$3,'employee') RETURNING id,email,role", [p.storeId, input.email, hash])).rows[0]; await auditEvent(c, p.storeId, p.id, 'employee.created', u.id); return u; }); ok(res, row, 201); } catch (e: any) { if (e.code === '23505') fail(409, 'EMAIL_EXISTS', 'Email already registered'); throw e; } });
  app.get('/api/subscription/plans', (_req, res) => ok(res, { plans: PLANS, trialDays: 14, smsBillingPolicy: SMS_BILLING_POLICY, checkoutAvailable: checkoutReady() }));
  // Dedicated server-to-server platform credential, never a store-admin session or browser token.
  app.get('/api/platform/subscriptions/summary', async (req, res) => {
    const token = process.env.PLATFORM_REPORT_TOKEN;
    if (!token || token.length < 32 || !safeEqual(req.get('Authorization') ?? '', `Bearer ${token}`)) fail(403, 'FORBIDDEN', 'Platform authorization required');
    const { rows } = await pool.query(`SELECT
      (SELECT COUNT(*)::int FROM stores) AS total_stores,
      (SELECT COUNT(*)::int FROM stores WHERE paid_until>now() AND cancelled_at IS NULL) AS active,
      (SELECT COUNT(*)::int FROM stores WHERE paid_until<=now() OR paid_until IS NULL AND trial_ends_at<=now()) AS expired,
      (SELECT COUNT(*)::int FROM stores WHERE (paid_until IS NULL OR paid_until<=now()) AND trial_ends_at>now() AND cancelled_at IS NULL) AS trial,
      (SELECT COUNT(*)::int FROM stores WHERE cancelled_at IS NOT NULL AND GREATEST(trial_ends_at,COALESCE(paid_until,trial_ends_at))>now()) AS cancelled,
      (SELECT COALESCE(SUM(amount_uzs),0)::bigint FROM subscription_attempts WHERE status='paid' AND (performed_at AT TIME ZONE 'Asia/Tashkent')::date >= date_trunc('month',now() AT TIME ZONE 'Asia/Tashkent')::date) AS monthly_paid_uzs,
      (SELECT COUNT(*)::int FROM subscription_attempts WHERE status IN ('failed','cancelled')) AS failed_payments,
      (SELECT COUNT(*)::int FROM stores WHERE GREATEST(trial_ends_at,COALESCE(paid_until,trial_ends_at)) BETWEEN now() AND now()+interval '3 days') AS upcoming_expiries`);
    const { rows: byPlan } = await pool.query("SELECT plan_months,COUNT(*)::int AS sales,COALESCE(SUM(amount_uzs),0)::bigint AS amount_uzs FROM subscription_attempts WHERE status='paid' GROUP BY plan_months ORDER BY plan_months");
    ok(res, { ...rows[0], monthly_paid_uzs: Number(rows[0].monthly_paid_uzs), byPlan: byPlan.map(r => ({ ...r, amount_uzs: Number(r.amount_uzs) })) });
  });
  app.get('/api/subscription', async (req, res) => { const p = current(req); ok(res, await subscriptionStatus(pool, p.storeId)); });
  app.get('/api/subscription/history', async (req, res) => { const p = admin(req); const [attempts, events] = await Promise.all([
    pool.query('SELECT id,plan_months,amount_uzs,status,provider,provider_transaction_id,period_start,period_end,created_at,performed_at FROM subscription_attempts WHERE store_id=$1 ORDER BY created_at DESC LIMIT 100', [p.storeId]),
    pool.query('SELECT attempt_id,kind,details,created_at FROM subscription_events WHERE store_id=$1 ORDER BY created_at DESC LIMIT 100', [p.storeId]),
  ]); ok(res, { attempts: attempts.rows, events: events.rows }); });
  app.post('/api/subscription/initiate', async (req, res) => { const p = admin(req); csrf(req);
    const { months } = z.object({ months: z.union([z.literal(1), z.literal(2)]) }).strict().parse(req.body);
    const key = z.uuid().parse(req.get('Idempotency-Key'));
    if (!checkoutReady()) fail(503, 'CHECKOUT_DISABLED', 'Payment integration not approved/configured');
    const result = await initiate(pool, p.storeId, p.id, months, key);
    if ('conflict' in result) fail(409, 'IDEMPOTENCY_CONFLICT', 'Key used for another plan');
    ok(res, result, 201);
  });
  app.post('/api/subscription/cancel', async (req, res) => { const p = admin(req); csrf(req);
    const result = await transaction(pool, async c => { const s = (await c.query('SELECT * FROM stores WHERE id=$1 FOR UPDATE', [p.storeId])).rows[0];
      const now = (await c.query('SELECT now() AS now')).rows[0].now as Date;
      if (!(s.trial_ends_at > now || s.paid_until > now)) fail(409, 'ALREADY_EXPIRED', 'Subscription already expired');
      if (!s.cancelled_at) { await c.query('UPDATE stores SET cancelled_at=now() WHERE id=$1', [p.storeId]); await c.query("INSERT INTO subscription_events (store_id,kind,details) VALUES ($1,'access_cancelled',$2)", [p.storeId, JSON.stringify({ actorId: p.id })]); await auditEvent(c, p.storeId, p.id, 'subscription.cancelled', p.storeId); }
      return { cancelled: true, accessUntil: s.paid_until && s.paid_until > now ? s.paid_until : s.trial_ends_at };
    }); ok(res, result);
  });
  app.get('/api/stores/settings', async (req, res) => { const p = current(req); const row = await db.select().from(stores).where(eq(stores.id, p.storeId)); ok(res, row[0]); });
  app.patch('/api/stores/settings', async (req, res) => { const p = admin(req); csrf(req); const input = z.object({ smsEnabled: z.boolean().optional(), smsHour: z.number().int().min(0).max(23).optional(), smsMinute: z.number().int().min(0).max(59).optional(), dailyCap: z.number().int().min(0).max(10000).optional(), smsCostCap: z.number().int().min(0).max(1_000_000_000).optional(), smsUnitCost: z.number().int().min(0).max(10000).optional(), sender: z.string().regex(/^[A-Za-z0-9]{1,11}$/).nullable().optional() }).strict().parse(req.body);
    if (!Object.keys(input).length) fail(400, 'INVALID_INPUT', 'Empty settings');
    const set = Object.entries(input).map(([k], i) => `${({smsEnabled:'sms_enabled',smsHour:'sms_hour',smsMinute:'sms_minute',dailyCap:'daily_cap',smsCostCap:'sms_cost_cap',smsUnitCost:'sms_unit_cost',sender:'sender'} as Record<string,string>)[k]}=$${i+2}`).join(',');
    const row = await transaction(pool, async c => { const s = (await c.query(`UPDATE stores SET ${set} WHERE id=$1 RETURNING *`, [p.storeId, ...Object.values(input)])).rows[0]; await auditEvent(c, p.storeId, p.id, 'settings.updated', p.storeId, { fields: Object.keys(input) }); return s; }); ok(res, row);
  });
  app.post('/api/customers', async (req, res) => { const p = csrf(req), input = customerBody.parse(req.body), phone = normalizePhone(input.phone);
    const row = await transaction(pool, async c => { await c.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [p.storeId]); const dup = await c.query('SELECT id FROM customers WHERE store_id=$1 AND phone=$2 AND archived_at IS NULL', [p.storeId, phone]); if (dup.rowCount) fail(409, 'DUPLICATE_PHONE', 'Customer phone already exists in this store'); const r = (await c.query('INSERT INTO customers (store_id,name,phone,consent_at,consent_evidence) VALUES ($1,$2,$3,now(),$4) RETURNING *', [p.storeId, input.name, phone, input.consentEvidence])).rows[0]; await auditEvent(c, p.storeId, p.id, 'customer.created', r.id); return r; }); ok(res, row, 201);
  });
  app.get('/api/customers', async (req, res) => { const p = current(req), search = z.string().max(120).parse(req.query.search ?? ''); const q = `%${search.replace(/[\\%_]/g, '\\$&')}%`; const { rows } = await pool.query("SELECT id,name,phone,consent_at,opted_out_at,archived_at,created_at FROM customers WHERE store_id=$1 AND (name ILIKE $2 ESCAPE '\\' OR phone LIKE $2 ESCAPE '\\') ORDER BY created_at DESC LIMIT 100", [p.storeId, q]); ok(res, rows); });
  app.patch('/api/customers/:id', async (req, res) => { const p = csrf(req); const id = uuid.parse(req.params.id); const body = z.object({ optedOut: z.boolean().optional(), archived: z.boolean().optional() }).strict().parse(req.body); if (!Object.keys(body).length) fail(400, 'INVALID_INPUT', 'Empty update'); const row = await transaction(pool, async c => { await c.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [p.storeId]); const r = (await c.query("UPDATE customers SET opted_out_at=CASE WHEN $3::boolean IS NULL THEN opted_out_at WHEN $3 THEN now() ELSE NULL END, archived_at=CASE WHEN $4::boolean IS NULL THEN archived_at WHEN $4 THEN now() ELSE NULL END WHERE store_id=$1 AND id=$2 RETURNING *", [p.storeId, id, body.optedOut ?? null, body.archived ?? null])).rows[0]; if (!r) fail(404, 'NOT_FOUND', 'Customer not found'); await auditEvent(c, p.storeId, p.id, 'customer.updated', id, body); return r; }); ok(res, row); });
  app.post('/api/debts', async (req, res) => { const p = csrf(req), input = debtBody.parse(req.body);
    const items = input.items.map(i => ({ ...i, lineTotal: i.quantity * i.unitPrice })); const total = items.reduce((sum, i) => sum + i.lineTotal, 0);
    if (!Number.isSafeInteger(total) || total > 1_000_000_000) fail(400, 'INVALID_AMOUNT', 'Total exceeds permitted integer range');
    const row = await transaction(pool, async c => { const store = (await c.query('SELECT trial_ends_at,paid_until FROM stores WHERE id=$1 FOR UPDATE', [p.storeId])).rows[0]; if (!storeActive(store)) fail(402, 'SUBSCRIPTION_EXPIRED', 'Trial or subscription expired');
      const customer = (await c.query('SELECT id FROM customers WHERE store_id=$1 AND id=$2 AND archived_at IS NULL', [p.storeId, input.customerId])).rows[0]; if (!customer) fail(404, 'NOT_FOUND', 'Customer not found');
      const d = (await c.query('INSERT INTO debts (store_id,customer_id,total,description,due_date,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [p.storeId, input.customerId, total, input.description ?? null, input.dueDate ?? null, p.id])).rows[0];
      for (const i of items) await c.query('INSERT INTO debt_items (debt_id,title,quantity,unit_price,line_total) VALUES ($1,$2,$3,$4,$5)', [d.id, i.title, i.quantity, i.unitPrice, i.lineTotal]);
      await auditEvent(c, p.storeId, p.id, 'debt.created', d.id, { total }); return { ...d, balance: total, items }; }); ok(res, row, 201);
  });
  const debtQuery = `SELECT d.*, d.total-COALESCE((SELECT SUM(a.amount)::int FROM allocations a JOIN payments p ON p.id=a.payment_id WHERE a.debt_id=d.id AND p.reversed_at IS NULL),0) AS balance FROM debts d WHERE d.store_id=$1`;
  app.get('/api/debts', async (req, res) => { const p = current(req); const customerId = req.query.customerId ? uuid.parse(req.query.customerId) : null; const { rows } = await pool.query(`${debtQuery} AND ($2::uuid IS NULL OR d.customer_id=$2) ORDER BY d.created_at DESC LIMIT 100`, [p.storeId, customerId]); ok(res, rows); });
  app.get('/api/debts/:id', async (req, res) => { const p = current(req), id = uuid.parse(req.params.id); const { rows } = await pool.query(`${debtQuery} AND d.id=$2`, [p.storeId, id]); if (!rows[0]) fail(404, 'NOT_FOUND', 'Debt not found'); const items = (await pool.query('SELECT title,quantity,unit_price,line_total FROM debt_items WHERE debt_id=$1', [id])).rows; ok(res, { ...rows[0], items }); });
  app.post('/api/payments', async (req, res) => { const p = csrf(req), input = paymentBody.parse(req.body); const key = z.uuid().parse(req.get('Idempotency-Key')); const ids = input.allocations.map(a => a.debtId); if (new Set(ids).size !== ids.length) fail(400, 'DUPLICATE_ALLOCATION', 'Debt repeated');
    const amount = input.allocations.reduce((sum, a) => sum + a.amount, 0); if (!Number.isSafeInteger(amount) || amount > 1_000_000_000) fail(400, 'INVALID_AMOUNT', 'Payment exceeds permitted integer range');
    const requestHash = sha(JSON.stringify({ customerId: input.customerId, allocations: [...input.allocations].sort((a,b) => a.debtId.localeCompare(b.debtId)) }));
    const result = await transaction(pool, async c => { await c.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [p.storeId]); const existing = (await c.query('SELECT * FROM payments WHERE store_id=$1 AND idempotency_key=$2', [p.storeId, key])).rows[0]; if (existing) { if (existing.request_hash !== requestHash) fail(409, 'IDEMPOTENCY_CONFLICT', 'Key used for a different request'); return { row: existing, replay: true }; }
      const customer = (await c.query('SELECT id FROM customers WHERE store_id=$1 AND id=$2', [p.storeId, input.customerId])).rows[0]; if (!customer) fail(404, 'NOT_FOUND', 'Customer not found');
      for (const a of [...input.allocations].sort((x,y) => x.debtId.localeCompare(y.debtId))) { const d = (await c.query('SELECT id,total FROM debts WHERE store_id=$1 AND customer_id=$2 AND id=$3 FOR UPDATE', [p.storeId, input.customerId, a.debtId])).rows[0]; if (!d) fail(404, 'NOT_FOUND', 'Debt not found'); const paid = (await c.query('SELECT COALESCE(SUM(a.amount),0)::int AS paid FROM allocations a JOIN payments p ON p.id=a.payment_id WHERE a.debt_id=$1 AND p.reversed_at IS NULL', [a.debtId])).rows[0].paid; if (a.amount > d.total - paid) fail(409, 'OVERPAYMENT', 'Payment exceeds remaining balance'); }
      const row = (await c.query('INSERT INTO payments (store_id,customer_id,amount,idempotency_key,request_hash,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [p.storeId, input.customerId, amount, key, requestHash, p.id])).rows[0];
      for (const a of input.allocations) await c.query('INSERT INTO allocations (payment_id,debt_id,amount) VALUES ($1,$2,$3)', [row.id, a.debtId, a.amount]); await auditEvent(c, p.storeId, p.id, 'payment.created', row.id, { amount }); return { row, replay: false };
    }); ok(res, result.row, result.replay ? 200 : 201);
  });
  app.post('/api/payments/:id/reverse', async (req, res) => { const p = admin(req); csrf(req); const id = uuid.parse(req.params.id), { reason } = z.object({ reason: z.string().trim().min(4).max(300) }).strict().parse(req.body);
    const row = await transaction(pool, async c => { await c.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [p.storeId]); const r = (await c.query('SELECT * FROM payments WHERE id=$1 AND store_id=$2 FOR UPDATE', [id, p.storeId])).rows[0]; if (!r) fail(404, 'NOT_FOUND', 'Payment not found'); if (r.reversed_at) fail(409, 'ALREADY_REVERSED', 'Payment already reversed'); const updated = (await c.query('UPDATE payments SET reversed_at=now(),reversed_by=$2,reversal_reason=$3 WHERE id=$1 RETURNING *', [id, p.id, reason])).rows[0]; await auditEvent(c, p.storeId, p.id, 'payment.reversed', id, { reason }); return updated; }); ok(res, row);
  });
  app.get('/api/payments', async (req, res) => { const p = current(req); const { rows } = await pool.query('SELECT id,customer_id,amount,created_at,reversed_at,reversal_reason FROM payments WHERE store_id=$1 ORDER BY created_at DESC LIMIT 100', [p.storeId]); ok(res, rows); });
  app.get('/api/audit', async (req, res) => { const p = admin(req); const rows = await db.select().from(audit).where(eq(audit.storeId, p.storeId)).orderBy(desc(audit.createdAt)).limit(100); ok(res, rows); });
  app.get('/api/reports/summary', async (req, res) => { const p = current(req); const days = z.enum(['7','30','365']).parse(req.query.days ?? '30'); const { rows } = await pool.query(`SELECT (SELECT COALESCE(SUM(d.total),0)::bigint FROM debts d WHERE d.store_id=$1) AS total_debt, (SELECT COALESCE(SUM(p.amount),0)::bigint FROM payments p WHERE p.store_id=$1 AND p.reversed_at IS NULL) AS total_paid, (SELECT COALESCE(SUM(d.total),0)::bigint FROM debts d WHERE d.store_id=$1 AND d.created_at >= now()-($2::int * interval '1 day')) AS period_debt, (SELECT COALESCE(SUM(p.amount),0)::bigint FROM payments p WHERE p.store_id=$1 AND p.reversed_at IS NULL AND p.created_at >= now()-($2::int * interval '1 day')) AS period_paid`, [p.storeId, days]); const r = rows[0]; ok(res, Object.fromEntries(Object.entries(r).map(([k,v]) => [k, Number(v)]))); });
  const exportQueries = {
    customers: 'SELECT id,name,phone,consent_at,opted_out_at,archived_at,created_at FROM customers WHERE store_id=$1 ORDER BY created_at',
    debts: `${debtQuery} ORDER BY d.created_at`,
    payments: 'SELECT id,customer_id,amount,created_at,reversed_at,reversal_reason FROM payments WHERE store_id=$1 ORDER BY created_at',
    allocations: 'SELECT a.payment_id,a.debt_id,a.amount FROM allocations a JOIN payments p ON p.id=a.payment_id WHERE p.store_id=$1',
  };
  const csvCell = (value: unknown) => {
    let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
    // Spreadsheet programs evaluate formulas even when the CSV cell is quoted.
    if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  app.get('/api/export.csv', async (req, res) => {
    const p = admin(req);
    const table = z.enum(['customers', 'debts', 'payments', 'allocations']).parse(req.query.table);
    // Explicit cap until cursor-based streaming is implemented; never silently truncate.
    const query = exportQueries[table].replace(/ORDER BY .+$/, '') + ' LIMIT 10001';
    const result = await pool.query(query, [p.storeId]);
    if (result.rows.length > 10000) fail(413, 'EXPORT_TOO_LARGE', 'CSV export exceeds 10000 rows; contact the operator for a larger export');
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', `attachment; filename="qarz-daftar-${table}.csv"`);
    res.type('text/csv; charset=utf-8').send('\uFEFF' + [result.fields.map(f => csvCell(f.name)).join(','), ...result.rows.map(row => result.fields.map(f => csvCell(row[f.name])).join(','))].join('\r\n') + '\r\n');
  });
  app.get('/api/export', async (req, res) => { const p = admin(req); const [cs, ds, ps, as] = await Promise.all([
    pool.query('SELECT id,name,phone,consent_at,opted_out_at,archived_at,created_at FROM customers WHERE store_id=$1 ORDER BY created_at', [p.storeId]),
    pool.query(`${debtQuery} ORDER BY d.created_at`, [p.storeId]),
    pool.query('SELECT id,customer_id,amount,created_at,reversed_at,reversal_reason FROM payments WHERE store_id=$1 ORDER BY created_at', [p.storeId]),
    pool.query('SELECT a.payment_id,a.debt_id,a.amount FROM allocations a JOIN payments p ON p.id=a.payment_id WHERE p.store_id=$1', [p.storeId]),
  ]); res.set('Cache-Control', 'no-store'); res.set('Content-Disposition', 'attachment; filename="qarz-daftar-export.json"'); ok(res, { exportedAt: new Date().toISOString(), customers: cs.rows, debts: ds.rows, payments: ps.rows, allocations: as.rows }); });
  app.get('/api/sms/outbox', async (req, res) => { const p = admin(req); const { rows } = await pool.query('SELECT id,debt_id,customer_id,local_date,status,attempts,provider_message_id,last_error,created_at,updated_at FROM sms_outbox WHERE store_id=$1 ORDER BY created_at DESC LIMIT 100', [p.storeId]); ok(res, rows); });
  app.post('/api/sms/outbox/:id/retry', async (req, res) => { const p = admin(req); csrf(req); const id = uuid.parse(req.params.id); if (!await retryRejected(pool, p.storeId, id)) fail(409, 'NOT_RETRYABLE', 'Only explicitly rejected sends can be retried'); ok(res, { queued: true }); });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => { if (err instanceof ZodError) { res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid request', issues: err.issues } }); return; } if (err instanceof ApiError) { res.status(err.status).json({ error: { code: err.code, message: err.message } }); return; } if ((err as any)?.type === 'entity.too.large') { res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request too large' } }); return; } if ((err as any)?.type === 'entity.parse.failed') { res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Malformed JSON' } }); return; } console.error('API error', err); res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } }); });
  return app;
}
