'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EDIT_TOOLS = /(?:write|edit|apply_patch)/i;
const FORMAT_FILES = /\.(?:[cm]?[jt]sx?|json|css|scss|md|yaml|yml)$/i;
const TYPE_FILES = /\.(?:ts|tsx|mts|cts)$/i;
const FRONTEND_FILES = /\.(?:astro|css|html|jsx|scss|svelte|tsx|vue)$/i;
const DESIGN_SIGNALS = [
  /\bget started\b/i,
  /\blearn more\b/i,
  /\bgrid-cols-(?:3|4)\b/,
  /\bbg-gradient-to-[trbl]\b/,
];

function inside(root, filePath) {
  let resolvedRoot;
  let resolvedFile;
  try {
    resolvedRoot = realPath(root);
    resolvedFile = resolvedPath(filePath);
  } catch {
    return false;
  }
  if (!pathInside(resolvedRoot, resolvedFile)) return false;

  let current = path.resolve(root);
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return false;
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return false;
    if (current === path.resolve(filePath) && stat.isFile() && stat.nlink > 1) return false;
  }
  return true;
}

function realPath(filePath) {
  return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
}

function resolvedPath(filePath) {
  const absolute = path.resolve(filePath);
  const missing = [];
  let current = absolute;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realPath(current), ...missing);
}

function pathInside(root, filePath) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const relative = path.relative(normalize(root), normalize(filePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function changedFiles(cwd, state) {
  const files = [];
  for (const activity of state.activities || []) {
    if (!EDIT_TOOLS.test(String(activity.tool || ''))) continue;
    for (const value of activity.files || []) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const activityCwd = typeof activity.cwd === 'string' && activity.cwd ? activity.cwd : cwd;
      const filePath = path.isAbsolute(value) ? path.resolve(value) : path.resolve(activityCwd, value);
      if (inside(cwd, filePath) && fs.existsSync(filePath) && !files.includes(filePath)) files.push(filePath);
      if (files.length >= 40) return files;
    }
  }
  return files;
}

function resolveBin(cwd, packageName, binName) {
  try {
    const packagePath = require.resolve(`${packageName}/package.json`, { paths: [cwd] });
    if (!inside(cwd, packagePath)) return null;
    const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
    const binPath = relative ? path.resolve(path.dirname(packagePath), relative) : null;
    return binPath && inside(cwd, binPath) ? binPath : null;
  } catch {
    return null;
  }
}

function runNode(binPath, args, cwd, timeout) {
  if (!binPath || !fs.existsSync(binPath)) return null;
  return spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    windowsHide: true,
  });
}

function resultFailure(label, result) {
  if (!result || (!result.error && result.status === 0)) return '';
  const detail = result.error?.message || result.stderr || result.stdout || `exit ${result.status}`;
  return `${label} warning: ${String(detail).trim().slice(0, 2000)}`;
}

function runQuality(cwd, state, env = process.env) {
  if (/^(?:0|false|no|off)$/i.test(String(env.ASTER_LOCAL_QUALITY || ''))) return '';
  const files = changedFiles(cwd, state);
  const messages = [];
  const formatFiles = files.filter(filePath => FORMAT_FILES.test(filePath));
  if (formatFiles.length > 0) {
    const prettier = resolveBin(cwd, 'prettier', 'prettier');
    const result = runNode(prettier, ['--write', ...formatFiles], cwd, 30000);
    const failure = resultFailure('Prettier', result);
    if (failure) messages.push(failure);
  }
  if (files.some(filePath => TYPE_FILES.test(filePath)) && fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    const tsc = resolveBin(cwd, 'typescript', 'tsc');
    const result = runNode(tsc, ['--noEmit', '--pretty', 'false'], cwd, 120000);
    const failure = resultFailure('TypeScript', result);
    if (failure) messages.push(failure);
  }
  return messages.join('\n');
}

function frontendWarning(cwd, filePaths) {
  const findings = [];
  for (const value of filePaths || []) {
    const filePath = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
    if (!inside(cwd, filePath) || !FRONTEND_FILES.test(filePath)) continue;
    let source = '';
    try { source = fs.readFileSync(filePath, 'utf8').slice(0, 256 * 1024); } catch { continue; }
    if (DESIGN_SIGNALS.some(pattern => pattern.test(source))) findings.push(path.relative(cwd, filePath));
  }
  return findings.length > 0
    ? `Frontend design warning: review generic template signals in ${findings.slice(0, 5).join(', ')}.`
    : '';
}

module.exports = { changedFiles, frontendWarning, runQuality };
