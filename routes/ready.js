const express = require('express');

function createReadyRouter(getReadinessState) {
  const router = express.Router();

  router.get('/ready', (req, res) => {
    const readiness = getReadinessState();
    if (readiness.status === 'ready') {
      res.status(200).json({
        status: 'ready',
        x402: { ready: true },
      });
      return;
    }

    const x402 = {
      ready: false,
      state: readiness.status,
      attempts: readiness.attempts,
    };
    if (readiness.lastError) x402.lastError = readiness.lastError;
    if (readiness.nextRetryAt) x402.nextRetryAt = readiness.nextRetryAt;

    res.status(503).json({
      status: 'not_ready',
      x402,
    });
  });

  return router;
}

module.exports = { createReadyRouter };
