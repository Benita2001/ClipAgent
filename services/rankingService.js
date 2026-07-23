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
async function rankMoments(segments, overrides = {}) {
  const dependencies = { rankWithGroq, rankWithGemini, logger: console, ...overrides };
  if (!Array.isArray(segments) || segments.length === 0) {
    const err = new Error('No transcript segments available to rank.');
    err.statusCode = 400;
    throw err;
  }

  let groqError;
  try {
    const result = await dependencies.rankWithGroq(segments);
    dependencies.logger.log(`[ranking] succeeded via primary — rankingModel: "groq/${GROQ_MODEL}" (attempt ${result.attempts}/3)`);
    return { ...result, rankingModel: `groq/${GROQ_MODEL.replace('/', '-')}` };
  } catch (err) {
    groqError = err;
    dependencies.logger.warn(`[ranking] primary failed, falling back to Gemini.`);
  }

  try {
    const result = await dependencies.rankWithGemini(segments);
    dependencies.logger.log(`[ranking] succeeded via fallback — rankingModel: "gemini/${GEMINI_MODEL}"`);
    return { ...result, rankingModel: `gemini/${GEMINI_MODEL}` };
  } catch (geminiError) {
    dependencies.logger.error(`[ranking] fallback also failed.`);
    const err = new Error(
      `Ranking failed on both tiers. Primary (groq/${GROQ_MODEL}): ${groqError.message} | ` +
        `Fallback (gemini/${GEMINI_MODEL}): ${geminiError.message}`
    );
    err.statusCode = 502;
    throw err;
  }
}

module.exports = { rankMoments, GROQ_MODEL, GEMINI_MODEL };
