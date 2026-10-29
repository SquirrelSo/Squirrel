import { Queue, Worker } from 'bullmq';
import { redis } from '../../redis/client.js';
import { syncEvent, syncPending } from './sync.js';
import { captureSnapshot } from '../../leaderboard/snapshot.js';

export const leaderboardSyncQueue = new Queue('leaderboard_sync', {
  connection: redis,
});

export const scheduleSnapshotJob = async () => {
  await leaderboardSyncQueue.add('snapshot', {}, {
    repeat: {
      pattern: '0 * * * *' // Hourly
    },
    jobId: 'hourly_snapshot_job'
  });
};

export const enqueueLeaderboardSync = async (eventIds: string[]) => {
  const jobs = eventIds.map(id => ({
    name: 'sync_event',
    data: { eventId: id },
    opts: { jobId: 'sync-' + id }
  }));
  if (jobs.length > 0) {
    await leaderboardSyncQueue.addBulk(jobs);
  }
};

export function startLeaderboardSyncWorker() {
  console.log('Starting leaderboard_sync worker...');
  
  const worker = new Worker(
    'leaderboard_sync',
    async (job) => {
      if (job.name === 'sync_event') {
        await syncEvent(job.data.eventId);
      } else if (job.name === 'sync_pending') {
        const res = await syncPending();
        console.log('syncPending completed in ' + res.durationMs + 'ms: ' + res.processed + ' processed, ' + res.skipped + ' skipped');
      } else if (job.name === 'snapshot') {
        const res = await captureSnapshot();
        console.log('snapshot completed in ' + res.durationMs + 'ms: ' + res.rowsWritten + ' rows written');
      }
    },
    { connection: redis }
  );

  worker.on('failed', (job, err) => {
    console.error('Job ' + (job?.id || 'unknown') + ' failed:', err);
  });

  return worker;
}
