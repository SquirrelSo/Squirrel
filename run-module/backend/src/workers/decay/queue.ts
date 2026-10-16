import { Queue, Worker } from 'bullmq';
import { redis } from '../../redis/client.js';
import { runDecay } from './decay.js';

export const decayQueue = new Queue('territory_decay', {
  connection: redis,
});

export const scheduleDecayJob = async () => {
  await decayQueue.add('decay', {}, {
    repeat: {
      pattern: '0 3 * * *' // Nightly at 3 AM
    },
    jobId: 'nightly_decay_job'
  });
};

export function startDecayWorker() {
  console.log('Starting territory_decay worker...');
  
  const worker = new Worker(
    'territory_decay',
    async (job) => {
      console.log(`Processing decay job ${job?.id}`);
      try {
        const result = await runDecay();
        console.log(`Decay completed: ${result.expiredCount} expired in ${result.durationMs}ms`);
      } catch (err) {
        console.error(`Decay failed:`, err);
        throw err;
      }
    },
    { connection: redis }
  );

  worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed:`, err);
  });

  return worker;
}
