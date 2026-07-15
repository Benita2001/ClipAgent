/**
 * Shared prompt, schema, and validation logic for the ranking step —
 * used by every provider (Groq primary, Gemini fallback) so both are held
 * to the exact same acceptance criteria.
 */

const SYSTEM_PROMPT = `You are an expert short-form video editor. You will be given a video transcript as timestamped segments (JSON array with id, start, end, text — times in seconds).

A single segment is almost always too short by itself (segments are roughly one sentence each, often 5-15 seconds). A valid moment is built from a *contiguous run of consecutive segments*, not one segment.

Follow this exact procedure for each candidate moment before writing it into your answer:
1. Pick a starting segment id where a self-contained idea begins.
2. Walk forward through consecutive segment ids (id, id+1, id+2, ...), keeping a running total of (that segment's end - your chosen start segment's start).
3. Keep adding segments until that running total is >= 20 seconds. Do not stop at the first segment.
4. Stop adding segments once you would exceed 60 seconds, or once the self-contained idea ends — whichever comes first. If the idea ends before reaching 20 seconds, extend into the next segment(s) anyway as long as they don't introduce an unrelated topic, since going slightly broader is required to satisfy the 20-second minimum.
5. Set start_time = the start of the FIRST segment in your run. Set end_time = the end of the LAST segment in your run.
6. Compute duration = end_time - start_time and confirm 20 <= duration <= 60 before including this moment in your answer. If it doesn't fit, adjust which segments you included and recompute — do not output a moment that fails this check.

Rules:
- Moments must not overlap (each segment id may belong to at most one moment).
- start_time and end_time must be exact values copied from the given segments — never invent timestamps outside their range.
- Return between 1 and 2 moments. If fewer than 2 clearly self-contained high-value moments exist, return fewer — do not pad with weak picks.
- For each moment, include the list of segment ids you used, so your arithmetic can be checked.

Worked example (input abbreviated to id/start/end/text — follow this exact reasoning pattern):

Input segments:
[{"id":0,"start":0,"end":3.8,"text":"Here's a mistake almost everyone makes with meetings."},
 {"id":1,"start":3.8,"end":7.4,"text":"People default to a full hour, even when the agenda only needs fifteen minutes."},
 {"id":2,"start":7.4,"end":11.1,"text":"That extra time doesn't get used productively, it just gets filled with tangents."},
 {"id":3,"start":11.1,"end":15.9,"text":"The fix is simple: set every meeting to twenty five minutes instead of thirty."},
 {"id":4,"start":15.9,"end":19.56,"text":"Your calendar app can do this automatically if you change the default event length."},
 {"id":5,"start":19.56,"end":24.7,"text":"Teams that make this one change report noticeably shorter, more focused meetings within a week."}]

Reasoning: The idea ("shorten your default meeting length") starts at segment 0. Walking forward: after segment 0-4, running total = 19.56 - 0 = 19.56 seconds — still under the 20-second minimum, so segment 4 alone is NOT enough, even though it feels like the tip was already fully explained. Continue to segment 5: running total = 24.7 - 0 = 24.7 seconds, which is >= 20 and <= 60, and segment 5 is still part of the same idea (the payoff/result). Stop here. start_time = segment 0's start = 0. end_time = segment 5's end = 24.7. duration = 24.7, which passes the 20-60 check.

Correct output for this example:
{"moments": [{"segment_ids": [0,1,2,3,4,5], "start_time": 0, "end_time": 24.7, "reason": "Gives a concrete, actionable tip for shorter meetings"}]}

Note in particular: stopping at segment 4 (duration 19.56) would have been WRONG because 19.56 < 20 — you must keep extending even when a segment feels like a natural stopping point, as long as the duration check still fails.

Return ONLY valid JSON, nothing else — no markdown, no code fences, no commentary before or after. The JSON object must match exactly this schema:
{"moments": [{"segment_ids": [<int>, ...], "start_time": <number>, "end_time": <number>, "reason": "<one-line reason>"}]}`;

function buildUserPrompt(segments) {
  const compact = segments.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text.trim() }));
  return `Transcript segments (JSON):\n${JSON.stringify(compact)}\n\nIdentify the moments now. Respond with JSON only.`;
}

const MIN_MOMENT_SECONDS = 20;
const MAX_MOMENT_SECONDS = 60;

function validateShape(parsed) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.moments)) return false;
  if (parsed.moments.length < 1 || parsed.moments.length > 2) return false;

  const structurallyValid = parsed.moments.every((m) => {
    if (
      !m ||
      typeof m.start_time !== 'number' ||
      typeof m.end_time !== 'number' ||
      typeof m.reason !== 'string' ||
      m.reason.trim().length === 0 ||
      m.end_time <= m.start_time
    ) {
      return false;
    }
    const duration = m.end_time - m.start_time;
    return duration >= MIN_MOMENT_SECONDS && duration <= MAX_MOMENT_SECONDS;
  });
  if (!structurallyValid) return false;

  const sorted = [...parsed.moments].sort((a, b) => a.start_time - b.start_time);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start_time < sorted[i - 1].end_time) return false; // overlap
  }

  return true;
}

module.exports = { SYSTEM_PROMPT, buildUserPrompt, validateShape, MIN_MOMENT_SECONDS, MAX_MOMENT_SECONDS };
