function constrainRankedMoments(ranked, input, sourceDurationSeconds) {
  const moments = ranked.moments.slice(0, input.clipCount).map((moment) => {
    const minimumEnd = moment.start_time + input.minDurationSeconds;
    const maximumEnd = moment.start_time + input.maxDurationSeconds;
    return {
      ...moment,
      end_time: Math.min(
        Math.max(moment.end_time, minimumEnd),
        maximumEnd,
        sourceDurationSeconds
      ),
    };
  });
  if (
    moments.length !== input.clipCount ||
    moments.some(
      (moment) => moment.end_time - moment.start_time < input.minDurationSeconds
    )
  ) {
    const error = new Error('Ranking did not produce moments matching the requested duration.');
    error.statusCode = 422;
    error.code = 'NO_MATCHING_CLIPS';
    throw error;
  }
  return { ...ranked, moments };
}

module.exports = { constrainRankedMoments };
