const path = require('path');

function resolveRuntimePaths(env = process.env, cwd = process.cwd()) {
  const dataRoot = path.resolve(env.CLIPAGENT_DATA_ROOT || (env.NODE_ENV === 'production' ? '/data' : path.join(cwd, '.data')));
  const temporaryRoot = path.resolve(env.CLIPAGENT_TEMP_ROOT || (env.NODE_ENV === 'production' ? '/data/tmp' : path.join(cwd, 'tmp')));
  const taskHome = path.resolve(env.OKX_AGENT_TASK_HOME || path.join(dataRoot, 'a2a'));
  return {
    dataRoot,
    taskHome,
    authHome: path.resolve(env.CLIPAGENT_AUTH_HOME || path.join(dataRoot, 'auth')),
    stateDir: path.resolve(env.A2A_STATE_DIR || path.join(dataRoot, 'a2a-state')),
    stateFile: path.resolve(env.A2A_JOB_STATE_FILE || path.join(dataRoot, 'a2a-state', 'clipagent-a2a-state.json')),
    temporaryRoot,
    uploadsDir: path.resolve(env.TEMP_UPLOAD_DIR || path.join(temporaryRoot, 'uploads')),
    outputDir: path.resolve(env.CLIPS_OUTPUT_DIR || path.join(temporaryRoot, 'clips')),
    logsDir: path.resolve(env.CLIPAGENT_LOG_DIR || path.join(dataRoot, 'logs')),
  };
}

module.exports = { resolveRuntimePaths };
