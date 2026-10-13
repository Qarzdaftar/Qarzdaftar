import { Pool } from 'pg';
import { createApp } from './app.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_ORIGIN?.startsWith('https://')) throw new Error('PUBLIC_ORIGIN HTTPS required in production');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
await pool.query('SELECT 1');
const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const server = createApp(pool).listen(port, () => console.log(`Qarz Daftar API listening on ${port}`));
const shutdown = () => server.close(() => { void pool.end(); });
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
