import { Pool } from 'pg';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

export type SmsAdapter = { send(input: { id: string; phone: string; sender: string; text: string }): Promise<'accepted' | 'rejected' | 'unknown'> };
// Play Mobile: HTTP 200 means only "Request is received", not delivered.
export class PlayMobileAdapter implements SmsAdapter {
  constructor(private login: string, private password: string) {}
  async send(input: { id: string; phone: string; sender: string; text: string }): Promise<'accepted' | 'rejected' | 'unknown'> {
    try {
      const response = await fetch('https://send.smsxabar.uz/broker-api/send', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', Authorization: `Basic ${Buffer.from(`${this.login}:${this.password}`).toString('base64')}` }, body: JSON.stringify({ messages: [{ recipient: input.phone, 'message-id': input.id, sms: { originator: input.sender, content: { text: input.text } } }] }), signal: AbortSignal.timeout(10000) });
      // Only an explicit 400 validation rejection is safe to retry after correction. Other failures may have been accepted.
      if (response.status === 400) {
        const error = await response.json().catch(() => null) as { error_code?: string } | null;
        return ['202', '205', '401', '404'].includes(String(error?.error_code)) ? 'rejected' : 'unknown';
      }
      if (response.status === 200 && (await response.text()).trim() === 'Request is received') return 'accepted';
      return 'unknown';
    } catch { return 'unknown'; }
  }
}
const localParts = (now: Date) => { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now); const obj = Object.fromEntries(parts.map(p => [p.type, p.value])); return { day: `${obj.year}-${obj.month}-${obj.day}`, minute: Number(obj.hour) * 60 + Number(obj.minute) }; };
export async function enqueueDue(pool: Pool, now = new Date()) {
  const { day, minute } = localParts(now);
  const { rowCount } = await pool.query(`INSERT INTO sms_outbox (store_id,debt_id,customer_id,local_date)
    SELECT d.store_id,d.id,d.customer_id,$1::date FROM debts d
    JOIN customers c ON c.id=d.customer_id AND c.store_id=d.store_id
    JOIN stores s ON s.id=d.store_id
    WHERE s.sms_enabled AND s.sender IS NOT NULL AND s.daily_cap>0 AND s.sms_unit_cost>0 AND s.sms_cost_cap>=s.sms_unit_cost
      AND (s.trial_ends_at>$3 OR s.paid_until>$3)
      AND c.archived_at IS NULL AND c.opted_out_at IS NULL AND c.consent_at IS NOT NULL
      AND d.due_date IS NOT NULL AND d.due_date<=$1::date
      AND ($2::int >= s.sms_hour*60+s.sms_minute AND $2::int < s.sms_hour*60+s.sms_minute+60)
      AND d.total > COALESCE((SELECT SUM(a.amount) FROM allocations a JOIN payments p ON p.id=a.payment_id WHERE a.debt_id=d.id AND p.reversed_at IS NULL),0)
    ON CONFLICT (debt_id,local_date) DO NOTHING`, [day, minute, now]);
  return rowCount ?? 0;
}
export async function dispatchOne(pool: Pool, adapter: SmsAdapter, now = new Date(), approvedSender?: string) {
  const { day, minute } = localParts(now);
  const c = await pool.connect();
  let job: { id: string; phone: string; sender: string; text: string } | undefined;
  try {
    await c.query('BEGIN');
    const claim = (await c.query(`SELECT o.id,o.store_id,o.debt_id,o.customer_id,to_char(o.local_date,'YYYY-MM-DD') AS local_date,o.attempts,o.status FROM sms_outbox o
      WHERE o.status IN ('pending','retry') AND o.next_attempt_at<=$1 AND o.local_date=$2::date
      ORDER BY o.created_at FOR UPDATE SKIP LOCKED LIMIT 1`, [now, day])).rows[0];
    if (!claim) { await c.query('COMMIT'); return false; }
    await c.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [claim.store_id]);
    const info = (await c.query(`SELECT s.name,s.sender,s.sms_enabled,s.sms_hour,s.sms_minute,s.daily_cap,s.sms_cost_cap,s.sms_unit_cost,s.trial_ends_at,s.paid_until,c.phone,c.opted_out_at,c.archived_at,c.consent_at,d.total,to_char(d.due_date,'YYYY-MM-DD') AS due_date,
      d.total-COALESCE((SELECT SUM(a.amount) FROM allocations a JOIN payments p ON p.id=a.payment_id WHERE a.debt_id=d.id AND p.reversed_at IS NULL),0) AS balance
      FROM debts d JOIN customers c ON c.id=d.customer_id AND c.store_id=d.store_id JOIN stores s ON s.id=d.store_id WHERE d.id=$1 AND d.store_id=$2`, [claim.debt_id, claim.store_id])).rows[0];
    const sent = (await c.query("SELECT COUNT(*)::int AS count FROM sms_outbox WHERE store_id=$1 AND local_date=$2 AND status IN ('processing','accepted','transmitted','delivered','unknown','not_delivered','rejected','failed_delivery','expired')", [claim.store_id, day])).rows[0].count;
    const active = info && (info.trial_ends_at > now || (info.paid_until && info.paid_until > now));
    const valid = info && active && info.sms_enabled && info.sender && (!approvedSender || info.sender === approvedSender) && info.consent_at && !info.opted_out_at && !info.archived_at && info.balance > 0 && info.due_date && info.due_date <= day && claim.local_date === day && minute >= info.sms_hour*60+info.sms_minute && minute < info.sms_hour*60+info.sms_minute+60 && sent < info.daily_cap && (sent+1)*info.sms_unit_cost <= info.sms_cost_cap && info.sms_unit_cost > 0;
    if (!valid) { await c.query("UPDATE sms_outbox SET status='cancelled',last_error='No longer eligible',updated_at=now() WHERE id=$1", [claim.id]); await c.query('COMMIT'); return true; }
    // Once processing is committed a crash is ambiguous; never automatically resend this job.
    const messageId = randomUUID();
    await c.query("UPDATE sms_outbox SET status='processing',attempts=attempts+1,provider_message_id=$2,updated_at=now() WHERE id=$1", [claim.id, messageId]);
    await c.query('COMMIT');
    // Fixed GSM-7 text fits a single segment; store names may contain Unicode/long text.
    job = { id: messageId, phone: info.phone, sender: info.sender, text: `Qarz qoldigi: ${info.balance} UZS. Dokonga murojaat qiling.` };
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  if (!job) return true;
  // Lock the store through the actual network call: repayment/settings changes wait,
  // so no completed repayment can slip between eligibility check and transmission.
  const sendClient = await pool.connect();
  try {
    await sendClient.query('BEGIN');
    const row = (await sendClient.query("SELECT debt_id,customer_id,store_id FROM sms_outbox WHERE provider_message_id=$1 AND status='processing'", [job.id])).rows[0];
    if (!row) { await sendClient.query('COMMIT'); return true; }
    await sendClient.query('SELECT id FROM stores WHERE id=$1 FOR UPDATE', [row.store_id]);
    // The balance query above preceded the lock; recalculate after acquiring it.
    const balance = (await sendClient.query(`SELECT d.total-COALESCE(SUM(a.amount) FILTER (WHERE p.reversed_at IS NULL),0) AS balance
      FROM debts d LEFT JOIN allocations a ON a.debt_id=d.id LEFT JOIN payments p ON p.id=a.payment_id
      WHERE d.id=$1 GROUP BY d.id`, [row.debt_id])).rows[0]?.balance;
    const fresh = (await sendClient.query(`SELECT s.sms_enabled,s.sender,s.trial_ends_at,s.paid_until,s.sms_hour,s.sms_minute,s.sms_unit_cost,s.sms_cost_cap,s.daily_cap,c.phone,c.consent_at,c.opted_out_at,c.archived_at
      FROM stores s JOIN customers c ON c.store_id=s.id WHERE s.id=$1 AND c.id=$2`, [row.store_id, row.customer_id])).rows[0];
    const consumed = (await sendClient.query("SELECT COUNT(*)::int AS count FROM sms_outbox WHERE store_id=$1 AND local_date=$2::date AND status IN ('processing','accepted','transmitted','delivered','unknown','not_delivered','rejected','failed_delivery','expired')", [row.store_id, day])).rows[0].count;
    const local = localParts(now);
    if (!fresh || !fresh.sms_enabled || fresh.sender !== job.sender || (approvedSender && fresh.sender !== approvedSender) || fresh.phone !== job.phone || !fresh.consent_at || fresh.opted_out_at || fresh.archived_at || !(fresh.trial_ends_at > now || fresh.paid_until > now) || Number(balance) <= 0 || local.day !== day || local.minute < fresh.sms_hour*60+fresh.sms_minute || local.minute >= fresh.sms_hour*60+fresh.sms_minute+60 || fresh.sms_unit_cost <= 0 || consumed > fresh.daily_cap || consumed*fresh.sms_unit_cost > fresh.sms_cost_cap) {
      await sendClient.query("UPDATE sms_outbox SET status='cancelled',last_error='No longer eligible before transmission',updated_at=now() WHERE provider_message_id=$1", [job.id]);
      await sendClient.query('COMMIT'); return true;
    }
    job.text = `Qarz qoldigi: ${balance} UZS. Dokonga murojaat qiling.`;
    let result: 'accepted' | 'rejected' | 'unknown';
    try { result = await adapter.send(job); } catch { result = 'unknown'; }
    const status = result === 'rejected' ? 'failed' : result === 'accepted' ? 'accepted' : 'unknown';
    await sendClient.query('UPDATE sms_outbox SET status=$2,last_error=$3,updated_at=now() WHERE provider_message_id=$1 AND status=\'processing\'', [job.id, status, status === 'unknown' ? 'Provider result ambiguous; manual reconciliation required' : status === 'failed' ? 'Provider explicitly rejected request' : null]);
    await sendClient.query('COMMIT');
  } catch (error) { await sendClient.query('ROLLBACK'); throw error; } finally { sendClient.release(); }
  return true;
}
// Explicit, authenticated operator action only; never retry an ambiguous send.
export async function retryRejected(pool: Pool, storeId: string, id: string) {
  return (await pool.query("UPDATE sms_outbox SET status='retry',next_attempt_at=now()+interval '5 minutes',updated_at=now() WHERE id=$1 AND store_id=$2 AND status='failed' RETURNING id", [id, storeId])).rowCount === 1;
}
const callback = z.object({ messages: z.array(z.object({ 'message-id': z.uuid(), channel: z.string(), status: z.enum(['Delivered','Transmitted','NotDelivered','Rejected','Failed','Expired']), 'status-date': z.string(), description: z.string().optional() })).min(1).max(100) });
export async function recordProviderStatus(pool: Pool, payload: unknown) {
  const data = callback.parse(payload);
  for (const m of data.messages) {
    if (m.channel.toLowerCase() !== 'sms') continue;
    const status = ({ Delivered: 'delivered', Transmitted: 'transmitted', NotDelivered: 'not_delivered', Rejected: 'rejected', Failed: 'failed_delivery', Expired: 'expired' } as const)[m.status];
    await pool.query(`UPDATE sms_outbox SET status=$2,updated_at=now() WHERE provider_message_id=$1
      AND (status='accepted' OR (status='transmitted' AND $2 <> 'transmitted'))`, [m['message-id'], status]);
  }
}
