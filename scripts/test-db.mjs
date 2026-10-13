import EmbeddedPostgres from 'embedded-postgres';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';

const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => {
    const address = server.address(); server.close(() => resolvePort(address.port));
  });
});
const databaseDir = resolve('.local-db/test-' + process.pid);
const pg = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'test-only-local', port, persistent: true, postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => {}, onError: console.error });
const url = `postgres://postgres:test-only-local@127.0.0.1:${port}/qarz_test`;
let started = false;
try {
  console.log('Initializing isolated local PostgreSQL'); await pg.initialise();
  console.log('Starting local PostgreSQL'); await pg.start(); started = true;
  await pg.createDatabase('qarz_test');
  const env = { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' };
  for (const args of [[resolve('node_modules/drizzle-kit/bin.cjs'), 'migrate'], [resolve('node_modules/vitest/vitest.mjs'), 'run', ...process.argv.slice(2)]]) {
    const result = spawnSync(process.execPath, args, { env, stdio: 'inherit', cwd: process.cwd() });
    if (result.error) throw result.error;
    console.log('subprocess exit:', result.status);
    if (result.status !== 0) { process.exitCode = result.status || 1; break; }
  }
} finally {
  if (started) {
    // embedded-postgres.stop() uses taskkill /f on Windows; pg_ctl stops PostgreSQL cleanly.
    const ctl = spawnSync(resolve('node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe'), ['stop', '-D', databaseDir, '-m', 'fast', '-w'], { stdio: 'inherit' });
    if (ctl.status !== 0) process.exitCode = 1;
    else await rm(databaseDir, { recursive: true, force: true });
  }
}
process.exit(process.exitCode ?? 0);
