'use strict';

const fs = require('fs');
const path = require('path');

const TEST_MODE = 'project-isolated';
const REQUIRED_ISOLATED_PATHS = [
  'HOME',
  'USERPROFILE',
  'AGENTS_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_PLUGIN_DATA',
  'PLUGIN_DATA',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'GIT_CONFIG_GLOBAL',
  'npm_config_cache',
  'npm_config_prefix',
  'npm_config_userconfig',
  'npm_config_globalconfig',
];

function comparable(filePath) {
  const absolute = path.resolve(filePath);
  const missing = [];
  let current = absolute;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  let resolved = absolute;
  try {
    const existing = fs.realpathSync.native ? fs.realpathSync.native(current) : fs.realpathSync(current);
    resolved = path.join(existing, ...missing);
  } catch { /* The lexical absolute path remains the safest available fallback. */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const base = comparable(root);
  const value = comparable(candidate);
  const relative = path.relative(base, value);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertInside(root, candidate, label) {
  if (!candidate || !isInside(root, candidate)) {
    throw new Error(`${label} must stay inside the repository-local test sandbox: ${candidate || '<unset>'}`);
  }
}

function isolationContext(env = process.env) {
  if (env.ASTER_TEST_MODE !== TEST_MODE) {
    throw new Error('Aster installation tests must run through npm run aster:test or npm test.');
  }
  const repoRoot = env.ASTER_REPO_ROOT;
  const testRoot = env.ASTER_TEST_ROOT;
  if (!repoRoot || !testRoot) throw new Error('Aster test isolation paths are not configured.');
  assertInside(repoRoot, testRoot, 'ASTER_TEST_ROOT');
  if (!fs.existsSync(testRoot) || !fs.statSync(testRoot).isDirectory()) {
    throw new Error(`Aster test sandbox does not exist: ${testRoot}`);
  }
  for (const name of REQUIRED_ISOLATED_PATHS) assertInside(testRoot, env[name], name);
  return { repoRoot: path.resolve(repoRoot), testRoot: path.resolve(testRoot) };
}

function requireHarnessTestIsolation(repoRoot, env = process.env) {
  const context = isolationContext(env);
  if (comparable(context.repoRoot) !== comparable(repoRoot)) {
    throw new Error(`Aster tests were launched for a different repository: ${context.repoRoot}`);
  }
  return context;
}

function assertProjectTestIsolation(projectRoot, env = process.env) {
  if (env.ASTER_TEST_MODE !== TEST_MODE) return;
  const context = isolationContext(env);
  assertInside(context.testRoot, projectRoot, 'Aster test project');
}

module.exports = {
  REQUIRED_ISOLATED_PATHS,
  TEST_MODE,
  assertInside,
  assertProjectTestIsolation,
  isInside,
  requireHarnessTestIsolation,
};
