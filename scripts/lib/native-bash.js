'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function resolveCandidates(candidate, env, platform, spawn = spawnSync) {
  const pathApi = platform === 'win32' ? path.win32 : path;
  if (pathApi.isAbsolute(candidate) || platform !== 'win32') return [candidate];

  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  const where = path.win32.join(systemRoot, 'System32', 'where.exe');
  const result = spawn(where, [candidate], {
    encoding: 'utf8',
    env,
    windowsHide: true,
    timeout: 5000,
  });
  if (result.status !== 0) return [];
  return [...new Set(
    String(result.stdout || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  )];
}

function isWindowsWslLauncher(candidate, env = process.env) {
  const normalized = path.win32.resolve(candidate).replace(/\//g, '\\').toLowerCase();
  const systemRoot = path.win32.resolve(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows')
    .replace(/\//g, '\\')
    .toLowerCase();
  return normalized === `${systemRoot}\\system32\\bash.exe`
    || normalized.endsWith('\\appdata\\local\\microsoft\\windowsapps\\bash.exe');
}

function findNativeBash(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const spawn = options.spawnSync || spawnSync;
  const exists = options.existsSync || fs.existsSync;
  const pathApi = platform === 'win32' ? path.win32 : path;
  const candidates = options.candidates || [
    ...(env.BASH && env.BASH.trim() ? [env.BASH.trim()] : []),
    ...(platform === 'win32' ? ['bash.exe', 'bash'] : ['bash', 'sh']),
  ];

  for (const candidate of [...new Set(candidates)]) {
    for (const resolved of resolveCandidates(candidate, env, platform, spawn)) {
      if (platform === 'win32' && isWindowsWslLauncher(resolved, env)) continue;
      if (pathApi.isAbsolute(resolved) && !exists(resolved)) continue;
      const probe = spawn(resolved, ['-c', ':'], {
        stdio: 'ignore',
        env,
        windowsHide: true,
        timeout: 5000,
      });
      if (!probe.error && probe.status === 0) return resolved;
    }
  }
  return null;
}

module.exports = { findNativeBash, isWindowsWslLauncher };
