import { timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Request, Response } from 'express';
import { z } from 'zod';

// Prices have one runtime source; the SQL constraint mirrors these immutable offers.
export const PLANS = [{ months: 1, amountUzs: 60_000 }, { months: 2, amountUzs: 100_000 }] as const;
export const SMS_BILLING_POLICY = 'separate_unpriced' as const;
const tx = async <T>(pool: Pool, f: (c: PoolClient) => Promise<T>): Promise<T> => {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const result = await f(c); await c.query('COMMIT'); return result; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
};
const equal = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const clock = async (c: PoolClient) => (await c.query('SELECT now() AS now')).rows[0].now as Date;
export const checkoutReady = () => Boolean(process.env.PAYME_CALLBACK_ENABLED === '1' && process.env.PAYME_MERCHANT_ID && process.env.PAYME_KEY &&
  (process.env.PAYME_CHECKOUT_MODE === 'sandbox' && process.env.NODE_ENV !== 'production' ||
   process.env.PAYME_CHECKOUT_MODE === 'production' && process.env.NODE_ENV === 'production' && process.env.PAYME_PRODUCTION_APPROVED === '1'));
export async function subscriptionStatus(pool: Pool, storeId: string) {
  const { rows } = await pool.query(`SELECT id,trial_started_at,trial_ends_at,paid_until,cancelled_at,now() AS server_now,
    CASE WHEN paid_until>now() THEN CASE WHEN cancelled_at IS NULL THEN 'active' ELSE 'cancelled' END
         WHEN trial_ends_at>now() THEN CASE WHEN cancelled_at IS NULL THEN 'trial' ELSE 'cancelled' END ELSE 'expired' END AS state,
    CASE WHEN paid_until>now() THEN paid_until ELSE trial_ends_at END AS access_until,
    ((trial_ends_at AT TIME ZONE 'Asia/Tashkent')::date - (now() AT TIME ZONE 'Asia/Tashkent')::date) AS trial_calendar_days,
    (SELECT plan_months FROM subscription_attempts WHERE store_id=stores.id AND status='paid' ORDER BY performed_at DESC LIMIT 1) AS plan_months
    FROM stores WHERE id=$1`, [storeId]);
  const row = rows[0]; if (!row) return null;
  const daysRemaining = Math.max(0, Math.ceil((new Date(row.access_until).getTime() - new Date(row.server_now).getTime()) / 86_400_000));
  const trialDays = Number(row.trial_calendar_days);
  return { storeId: row.id, state: row.state, trialStartedAt: row.trial_started_at, trialEndsAt: row.trial_ends_at, paidUntil: row.paid_until, accessUntil: row.access_until, planMonths: row.plan_months, serverNow: row.server_now, daysRemaining, warning: row.state === 'trial' && (trialDays === 3 || trialDays === 1) ? `TRIAL_T_MINUS_${trialDays}` : null, checkoutAvailable: checkoutReady(), smsBillingPolicy: SMS_BILLING_POLICY };
}
export async function initiate(pool: Pool, storeId: string, actorId: string, months: 1 | 2, key: string) {
  const plan = PLANS.find(p => p.months === months)!;
  return tx(pool, async c => {
    await c.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [storeId]);
    let row = (await c.query('SELECT * FROM subscription_attempts WHERE store_id=$1 AND idempotency_key=$2', [storeId, key])).rows[0];
    if (row && row.plan_months !== months) return { conflict: true } as const;
    if (!row) {
      row = (await c.query(`INSERT INTO subscription_attempts (store_id,plan_months,amount_uzs,status,provider,idempotency_key,external_reference)
        VALUES ($1,$2,$3,'pending','payme',$4,gen_random_uuid()::text) RETURNING *`, [storeId, months, plan.amountUzs, key])).rows[0];
      await c.query(`INSERT INTO subscription_events(store_id,attempt_id,kind,details) VALUES ($1,$2,'initiated',$3)`, [storeId, row.id, JSON.stringify({ actorId, planMonths: months, amountUzs: plan.amountUzs })]);
    }
    return { attemptId: row.id, status: row.status, provider: row.provider, amountUzs: row.amount_uzs, planMonths: row.plan_months,
      checkoutUrl: `https://${process.env.PAYME_CHECKOUT_MODE === 'production' ? 'checkout.paycom.uz' : 'test.paycom.uz'}/${Buffer.from(`m=${process.env.PAYME_MERCHANT_ID};ac.order_id=${row.id};a=${row.amount_uzs * 100}`).toString('base64')}` } as const;
  });
}
const rpc = z.object({ method: z.enum(['CheckPerformTransaction','CreateTransaction','PerformTransaction','CancelTransaction','CheckTransaction','GetStatement']), params: z.record(z.string(), z.unknown()), id: z.union([z.string(), z.number().int()]) }).strict();
const payId = z.string().min(1).max(128);
const account = z.object({ order_id: z.uuid() }).strict();
class PaymeError extends Error { constructor(public code: number, public data?: string) { super('Payment cannot be processed'); } }
const error = (code: number, data?: string): never => { throw new PaymeError(code, data); };
const event = async (c: PoolClient, row: any, kind: string, providerId: string | null, details: object) => {
  await c.query('INSERT INTO subscription_events(store_id,attempt_id,kind,external_event_id,details) VALUES($1,$2,$3,$4,$5) ON CONFLICT (external_event_id) DO NOTHING', [row.store_id, row.id, kind, providerId ? `payme:${kind}:${providerId}` : null, JSON.stringify(details)]);
};
const record = (row: any) => ({ transaction: row.id, create_time: row.provider_created_at ? new Date(row.provider_created_at).getTime() : 0, perform_time: row.performed_at ? new Date(row.performed_at).getTime() : 0, cancel_time: row.cancelled_at ? new Date(row.cancelled_at).getTime() : 0, state: row.status === 'paid' ? 2 : row.status === 'created' ? 1 : row.performed_at ? -2 : -1, reason: row.cancel_reason });
export async function paymeRpc(pool: Pool, req: Request, res: Response) {
  const expected = process.env.PAYME_KEY;
  const auth = req.get('Authorization') ?? '';
  // The key is the provider's Merchant API Basic password; it is never returned to a browser.
  if (!checkoutReady()) { res.status(503).json({ error: { code: 'CHECKOUT_DISABLED', message: 'Provider integration disabled' } }); return; }
  if (!expected || !equal(auth, `Basic ${Buffer.from(`Paycom:${expected}`).toString('base64')}`)) { res.status(200).json({ error: { code: -32504, message: 'Unauthorized' }, id: null }); return; }
  let id: string | number | null = null;
  try {
    const request = rpc.parse(req.body); id = request.id;
    const p = request.params;
    const result = await tx(pool, async c => {
      if (request.method === 'GetStatement') {
        const { from, to } = z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).parse(p);
        if (to < from || to - from > 31 * 86_400_000) error(-32602);
        const { rows } = await c.query(`SELECT * FROM subscription_attempts WHERE provider='payme' AND provider_created_at >= to_timestamp($1::double precision/1000) AND provider_created_at <= to_timestamp($2::double precision/1000) AND provider_transaction_id IS NOT NULL ORDER BY provider_created_at LIMIT 1000`, [from, to]);
        return { transactions: rows.map(r => ({ id: r.provider_transaction_id, time: new Date(r.provider_created_at).getTime(), amount: r.amount_uzs * 100, account: { order_id: r.id }, ...record(r) })) };
      }
      if (request.method === 'CheckPerformTransaction' || request.method === 'CreateTransaction') {
        const orderId = account.parse(p.account).order_id;
        const amount = z.number().int().positive().parse(p.amount);
        const store = (await c.query('SELECT store_id FROM subscription_attempts WHERE id=$1', [orderId])).rows[0];
        if (!store) error(-31050, 'account.order_id');
        await c.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [store.store_id]);
        const row = (await c.query('SELECT * FROM subscription_attempts WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
        if (row.amount_uzs * 100 !== amount) error(-31001);
        if (request.method === 'CheckPerformTransaction') { if (row.status !== 'pending' && row.status !== 'created') error(-31008); return { allow: true }; }
        const providerId = payId.parse(p.id); const createdMs = z.number().int().positive().parse(p.time);
        if (row.provider_transaction_id && row.provider_transaction_id !== providerId) error(-31008);
        if (row.status === 'paid' && row.provider_transaction_id === providerId && new Date(row.provider_created_at).getTime() === createdMs) return { create_time: createdMs, transaction: row.id, state: 2 };
        if (row.status === 'cancelled' || row.status === 'failed' || row.status === 'paid') error(-31008);
        if (row.status === 'created' && new Date(row.provider_created_at).getTime() !== createdMs) error(-31008);
        if (row.status === 'pending') {
          await c.query("UPDATE subscription_attempts SET status='created',provider_transaction_id=$2,provider_created_at=to_timestamp($3::double precision/1000) WHERE id=$1", [row.id, providerId, createdMs]);
          await event(c, row, 'created', providerId, { amountUzs: row.amount_uzs });
        }
        return { create_time: createdMs, transaction: row.id, state: 1 };
      }
      const providerId = payId.parse(p.id);
      const lookup = (await c.query('SELECT store_id FROM subscription_attempts WHERE provider_transaction_id=$1', [providerId])).rows[0];
      if (!lookup) error(-31003);
      await c.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [lookup.store_id]);
      const row = (await c.query('SELECT * FROM subscription_attempts WHERE provider_transaction_id=$1 FOR UPDATE', [providerId])).rows[0];
      if (request.method === 'CheckTransaction') return record(row);
      if (request.method === 'CancelTransaction') {
        const reason = z.number().int().min(1).max(100).parse(p.reason);
        if (row.status === 'paid') error(-31007); // Service already granted. Refunds need operator review.
        if (row.status === 'created') {
          const now = await clock(c);
          await c.query("UPDATE subscription_attempts SET status='cancelled',cancelled_at=$2,cancel_reason=$3 WHERE id=$1", [row.id, now, reason]);
          await event(c, row, 'cancelled', providerId, { reason });
          return { transaction: row.id, cancel_time: now.getTime(), state: -1 };
        }
        if (row.status !== 'cancelled') error(-31008);
        return { transaction: row.id, cancel_time: new Date(row.cancelled_at).getTime(), state: -1 };
      }
      if (row.status === 'paid') return { transaction: row.id, perform_time: new Date(row.performed_at).getTime(), state: 2 };
      if (row.status !== 'created') error(-31008);
      const now = await clock(c);
      // Add whole calendar months in Asia/Tashkent. Postgres clamps Jan 31 to Feb 28/29.
      // Anchor to the current entitlement end, or to provider-confirmed server time.
      const { rows } = await c.query(`SELECT GREATEST($1::timestamptz,now(),trial_ends_at,COALESCE(paid_until,'-infinity'::timestamptz)) AS starts FROM stores WHERE id=$2`, [now, row.store_id]);
      const start = rows[0].starts as Date;
      const end = (await c.query(`SELECT (($1::timestamptz AT TIME ZONE 'Asia/Tashkent') + make_interval(months => $2::int)) AT TIME ZONE 'Asia/Tashkent' AS ends`, [start, row.plan_months])).rows[0].ends as Date;
      await c.query('UPDATE stores SET paid_until=$2,cancelled_at=NULL WHERE id=$1', [row.store_id, end]);
      await c.query("UPDATE subscription_attempts SET status='paid',performed_at=$2,period_start=$3,period_end=$4 WHERE id=$1", [row.id, now, start, end]);
      await event(c, row, 'paid', providerId, { start: start.toISOString(), end: end.toISOString(), amountUzs: row.amount_uzs });
      const auditActor = (await c.query("SELECT id FROM users WHERE store_id=$1 AND role='admin' ORDER BY created_at LIMIT 1", [row.store_id])).rows[0]?.id;
      await c.query("INSERT INTO audit(store_id,actor_id,action,entity_id,details) VALUES($1,$2,'subscription.activated',$3,$4)", [row.store_id, auditActor ?? null, row.id, JSON.stringify({ start, end, amountUzs: row.amount_uzs })]);
      return { transaction: row.id, perform_time: now.getTime(), state: 2 };
    });
    res.status(200).json({ result, id });
  } catch (e) {
    if (!(e instanceof PaymeError) && !(e instanceof z.ZodError)) console.error('Payme callback failed', e);
    const code = e instanceof PaymeError ? e.code : e instanceof z.ZodError ? -32602 : -32400;
    res.status(200).json({ error: { code, message: { uz: 'To‘lovni amalga oshirib bo‘lmadi', ru: 'Не удалось выполнить операцию', en: 'Payment could not be processed' }, ...(e instanceof PaymeError && e.data ? { data: e.data } : {}) }, id });
  }
}
