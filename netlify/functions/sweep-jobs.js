// Scheduled every 5 minutes (Netlify scheduled function, all plans).
// Guarantees the privacy promise even when nobody visits the site:
// orphaned photo hand-offs are deleted after 5 min at most, stuck jobs are refunded.
// Scheduled functions run only on the published production deploy.

import { configured } from '../lib/supabase.js';
import { sweepHandoffs, sweepStuckJobs } from '../lib/sweep.js';

export default async () => {
  if (!configured()) { console.error('sweep-jobs: Supabase not configured'); return; }
  const handoffs = await sweepHandoffs();
  const jobs = await sweepStuckJobs();
  console.log(`sweep-jobs: ${handoffs} hand-off(s) deleted, ${jobs} stuck job(s) refunded`);
};

export const config = { schedule: '*/5 * * * *' };
