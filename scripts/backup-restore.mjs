// Disposable cold physical PostgreSQL backup/restore drill; never point at production.
import EmbeddedPostgres from 'embedded-postgres';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { cp, rm } from 'node:fs/promises';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../dist/app.js';

const port = await new Promise((done, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(() => done(address.port));
  });
});
const dir = resolve('.local-db/restore-' + process.pid);
const restoredDir = resolve('.local-db/restore-copy-' + process.pid);
const password = 'disposable-local-only';
const bin = name => resolve(`node_modules/@embedded-postgres/windows-x64/native/bin/${name}.exe`);
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password, port, persistent: true, postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => {}, onError: console.error });
const url = db => `postgres://postgres:${password}@127.0.0.1:${port}/${db}`;
const env = { ...process.env, PGPASSWORD: password, DATABASE_URL: url('source_fixture'), NODE_ENV: 'test' };
function run(cmd, args) {
  const child = spawnSync(cmd, args, { cwd: process.cwd(), env, stdio: 'inherit' });
  if (child.error || child.status !== 0) throw new Error(`${cmd} failed: ${child.error?.message ?? child.status}`);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
let started = false;
let copiedStarted = false;
let source, restored;
try {
  await pg.initialise();
  await pg.start(); started = true;
  await pg.createDatabase('source_fixture');
  run(process.execPath, [resolve('node_modules/drizzle-kit/bin.cjs'), 'migrate']);
  source = new Pool({ connectionString: url('source_fixture') });
  const app = createApp(source);
  const registration = await request(app).post('/api/auth/register').send({ storeName: 'Disposable restore fixture', email: 'restore@example.test', password: 'Only disposable restore fixture passphrase' });
  assert(registration.status === 201, 'Fixture registration failed');
  const headers = { Cookie: registration.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': registration.body.data.csrf };
  const customer = await request(app).post('/api/customers').set(headers).send({ name: 'Synthetic customer', phone: '901234567', consentEvidence: 'Synthetic fixture consent only' });
  assert(customer.status === 201, 'Fixture customer failed');
  const debt = await request(app).post('/api/debts').set(headers).send({ customerId: customer.body.data.id, items: [{ title: 'Synthetic item', quantity: 1, unitPrice: 150000 }] });
  assert(debt.status === 201, 'Fixture debt failed');
  const payment = await request(app).post('/api/payments').set(headers).set('Idempotency-Key', crypto.randomUUID()).send({ customerId: customer.body.data.id, allocations: [{ debtId: debt.body.data.id, amount: 50000 }] });
  assert(payment.status === 201, 'Fixture payment failed');
  const before = await request(app).get('/api/export').set(headers);
  assert(before.status === 200, 'Source export failed');
  await source.end(); source = null;

  // The embedded distribution only supplies postgres/initdb/pg_ctl, not pg_dump.
  // Copy the cluster ONLY after clean shutdown to avoid inconsistent WAL/data.
  run(bin('pg_ctl'), ['stop', '-D', dir, '-m', 'fast', '-w']); started = false;
  await cp(dir, restoredDir, { recursive: true });
  const copied = new EmbeddedPostgres({ databaseDir: restoredDir, user: 'postgres', password, port, persistent: true, postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => {}, onError: console.error });
  await copied.start(); copiedStarted = true;
  restored = new Pool({ connectionString: url('source_fixture') });
  const restoredApp = createApp(restored);
  const health = await request(restoredApp).get('/health');
  const after = await request(restoredApp).get('/api/export').set(headers);
  const summary = await request(restoredApp).get('/api/reports/summary').set(headers);
  assert(health.status === 200 && after.status === 200 && summary.status === 200, 'Restored API failed');
  assert(after.body.data.customers.length === 1 && after.body.data.debts.length === 1 && after.body.data.payments.length === 1 && after.body.data.allocations.length === 1, 'Restored row counts differ');
  for (const table of ['customers', 'debts', 'payments', 'allocations']) assert(JSON.stringify(after.body.data[table]) === JSON.stringify(before.body.data[table]), `Restored ${table} differs`);
  assert(summary.body.data.total_debt === 150000 && summary.body.data.total_paid === 50000, 'Restored totals differ');
  console.log('PASS: isolated migration, clean-shutdown physical backup/restore, authenticated read-back, 4 tables and 150000/50000 totals');
} finally {
  if (source) await source.end();
  if (restored) await restored.end();
  if (copiedStarted) run(bin('pg_ctl'), ['stop', '-D', restoredDir, '-m', 'fast', '-w']);
  if (started) {
    run(bin('pg_ctl'), ['stop', '-D', dir, '-m', 'fast', '-w']);
  }
  await rm(dir, { recursive: true, force: true });
  await rm(restoredDir, { recursive: true, force: true });
}
