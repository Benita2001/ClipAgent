const { rankWithGroq, MODEL: GROQ_MODEL } = require('./groqRankingProvider');
const { rankWithGemini, MODEL: GEMINI_MODEL } = require('./geminiRankingProvider');

/**
 * 2-tier ranking fallback:
 *  1. Primary — Groq (openai/gpt-oss-120b), with its own internal 3-attempt
 *     retry/temperature-variation loop (see groqRankingProvider.js).
 *  2. Fallback — Gemini Flash, tried once, only after the primary exhausts
 *     ALL of its own attempts.
 * Returns `rankingModel` naming exactly which provider/model produced the
 * result, so the caller always knows which one actually fired. Throws with
 * both failure reasons (never fabricates/returns empty) if both tiers fail.
 */
async function rankMoments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    const err = new Error('No transcript segments available to rank.');
    err.statusCode = 400;
    throw err;
  }

  let groqError;
  try {
    const result = await rankWithGroq(segments);
    console.log(`[ranking] succeeded via primary — rankingModel: "groq/${GROQ_MODEL}" (attempt ${result.attempts}/3)`);
    return { ...result, rankingModel: `groq/${GROQ_MODEL.replace('/', '-')}` };
  } catch (err) {
    groqError = err;
    console.warn(`[ranking] primary (groq/${GROQ_MODEL}) exhausted all attempts, falling back to Gemini: ${err.message}`);
  }

  try {
    const result = await rankWithGemini(segments);
    console.log(`[ranking] succeeded via fallback — rankingModel: "gemini/${GEMINI_MODEL}"`);
    return { ...result, rankingModel: `gemini/${GEMINI_MODEL}` };
  } catch (geminiError) {
    console.error(`[ranking] fallback (gemini/${GEMINI_MODEL}) also failed: ${geminiError.message}`);
    const err = new Error(
      `Ranking failed on both tiers. Primary (groq/${GROQ_MODEL}): ${groqError.message} | ` +
        `Fallback (gemini/${GEMINI_MODEL}): ${geminiError.message}`
    );
    err.statusCode = 502;
    throw err;
  }
}

module.exports = { rankMoments, GROQ_MODEL, GEMINI_MODEL };
