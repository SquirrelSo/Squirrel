import { pool } from '../db/pool.js';
import { Metric } from './metrics.js';
import { computeProgress, meetsTarget } from './progress.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Comparator } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let queries: string[] = [];
async function loadQueries() {
  if (queries.length > 0) return;
  const sqlFile = await fs.readFile(
    path.join(__dirname, '../../../db/queries/challenges.sql'),
    'utf8'
  );
  queries = sqlFile
    .split('----')
    .map((q) => q.trim())
    .filter(Boolean);
}

export async function resolveChallengesBatch(batchSize: number = 50): Promise<number> {
  await loadQueries();
  const RESOLVER_GET_RESOLVABLE = queries[8]!;
  const RESOLVER_GET_ACTIVITY = queries[9]!;
  const RESOLVER_UPDATE_PARTICIPANT = queries[10]!;
  const RESOLVER_UPDATE_CHALLENGE = queries[11]!;
  const GET_PARTICIPANTS = queries[5]!;

  const client = await pool.connect();
  let resolvedCount = 0;
  try {
    const resolvable = await client.query(RESOLVER_GET_RESOLVABLE, [batchSize]);
    
    for (const challenge of resolvable.rows) {
      await client.query('BEGIN');
      try {
        // Double check state inside transaction for idempotency
        const chCheck = await client.query('SELECT state FROM challenges WHERE id = $1 FOR UPDATE', [challenge.id]);
        if (!chCheck.rows[0] || chCheck.rows[0].state !== 'active') {
          await client.query('ROLLBACK');
          continue;
        }

        const participantsRes = await client.query(GET_PARTICIPANTS, [challenge.id]);
        const acceptedParts = participantsRes.rows.filter(p => p.status === 'accepted');
        
        let participantProgress = new Map<string, number>();

        for (const p of acceptedParts) {
          const actRes = await client.query(RESOLVER_GET_ACTIVITY, [p.user_id, challenge.starts_at, challenge.ends_at]);
          const prog = computeProgress(actRes.rows, challenge.metric as Metric);
          participantProgress.set(p.user_id, prog);
        }

        const metricTarget = challenge.threshold;
        const comparator = challenge.comparator as Comparator;
        let winners = new Set<string>();

        if (challenge.type === 'daily') {
          for (const [uid, prog] of participantProgress.entries()) {
            if (meetsTarget(prog, comparator, metricTarget)) {
              winners.add(uid);
            }
          }
        } else if (challenge.type === 'head_to_head') {
          // Both must have met target? Or highest progress wins regardless?
          // Rule: To encourage sportsmanship over arbitrary tie-breaking, in the event of a tie both players win if they met the target, else neither wins. Highest progress wins. 
          let highest = -Infinity;
          for (const prog of participantProgress.values()) {
            if (prog > highest) highest = prog;
          }
          
          const highestUsers = Array.from(participantProgress.entries()).filter(([_, prog]) => prog === highest).map(([u]) => u);
          
          if (highestUsers.length === 1) {
            winners.add(highestUsers[0]!);
          } else if (highestUsers.length > 1) {
             // Tie
             if (meetsTarget(highest, comparator, metricTarget)) {
               for (const u of highestUsers) winners.add(u);
             }
          }
        } else if (challenge.type === 'group') {
          let combined = 0;
          for (const prog of participantProgress.values()) {
             combined += prog;
          }
          if (meetsTarget(combined, comparator, metricTarget)) {
             for (const u of participantProgress.keys()) winners.add(u);
          }
        }

        for (const p of participantsRes.rows) {
           if (p.status !== 'accepted') continue;
           const isWinner = winners.has(p.user_id);
           const xp = isWinner ? challenge.xp_reward : 0;
           const prog = participantProgress.get(p.user_id) || 0;
           await client.query(RESOLVER_UPDATE_PARTICIPANT, [challenge.id, prog, isWinner, xp, p.user_id]);
        }

        await client.query(RESOLVER_UPDATE_CHALLENGE, [challenge.id]);
        await client.query('COMMIT');
        resolvedCount++;
        console.log(`Resolved challenge ${challenge.id}, type: ${challenge.type}, winners: ${winners.size}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`Failed to resolve challenge ${challenge.id}`, err);
      }
    }
    return resolvedCount;
  } finally {
    client.release();
  }
}