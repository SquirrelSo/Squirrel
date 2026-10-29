import { Worker, Queue } from 'bullmq';
import { redis } from '../redis/client.js';
import { resolveChallengesBatch } from './resolver.js';

const QUEUE_NAME = 'challenge-resolver';

export const challengeResolverQueue = new Queue(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: true,
    removeOnFail: 100,
  }
});

export function startChallengeResolverWorker(): Worker {
  const worker = new Worker(QUEUE_NAME, async (job) => {
    // Process batches until none left
    let resolved = 0;
    while (true) {
      const count = await resolveChallengesBatch(50);
      resolved += count;
      if (count < 50) break;
    }
    return resolved;
  }, { connection: redis });

  worker.on('failed', (job, err) => {
    console.error(`Challenge resolver job ${job?.id} failed:`, err);
  });

  return worker;
}

export async function scheduleChallengeResolverJob(): Promise<void> {
  await challengeResolverQueue.add('resolve-challenges', {}, {
    repeat: {
      pattern: '*/5 * * * *' // Every 5 minutes
    }
  });
}