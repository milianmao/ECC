'use strict';

const fs = require('fs');
const path = require('path');

const MAX_CANDIDATES_BYTES = 5 * 1024 * 1024;

function validateId(id) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(String(id || ''))) {
    throw new Error('Memory candidate id must use 1-128 letters, digits, dot, colon, underscore, or dash characters');
  }
  return String(id);
}

function pathsFor(projectRoot) {
  const project = fs.realpathSync(path.resolve(projectRoot));
  const root = safePath(project, '.aster/memory');
  return {
    root,
    candidates: safePath(project, '.aster/memory/candidates.jsonl'),
    approved: safePath(project, '.aster/memory/approved.md'),
    rejected: safePath(project, '.aster/memory/rejected.jsonl'),
  };
}

function safePath(projectRoot, relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const resolved = path.resolve(projectRoot, normalized);
  if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`Memory path escapes project: ${relativePath}`);
  }
  let current = projectRoot;
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Memory path crosses a symlink: ${relativePath}`);
    if (current === resolved && stat.isFile() && stat.nlink > 1) {
      throw new Error(`Memory file has multiple hard links: ${relativePath}`);
    }
  }
  return resolved;
}

function readCandidates(projectRoot) {
  const paths = pathsFor(projectRoot);
  if (!fs.existsSync(paths.candidates)) return [];
  if (fs.statSync(paths.candidates).size > MAX_CANDIDATES_BYTES) {
    throw new Error('Memory candidates file exceeds 5 MB');
  }
  return fs.readFileSync(paths.candidates, 'utf8').split(/\r?\n/).flatMap((line, index) => {
    if (!line.trim()) return [];
    let candidate;
    try { candidate = JSON.parse(line); } catch (error) {
      throw new Error(`Invalid memory candidate JSON on line ${index + 1}: ${error.message}`);
    }
    validateId(candidate.id);
    if (typeof candidate.content !== 'string' || !candidate.content.trim()) {
      throw new Error(`Memory candidate ${candidate.id} has no content`);
    }
    return candidate.status && candidate.status !== 'pending' ? [] : [candidate];
  });
}

function listMemory(projectRoot) {
  return { candidates: readCandidates(projectRoot) };
}

function decideMemory(projectRoot, action, rawId, options = {}) {
  if (action !== 'approve' && action !== 'reject') throw new Error(`Unknown memory action: ${action}`);
  const id = validateId(rawId);
  const paths = pathsFor(projectRoot);
  const candidates = readCandidates(projectRoot);
  const candidate = candidates.find(item => item.id === id);
  if (!candidate) throw new Error(`Unknown pending memory candidate: ${id}`);
  if (options.dryRun) return { ok: true, dryRun: true, action, candidate };

  fs.mkdirSync(paths.root, { recursive: true });
  const remaining = candidates.filter(item => item.id !== id);
  fs.writeFileSync(paths.candidates, remaining.length > 0 ? `${remaining.map(JSON.stringify).join('\n')}\n` : '');
  if (action === 'approve') {
    const current = fs.existsSync(paths.approved) ? fs.readFileSync(paths.approved, 'utf8') : '';
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^## ${escapedId}$`, 'm').test(current)) {
      const prefix = current && !current.endsWith('\n') ? `${current}\n` : current;
      fs.writeFileSync(paths.approved, `${prefix}${prefix ? '\n' : ''}## ${id}\n\n${candidate.content.trim()}\n`);
    }
  } else {
    const rejected = { ...candidate, status: 'rejected', decidedAt: new Date().toISOString() };
    fs.appendFileSync(paths.rejected, `${JSON.stringify(rejected)}\n`);
  }
  return { ok: true, dryRun: false, action, candidate };
}

module.exports = { decideMemory, listMemory };
