// The studio's own brief validator over the bench briefs. The script runs
// under `node --import tsx` (the `bench:video` npm script), so it imports the
// TypeScript validator itself rather than a copy of its rules: a brief that
// passes here passes the runner's `POST /api/jobs`, apart from the speech
// rate, which the runner takes from gnosia-audio and this check takes as the
// studio's fallback (15.2 characters a second) until gnosia-audio answers.
import { validateVideoBrief } from '../../../services/studio/src/video/brief.ts';

import { BENCH_TOOLS, benchProblems, jobBody, vocabularyFrom } from './briefs.mjs';

/**
 * Every problem with the bench briefs: the bench's own rules, then the
 * studio's validator for each brief as `run` would post it with each tool.
 */
export function validateBench(entries, topics) {
  const problems = benchProblems(entries, topics);
  const vocabulary = vocabularyFrom(topics);
  for (const entry of entries) {
    if (typeof entry.brief !== 'object' || entry.brief === null) continue;
    for (const tool of BENCH_TOOLS) {
      try {
        // The longest label a run allows, so the slug's length is tested too.
        validateVideoBrief(jobBody(entry, { label: 'a'.repeat(20), tool }), vocabulary);
      } catch (error) {
        problems.push(`${entry.id} with ${tool}: ${error.message}`);
      }
    }
  }
  return problems;
}
