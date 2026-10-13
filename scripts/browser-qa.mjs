// Local-only browser QA: ephemeral PostgreSQL and the real Express app.
import EmbeddedPostgres from 'embedded-postgres';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import { createApp } from '../dist/app.js';

const dbPort = await new Promise((done, reject) => { const s=createServer(); s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>done(p));}); });
const dir=resolve('.local-db/browser-'+process.pid);
const pg=new EmbeddedPostgres({databaseDir:dir,user:'postgres',password:'browser-fixture-only',port:dbPort,persistent:true,postgresFlags:['-c','listen_addresses=127.0.0.1'],onLog:()=>{},onError:console.error});
let pool, server, started=false, stopping=false;
async function stop(){if(stopping)return;stopping=true;if(server)await new Promise(r=>server.close(r));if(pool)await pool.end();if(started){const ctl=spawnSync(resolve('node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe'),['stop','-D',dir,'-m','fast','-w'],{stdio:'inherit'});if(ctl.status===0)await rm(dir,{recursive:true,force:true});}process.exit();}
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
try{
 await pg.initialise();await pg.start();started=true;await pg.createDatabase('qarz_test');
 const connectionString=`postgres://postgres:${encodeURIComponent('browser-fixture-only')}@127.0.0.1:${dbPort}/qarz_test`;
 const migration=spawnSync(process.execPath,[resolve('node_modules/drizzle-kit/bin.cjs'),'migrate'],{env:{...process.env,DATABASE_URL:connectionString,NODE_ENV:'test'},encoding:'utf8'});
 console.log(migration.stdout);console.error(migration.stderr);
 if(migration.status!==0)throw new Error(`Migration failed: status=${migration.status}, signal=${migration.signal}, error=${migration.error?.message}`);
 pool=new Pool({connectionString});
 const qaPort=Number(process.env.QA_PORT || 4310);
 if(!Number.isInteger(qaPort)||qaPort<1024||qaPort>65535)throw new Error('Invalid QA_PORT');
 server=createApp(pool).listen(qaPort,'127.0.0.1',()=>console.log(`Browser QA ready: http://127.0.0.1:${qaPort}`));
}catch(error){console.error(error);await stop();process.exitCode=1;}
