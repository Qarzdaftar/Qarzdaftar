import { Pool } from 'pg';
import { enqueueDue, dispatchOne, PlayMobileAdapter } from './sms.js';

const { DATABASE_URL, SMS_LIVE_ENABLED, SMS_SENDER_APPROVED, PLAYMOBILE_APPROVED_SENDER, PLAYMOBILE_LOGIN, PLAYMOBILE_PASSWORD, SMS_CALLBACK_SECRET } = process.env;
if (SMS_LIVE_ENABLED !== '1' || SMS_SENDER_APPROVED !== '1' || !PLAYMOBILE_APPROVED_SENDER || !/^[A-Za-z0-9]{1,11}$/.test(PLAYMOBILE_APPROVED_SENDER) || !PLAYMOBILE_LOGIN || !PLAYMOBILE_PASSWORD || !SMS_CALLBACK_SECRET || SMS_CALLBACK_SECRET.length < 32) {
  console.error('SMS worker disabled: provider credentials, approved sender, callback secret and explicit live flags required. No SMS sent.');
  process.exitCode = 2;
} else if (!DATABASE_URL) {
  console.error('DATABASE_URL required'); process.exitCode = 2;
} else {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
  const adapter = new PlayMobileAdapter(PLAYMOBILE_LOGIN, PLAYMOBILE_PASSWORD);
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      await pool.query("UPDATE sms_outbox SET status='unknown',last_error='Interrupted during dispatch; reconcile manually',updated_at=now() WHERE status='processing' AND updated_at<now()-interval '2 minutes'");
      await enqueueDue(pool);
      for (let i = 0; i < 100 && await dispatchOne(pool, adapter, new Date(), PLAYMOBILE_APPROVED_SENDER); i++) { /* bounded batch */ }
    } catch (error) { console.error('SMS worker tick failed', error); }
    finally { busy = false; }
  };
  await pool.query('SELECT 1');
  await tick();
  const timer = setInterval(() => { void tick(); }, 60_000);
  const shutdown = () => { clearInterval(timer); void pool.end(); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
