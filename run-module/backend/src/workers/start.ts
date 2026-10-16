import { startAllWorkers } from './all.js';
import { pool } from '../db/pool.js';
import { redis } from '../redis/client.js';

async function main() {
  console.log('Starting background workers...');
  
  const workers = await startAllWorkers();

  process.on('SIGINT', async () => {
    console.log('\nShutting down workers...');
    await Promise.all(workers.map(w => w.close()));
    await pool.end();
    redis.quit();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Failed to start workers:', err);
  process.exit(1);
});