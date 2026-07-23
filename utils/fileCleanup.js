const fs = require('fs');

async function cleanupFiles(paths, logger = console) {
  const uniquePaths = [...new Set(paths.filter(Boolean))];

  await Promise.all(
    uniquePaths.map(async (filePath) => {
      try {
        await fs.promises.unlink(filePath);
      } catch (error) {
        if (error && error.code === 'ENOENT') return;
        logger.error(`[cleanup] failed to remove ${filePath}: ${error.message}`);
      }
    })
  );
}

module.exports = { cleanupFiles };
