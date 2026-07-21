'use strict';

const fs = require('fs');
const path = require('path');

const PLAN_LIMIT = 64 * 1024;
const VERIFICATION_RECORD_LIMIT = 16 * 1024;
const VERIFICATION_ROWS_LIMIT = 200;
const VERIFICATION_FILE_LIMIT = VERIFICATION_RECORD_LIMIT * VERIFICATION_ROWS_LIMIT;
const PLAN_PATH = '.aster/state/current-plan.md';
const VERIFICATION_PATH = '.aster/state/verification.jsonl';

function slash(filePath) {
  return filePath.split(path.sep).join('/');
}

function projectRoot(project) {
  const root = fs.realpathSync(path.resolve(project));
  if (!fs.statSync(root).isDirectory()) throw new Error(`Project root is not a directory: ${project}`);
  return root;
}

function safePath(root, relativePath) {
  const normalized = slash(path.normalize(relativePath));
  if (!normalized || path.isAbsolute(relativePath) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Unsafe harness record path: ${relativePath}`);
  }
  const destination = path.resolve(root, normalized);
  if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Harness record path escapes project: ${relativePath}`);
  }
  let current = root;
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const entry = fs.lstatSync(current);
    if (entry.isSymbolicLink()) {
      throw new Error(`Harness record path crosses a symlink: ${relativePath}`);
    }
    // A hardlink can point at an inode outside the project even though its
    // lexical path stays inside it. Reject existing regular files with more
    // than one link so reads cannot cross that boundary. Atomic writes still
    // replace a destination rather than mutating an external inode, but the
    // guard is needed for reads and deletes as well.
    if (entry.isFile() && Number(entry.nlink) > 1) {
      throw new Error(`Harness record path crosses a hardlink: ${relativePath}`);
    }
  }
  return destination;
}

function initializedRoot(project) {
  const root = projectRoot(project);
  const installState = safePath(root, '.aster/install-state.json');
  if (!fs.existsSync(installState)) throw new Error('Project is not initialized. Run aster init first.');
  return root;
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (!fs.existsSync(filePath)) throw error;
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temporary, filePath);
    }
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Keep the original error. */ }
    throw error;
  }
}

function redact(value) {
  return String(value || '')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function sanitize(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return redact(value).slice(0, 8000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitize(item, depth + 1));
  if (typeof value !== 'object') return String(value).slice(0, 1000);
  return Object.fromEntries(
    Object.entries(value).slice(0, 50).map(([key, nested]) => [
      key,
      /api[_-]?key|authorization|password|secret|token/i.test(key)
        ? '[REDACTED]'
        : sanitize(nested, depth + 1),
    ])
  );
}

function writePlanRecord(project, content) {
  const root = initializedRoot(project);
  if (typeof content !== 'string' || !content.trim()) throw new Error('Plan record must contain text');
  const sanitized = redact(content);
  if (sanitized.length > PLAN_LIMIT) throw new Error(`Plan record exceeds ${PLAN_LIMIT} characters`);
  const filePath = safePath(root, PLAN_PATH);
  atomicWrite(filePath, sanitized.endsWith('\n') ? sanitized : `${sanitized}\n`);
  return { path: PLAN_PATH, characters: sanitized.length };
}

function readPlanRecord(project) {
  const root = initializedRoot(project);
  const filePath = safePath(root, PLAN_PATH);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8').slice(0, PLAN_LIMIT) : '';
}

function readVerificationRecords(project) {
  const root = initializedRoot(project);
  const filePath = safePath(root, VERIFICATION_PATH);
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').slice(-VERIFICATION_FILE_LIMIT)
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-VERIFICATION_ROWS_LIMIT)
    .flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
}

function appendVerificationRecord(project, record) {
  const root = initializedRoot(project);
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('Verification record must be an object');
  }
  const sanitized = sanitize({ recordedAt: new Date().toISOString(), ...record });
  const encoded = JSON.stringify(sanitized);
  if (encoded.length > VERIFICATION_RECORD_LIMIT) {
    throw new Error(`Verification record exceeds ${VERIFICATION_RECORD_LIMIT} characters`);
  }
  const rows = readVerificationRecords(root);
  rows.push(sanitized);
  const filePath = safePath(root, VERIFICATION_PATH);
  atomicWrite(filePath, `${rows.slice(-VERIFICATION_ROWS_LIMIT).map(row => JSON.stringify(row)).join('\n')}\n`);
  return sanitized;
}

function clearTaskRecords(project) {
  const root = initializedRoot(project);
  const removed = [];
  for (const relativePath of [PLAN_PATH, VERIFICATION_PATH]) {
    const filePath = safePath(root, relativePath);
    if (!fs.existsSync(filePath)) continue;
    fs.rmSync(filePath, { force: true });
    removed.push(relativePath);
  }
  return { removed };
}

module.exports = {
  PLAN_LIMIT,
  PLAN_PATH,
  VERIFICATION_PATH,
  appendVerificationRecord,
  clearTaskRecords,
  readPlanRecord,
  readVerificationRecords,
  writePlanRecord,
};
