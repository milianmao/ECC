'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CORE_SKILLS, selectContent } = require('./manifest');
const memory = require('./memory');
const records = require('./records');
const { assertProjectTestIsolation } = require('./test-isolation');

const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');
const STATE_VERSION = 1;
const STATE_PATH = '.aster/install-state.json';
const WORKFLOW_SKILLS = CORE_SKILLS.filter(name => name.startsWith('harness-'));
const DEFAULT_CONFIG = Object.freeze({
  target: 'both',
  distribution: 'project',
  stacks: 'auto',
  with: [],
  without: [],
  hooks: 'balanced',
  memory: { approvalRequired: true, maxInjectedCharacters: 8000 },
  agents: { maxThreads: 3, maxDepth: 1 },
});
const WRITING_AGENTS = new Set([
  'code-architect', 'tdd-guide', 'build-error-resolver', 'code-simplifier',
  'refactor-cleaner', 'e2e-runner', 'doc-updater', 'loop-operator',
  'react-build-resolver', 'django-build-resolver', 'go-build-resolver',
  'rust-build-resolver', 'java-build-resolver', 'kotlin-build-resolver',
  'cpp-build-resolver', 'dart-build-resolver', 'swift-build-resolver',
  'pytorch-build-resolver',
]);
const GITIGNORE_BLOCK = '# >>> aster managed\n.aster/\n# <<< aster managed\n';
const CODEX_MARKER_START = '# >>> aster agents';
const CODEX_MARKER_END = '# <<< aster agents';
const GUIDANCE_START = '<!-- >>> aster managed -->';
const GUIDANCE_END = '<!-- <<< aster managed -->';

function hash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}
function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}
function slash(filePath) {
  return filePath.split(path.sep).join('/');
}
function safePath(projectRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`Unsafe managed path: ${relativePath}`);
  }
  const normalized = slash(path.normalize(relativePath));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Unsafe managed path: ${relativePath}`);
  }
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, normalized);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Managed path escapes project: ${relativePath}`);
  }
  let current = root;
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`Managed path crosses a symlink: ${relativePath}`);
    if (current === resolved && stat.isFile() && stat.nlink > 1) {
      throw new Error(`Managed file has multiple hard links: ${relativePath}`);
    }
  }
  return resolved;
}
function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label} at ${filePath}: ${error.message}`);
  }
}
function writeFile(filePath, content, mode) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  if (mode !== undefined) {
    try { fs.chmodSync(filePath, mode); } catch { /* Windows can ignore POSIX modes. */ }
  }
}
function removeEmptyParents(startPath, projectRoot) {
  let current = path.dirname(startPath);
  const stop = path.resolve(projectRoot);
  while (current !== stop && current.startsWith(`${stop}${path.sep}`)) {
    try {
      if (fs.readdirSync(current).length > 0) break;
      fs.rmdirSync(current);
      current = path.dirname(current);
    } catch {
      break;
    }
  }
}
function targetNames(target) {
  if (target === 'both') return ['claude', 'codex'];
  if (target === 'claude' || target === 'codex') return [target];
  throw new Error(`Invalid --target: ${target}. Expected both, claude, or codex.`);
}
function configText(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}
function normalizeConfig(raw, overrides = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('aster.json must contain a JSON object');
  }
  if (raw.with !== undefined && !Array.isArray(raw.with)) throw new Error('aster.json "with" must be an array');
  if (raw.without !== undefined && !Array.isArray(raw.without)) throw new Error('aster.json "without" must be an array');
  if (raw.memory !== undefined && (!raw.memory || typeof raw.memory !== 'object' || Array.isArray(raw.memory))) {
    throw new Error('aster.json "memory" must be an object');
  }
  if (raw.agents !== undefined && (!raw.agents || typeof raw.agents !== 'object' || Array.isArray(raw.agents))) {
    throw new Error('aster.json "agents" must be an object');
  }
  const config = {
    ...jsonClone(DEFAULT_CONFIG),
    ...raw,
    memory: { ...DEFAULT_CONFIG.memory, ...(raw.memory || {}) },
    agents: { ...DEFAULT_CONFIG.agents, ...(raw.agents || {}) },
  };
  config.target = overrides.target || config.target;
  config.distribution = overrides.distribution || config.distribution;
  config.with = [...(Array.isArray(config.with) ? config.with : []), ...(overrides.with || [])];
  config.without = [...(Array.isArray(config.without) ? config.without : []), ...(overrides.without || [])];
  targetNames(config.target);
  if (config.distribution !== 'project' && config.distribution !== 'plugin-overlay') {
    throw new Error('aster.json "distribution" must be "project" or "plugin-overlay"');
  }
  if (config.stacks !== 'auto' && config.stacks !== 'none' && !Array.isArray(config.stacks)) {
    throw new Error('aster.json "stacks" must be "auto", "none", or an array');
  }
  if (config.hooks !== 'balanced' && config.hooks !== 'off') {
    throw new Error('aster.json "hooks" must be "balanced" or "off"');
  }
  if (config.memory.approvalRequired !== true) {
    throw new Error('Personal harness memory must remain approval-gated');
  }
  if (!Number.isInteger(config.memory.maxInjectedCharacters) || config.memory.maxInjectedCharacters < 1 || config.memory.maxInjectedCharacters > 8000) {
    throw new Error('memory.maxInjectedCharacters must be an integer from 1 to 8000');
  }
  if (!Number.isInteger(config.agents.maxThreads) || config.agents.maxThreads < 1 || config.agents.maxThreads > 3) {
    throw new Error('agents.maxThreads must be an integer from 1 to 3');
  }
  if (config.agents.maxDepth !== 1) {
    throw new Error('agents.maxDepth must be 1');
  }
  return config;
}
function loadConfig(projectRoot, options = {}) {
  const filePath = path.join(projectRoot, 'aster.json');
  const exists = fs.existsSync(filePath);
  const seed = {
    ...jsonClone(DEFAULT_CONFIG),
    ...(options.target ? { target: options.target } : {}),
    ...(options.distribution ? { distribution: options.distribution } : {}),
    ...(options.with?.length ? { with: [...options.with] } : {}),
    ...(options.without?.length ? { without: [...options.without] } : {}),
  };
  const raw = exists ? readJson(filePath, 'aster config') : seed;
  return {
    config: normalizeConfig(raw, exists ? options : {}),
    exists,
    seedContent: Buffer.from(configText(normalizeConfig(seed))),
  };
}
function loadState(projectRoot, required = false) {
  const filePath = safePath(projectRoot, STATE_PATH);
  if (!fs.existsSync(filePath)) {
    if (required) throw new Error('Project is not initialized. Run aster init first.');
    return null;
  }
  const state = readJson(filePath, 'aster install state');
  if (state.version !== STATE_VERSION || !Array.isArray(state.files)) {
    throw new Error(`Unsupported install state version at ${filePath}`);
  }
  for (const group of ['files', 'editableFiles', 'jsonFragments', 'textFragments']) {
    if (state[group] !== undefined && !Array.isArray(state[group])) throw new Error(`Invalid ${group} in install state`);
    for (const entry of state[group] || []) safePath(projectRoot, entry.path);
  }
  return state;
}
function walkSource(sourceDir, destinationDir, operations) {
  if (!fs.existsSync(sourceDir)) throw new Error(`Harness source is missing: ${sourceDir}`);
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      walkSource(sourcePath, destinationPath, operations);
    } else if (entry.isFile()) {
      const stat = fs.statSync(sourcePath);
      operations.push({ path: slash(destinationPath), content: fs.readFileSync(sourcePath), mode: stat.mode & 0o777 });
    }
  }
}
function parseAgent(markdown, expectedName) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Agent ${expectedName} has no valid frontmatter`);
  const field = name => {
    const found = match[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
    if (!found) throw new Error(`Agent ${expectedName} is missing ${name}`);
    return found[1].trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  };
  const name = field('name');
  if (name !== expectedName) throw new Error(`Agent filename ${expectedName} does not match frontmatter name ${name}`);
  return { name, description: field('description'), instructions: match[2].trim() };
}
function agentToml(agent) {
  const sandbox = WRITING_AGENTS.has(agent.name) || agent.name.endsWith('-build-resolver')
    ? 'workspace-write'
    : 'read-only';
  return Buffer.from([
    `name = ${JSON.stringify(agent.name)}`,
    `description = ${JSON.stringify(agent.description)}`,
    `sandbox_mode = ${JSON.stringify(sandbox)}`,
    `developer_instructions = ${JSON.stringify(agent.instructions)}`,
    '',
  ].join('\n'));
}
function addContentOperations(selection, targets, operations, distribution) {
  const skills = distribution === 'plugin-overlay'
    ? selection.skills.filter(skill => !CORE_SKILLS.includes(skill))
    : selection.skills;
  for (const skill of skills) {
    const source = path.join(SOURCE_ROOT, 'skills', skill);
    if (targets.includes('codex')) walkSource(source, path.join('.agents', 'skills', skill), operations);
    if (targets.includes('claude')) walkSource(source, path.join('.claude', 'skills', skill), operations);
  }

  for (const agentName of selection.agents) {
    const sourcePath = path.join(SOURCE_ROOT, 'agents', `${agentName}.md`);
    if (!fs.existsSync(sourcePath)) throw new Error(`Harness agent source is missing: ${agentName}`);
    const markdown = fs.readFileSync(sourcePath);
    if (targets.includes('claude') && distribution !== 'plugin-overlay') {
      operations.push({ path: `.claude/agents/${agentName}.md`, content: markdown });
    }
    if (targets.includes('codex')) {
      const parsed = parseAgent(markdown.toString('utf8'), agentName);
      operations.push({ path: `.codex/agents/${agentName}.toml`, content: agentToml(parsed) });
    }
  }

  if (targets.includes('claude') && distribution !== 'plugin-overlay') {
    for (const workflow of WORKFLOW_SKILLS) {
      const sourcePath = path.join(SOURCE_ROOT, 'commands', `${workflow}.md`);
      if (!fs.existsSync(sourcePath)) throw new Error(`Harness command source is missing: ${workflow}`);
      operations.push({ path: `.claude/commands/${workflow}.md`, content: fs.readFileSync(sourcePath) });
    }
  }
}

function guidanceBlock(surface, distribution) {
  const workflow = distribution === 'plugin-overlay'
    ? (surface === 'codex' ? '$aster:harness-*' : '/aster:*')
    : (surface === 'codex' ? '$harness-*' : '/harness-*');
  return [
    GUIDANCE_START,
    '## Aster',
    `- Use ${workflow} workflows for start, plan, implement, verify, review, debug, finish, release, and parallel work.`,
    '- Run at most 3 independent subagents, keep depth at 1, and never overlap write ownership.',
    '- Treat .aster/memory/candidates.jsonl as pending; inject only memory approved by the user.',
    GUIDANCE_END,
    '',
  ].join('\n');
}
function ensureHookIds(hooks) {
  const result = {};
  for (const [event, entries] of Object.entries(hooks || {})) {
    if (!Array.isArray(entries)) throw new Error(`Hook event ${event} must be an array`);
    result[event] = entries.map((entry, index) => ({
      ...entry,
      id: entry.id || `aster:${event.toLowerCase()}:${index + 1}`,
    }));
  }
  return result;
}
function hookSource() {
  const configPath = path.join(SOURCE_ROOT, 'hooks', 'aster-hooks.json');
  const runnerDir = path.join(SOURCE_ROOT, 'scripts', 'aster-hooks');
  if (!fs.existsSync(configPath) || !fs.existsSync(runnerDir)) {
    throw new Error('Balanced hook sources are missing from this package');
  }
  const source = readJson(configPath, 'aster hook config');
  return { hooks: ensureHookIds(source.hooks), runnerDir };
}
function hooksForTarget(hooks, target) {
  const selected = jsonClone(hooks);
  if (target !== 'claude' || !Array.isArray(selected.Stop)) return selected;
  selected.SessionEnd = selected.Stop.map((entry, index) => ({
    ...entry,
    id: `aster:sessionend:${index + 1}`,
    hooks: entry.hooks.map(handler => ({
      ...handler,
      command: typeof handler.command === 'string'
        ? handler.command.replace(/ Stop$/, ' SessionEnd')
        : handler.command,
    })),
  }));
  delete selected.Stop;
  return selected;
}
function removeExactBlock(content, block) {
  const index = content.indexOf(block);
  if (index < 0) return null;
  return `${content.slice(0, index)}${content.slice(index + block.length)}`;
}
function codexConfigBlock(content, config) {
  const cleaned = content.replace(new RegExp(`${CODEX_MARKER_START}[\\s\\S]*?${CODEX_MARKER_END}\\r?\\n?`, 'g'), '');
  const lines = cleaned.split(/\r?\n/);
  const sectionIndex = lines.findIndex(line => /^\s*\[agents\]\s*$/.test(line));
  let sectionEnd = lines.length;
  if (sectionIndex >= 0) {
    for (let index = sectionIndex + 1; index < lines.length; index += 1) {
      if (/^\s*\[.+\]\s*$/.test(lines[index])) { sectionEnd = index; break; }
    }
  }
  const section = sectionIndex >= 0 ? lines.slice(sectionIndex + 1, sectionEnd).join('\n') : '';
  const values = [];
  if (!/^\s*max_threads\s*=/m.test(section)) values.push(`max_threads = ${config.agents.maxThreads}`);
  if (!/^\s*max_depth\s*=/m.test(section)) values.push(`max_depth = ${config.agents.maxDepth}`);
  if (values.length === 0) return { content: cleaned, block: null };
  const blockLines = [CODEX_MARKER_START];
  if (sectionIndex < 0) blockLines.push('[agents]');
  blockLines.push(...values, CODEX_MARKER_END);
  const block = `${blockLines.join('\n')}\n`;
  if (sectionIndex < 0) {
    const prefix = cleaned && !cleaned.endsWith('\n') ? `${cleaned}\n` : cleaned;
    return { content: `${prefix}${prefix ? '\n' : ''}${block}`, block };
  }
  lines.splice(sectionEnd, 0, ...block.trimEnd().split('\n'));
  return { content: lines.join('\n'), block };
}
function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
function planJsonFragment(projectRoot, relativePath, desiredHooks, priorFragment, force) {
  const filePath = safePath(projectRoot, relativePath);
  const existed = fs.existsSync(filePath);
  const document = existed ? readJson(filePath, 'hook settings') : {};
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`Hook settings must contain an object: ${filePath}`);
  }
  const next = jsonClone(document);
  const hasHooks = Object.prototype.hasOwnProperty.call(next, 'hooks');
  if (hasHooks && (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks))) {
    throw new Error(`Hook settings "hooks" must contain an object: ${filePath}`);
  }
  next.hooks = hasHooks ? next.hooks : {};
  for (const [event, entries] of Object.entries(next.hooks)) {
    if (!Array.isArray(entries)) {
      throw new Error(`Hook settings event "${event}" must contain an array: ${filePath}`);
    }
  }
  const conflicts = [];

  for (const [event, oldEntries] of Object.entries(priorFragment?.hooks || {})) {
    const currentEntries = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    for (const oldEntry of oldEntries) {
      const index = currentEntries.findIndex(entry => entry.id === oldEntry.id);
      if (index >= 0 && !deepEqual(currentEntries[index], oldEntry) && !force) {
        conflicts.push({ path: relativePath, reason: `managed hook ${oldEntry.id} was modified` });
      } else if (index >= 0) {
        currentEntries.splice(index, 1);
      }
    }
    next.hooks[event] = currentEntries;
  }

  for (const [event, entries] of Object.entries(desiredHooks)) {
    const currentEntries = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    for (const entry of entries) {
      const index = currentEntries.findIndex(current => current.id === entry.id);
      if (index >= 0 && !deepEqual(currentEntries[index], entry) && !force) {
        conflicts.push({ path: relativePath, reason: `hook id ${entry.id} already exists` });
      } else if (index >= 0) {
        currentEntries[index] = entry;
      } else {
        currentEntries.push(entry);
      }
    }
    next.hooks[event] = currentEntries;
  }
  for (const [event, entries] of Object.entries(next.hooks)) {
    if (Array.isArray(entries) && entries.length === 0) delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;

  return {
    path: relativePath,
    hooks: desiredHooks,
    content: Buffer.from(`${JSON.stringify(next, null, 2)}\n`),
    createdFile: priorFragment?.createdFile ?? !existed,
    conflicts,
  };
}
function planTextFragment(projectRoot, relativePath, build, priorFragment, force = false) {
  const filePath = safePath(projectRoot, relativePath);
  const existed = fs.existsSync(filePath);
  let content = existed ? fs.readFileSync(filePath, 'utf8') : '';
  const conflicts = [];
  if (priorFragment?.block) {
    const removed = removeExactBlock(content, priorFragment.block);
    if (removed !== null) {
      content = removed;
    } else {
      const markers = priorFragment.block.trimEnd().split(/\r?\n/);
      const start = markers[0];
      const end = markers[markers.length - 1];
      const hasManagedMarker = content.includes(start) || content.includes(end);
      if (hasManagedMarker && !force) {
        conflicts.push({ path: relativePath, reason: 'managed configuration block was modified' });
      } else if (hasManagedMarker) {
        const startIndex = content.indexOf(start);
        const endIndex = content.indexOf(end, Math.max(0, startIndex));
        if (startIndex >= 0 && endIndex >= startIndex) {
          const after = endIndex + end.length;
          content = `${content.slice(0, startIndex)}${content.slice(after).replace(/^\r?\n/, '')}`;
        }
      }
    }
  }
  const built = build(content);
  return {
    path: relativePath,
    block: built.block,
    content: Buffer.from(built.content),
    createdFile: priorFragment?.createdFile ?? !existed,
    conflicts,
  };
}
function previousByPath(entries = []) {
  return new Map(entries.map(entry => [entry.path, entry]));
}
function buildPlan(projectRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const previous = loadState(root, options.requireState === true);
  const { config, exists: configExists, seedContent } = loadConfig(root, options);
  const targets = targetNames(config.target);
  const selection = selectContent(root, {
    stacks: config.stacks === 'auto' ? undefined : config.stacks,
    with: config.with,
    without: config.without,
  });
  const operations = [];
  addContentOperations(selection, targets, operations, config.distribution);

  const recordsSource = path.join(SOURCE_ROOT, 'scripts', 'lib', 'aster', 'records.js');
  operations.push({
    path: '.aster/scripts/aster/records.js',
    content: fs.readFileSync(recordsSource),
  });

  const previousFiles = previousByPath(previous?.files);
  const previousJson = previousByPath(previous?.jsonFragments);
  const previousText = previousByPath(previous?.textFragments);
  const editableFiles = [...(previous?.editableFiles || [])];
  if (!configExists) {
    operations.push({ path: 'aster.json', content: seedContent, editable: true });
  }

  const jsonFragments = [];
  const textFragments = [];
  const cleanupJsonFragments = [];
  const cleanupTextFragments = [];
  const fragmentConflicts = [];
  if (config.hooks === 'balanced' && config.distribution === 'project') {
    const source = hookSource();
    walkSource(source.runnerDir, path.join('.aster', 'scripts', 'aster-hooks'), operations);
    if (targets.includes('claude')) {
      const fragment = planJsonFragment(root, '.claude/settings.json', hooksForTarget(source.hooks, 'claude'), previousJson.get('.claude/settings.json'), options.force);
      jsonFragments.push(fragment);
      fragmentConflicts.push(...fragment.conflicts);
    }
    if (targets.includes('codex')) {
      const fragment = planJsonFragment(root, '.codex/hooks.json', hooksForTarget(source.hooks, 'codex'), previousJson.get('.codex/hooks.json'), options.force);
      jsonFragments.push(fragment);
      fragmentConflicts.push(...fragment.conflicts);
    }
  }
  if (targets.includes('codex')) {
    textFragments.push(planTextFragment(
      root,
      '.codex/config.toml',
      content => codexConfigBlock(content, config),
      previousText.get('.codex/config.toml'),
      options.force
    ));
  }
  for (const [surface, relativePath] of [['codex', 'AGENTS.md'], ['claude', 'CLAUDE.md']]) {
    if (!targets.includes(surface)) continue;
    const block = guidanceBlock(surface, config.distribution);
    textFragments.push(planTextFragment(root, relativePath, content => {
      const cleaned = content.replace(new RegExp(`${GUIDANCE_START}[\\s\\S]*?${GUIDANCE_END}\\r?\\n?`, 'g'), '');
      const prefix = cleaned && !cleaned.endsWith('\n') ? `${cleaned}\n` : cleaned;
      return { content: `${prefix}${prefix ? '\n' : ''}${block}`, block };
    }, previousText.get(relativePath), options.force));
  }
  const gitignorePath = path.join(root, '.gitignore');
  const currentGitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const priorGitignore = previousText.get('.gitignore');
  if (priorGitignore || !/^\.aster\/?\s*$/m.test(currentGitignore)) {
    textFragments.push(planTextFragment(root, '.gitignore', content => {
      const prefix = content && !content.endsWith('\n') ? `${content}\n` : content;
      return { content: `${prefix}${GITIGNORE_BLOCK}`, block: GITIGNORE_BLOCK };
    }, priorGitignore, options.force));
  }

  const desiredJsonPaths = new Set(jsonFragments.map(fragment => fragment.path));
  for (const prior of previous?.jsonFragments || []) {
    if (desiredJsonPaths.has(prior.path)) continue;
    const fragment = planJsonFragment(root, prior.path, {}, prior, options.force);
    fragment.remove = true;
    cleanupJsonFragments.push(fragment);
    fragmentConflicts.push(...fragment.conflicts);
  }
  const desiredTextPaths = new Set(textFragments.map(fragment => fragment.path));
  for (const prior of previous?.textFragments || []) {
    if (desiredTextPaths.has(prior.path)) continue;
    const fragment = planTextFragment(root, prior.path, content => ({ content, block: null }), prior, options.force);
    fragment.remove = true;
    cleanupTextFragments.push(fragment);
    fragmentConflicts.push(...fragment.conflicts);
  }
  for (const fragment of textFragments) fragmentConflicts.push(...fragment.conflicts);

  const desired = new Map();
  for (const operation of operations) {
    safePath(root, operation.path);
    if (desired.has(operation.path)) throw new Error(`Duplicate managed path: ${operation.path}`);
    desired.set(operation.path, { ...operation, hash: hash(operation.content) });
  }
  const conflicts = [...fragmentConflicts];
  for (const operation of desired.values()) {
    const filePath = safePath(root, operation.path);
    const prior = previousFiles.get(operation.path);
    if (!fs.existsSync(filePath)) continue;
    const currentHash = hash(fs.readFileSync(filePath));
    if (!prior && currentHash !== operation.hash && !operation.editable && !options.force) {
      conflicts.push({ path: operation.path, reason: 'unmanaged file already exists' });
    } else if (prior && currentHash !== prior.hash && currentHash !== operation.hash && !options.force) {
      conflicts.push({ path: operation.path, reason: 'managed file was modified' });
    }
  }
  for (const prior of previous?.files || []) {
    if (desired.has(prior.path)) continue;
    const filePath = safePath(root, prior.path);
    if (fs.existsSync(filePath) && hash(fs.readFileSync(filePath)) !== prior.hash && !options.force) {
      conflicts.push({ path: prior.path, reason: 'obsolete managed file was modified' });
    }
  }

  const nextEditable = [...editableFiles];
  for (const operation of desired.values()) {
    if (operation.editable && !nextEditable.some(entry => entry.path === operation.path)) {
      nextEditable.push({ path: operation.path, hash: operation.hash });
    }
  }
  return {
    root,
    previous,
    config,
    target: config.target,
    selection,
    operations: [...desired.values()],
    jsonFragments,
    textFragments: textFragments.filter(fragment => fragment.block),
    cleanupJsonFragments,
    cleanupTextFragments,
    editableFiles: nextEditable,
    conflicts,
  };
}
function publicPlan(plan, command, dryRun) {
  const previous = previousByPath(plan.previous?.files);
  const files = new Map();
  const addFile = (filePath, action) => {
    if (!files.has(filePath)) files.set(filePath, { path: filePath, action });
  };
  const describeFragment = fragment => {
    const filePath = safePath(plan.root, fragment.path);
    const exists = fs.existsSync(filePath);
    if (!exists) return fragment.remove ? 'unchanged' : 'create';
    if (fs.readFileSync(filePath).equals(fragment.content)) return 'unchanged';
    if (fragment.remove && fragment.createdFile) {
      const text = fragment.content.toString('utf8');
      const empty = fragment.path.endsWith('.json')
        ? Object.keys(JSON.parse(text)).length === 0
        : text.trim() === '';
      if (empty) return 'remove';
    }
    return 'update';
  };
  for (const operation of plan.operations) {
    const filePath = safePath(plan.root, operation.path);
    const prior = previous.get(operation.path);
    let action = 'create';
    if (fs.existsSync(filePath)) action = hash(fs.readFileSync(filePath)) === operation.hash ? 'unchanged' : 'update';
    if (prior && !fs.existsSync(filePath)) action = 'restore';
    addFile(operation.path, action);
  }
  for (const fragment of [
    ...plan.jsonFragments,
    ...plan.textFragments,
    ...plan.cleanupJsonFragments,
    ...plan.cleanupTextFragments,
  ]) {
    addFile(fragment.path, describeFragment(fragment));
  }
  return {
    ok: plan.conflicts.length === 0,
    command,
    dryRun,
    target: plan.target,
    distribution: plan.config.distribution,
    detectedStacks: plan.selection.detectedStacks,
    stacks: plan.selection.stacks,
    skills: plan.selection.skills,
    agents: plan.selection.agents,
    files: [...files.values()],
    conflicts: plan.conflicts,
  };
}
function statesEqual(previous, next) {
  if (!previous) return false;
  const omitTime = value => {
    const copy = jsonClone(value);
    delete copy.installedAt;
    delete copy.updatedAt;
    return copy;
  };
  return deepEqual(omitTime(previous), omitTime(next));
}
function applyPlan(plan, command, options = {}) {
  const output = publicPlan(plan, command, options.dryRun === true);
  if (plan.conflicts.length > 0 || options.dryRun) return output;
  const desiredPaths = new Set(plan.operations.map(operation => operation.path));
  const editablePaths = new Set(plan.editableFiles.map(entry => entry.path));
  let changed = false;

  for (const prior of plan.previous?.files || []) {
    if (desiredPaths.has(prior.path)) continue;
    const filePath = safePath(plan.root, prior.path);
    if (!fs.existsSync(filePath)) continue;
    fs.rmSync(filePath, { force: true });
    removeEmptyParents(filePath, plan.root);
    changed = true;
  }
  for (const operation of plan.operations) {
    const filePath = safePath(plan.root, operation.path);
    if (operation.editable && fs.existsSync(filePath)) continue;
    const unchanged = fs.existsSync(filePath) && hash(fs.readFileSync(filePath)) === operation.hash;
    if (!unchanged) {
      writeFile(filePath, operation.content, operation.mode);
      changed = true;
    }
  }
  for (const fragment of [
    ...plan.jsonFragments,
    ...plan.textFragments,
    ...plan.cleanupJsonFragments,
    ...plan.cleanupTextFragments,
  ]) {
    const filePath = safePath(plan.root, fragment.path);
    const unchanged = fs.existsSync(filePath) && fs.readFileSync(filePath).equals(fragment.content);
    if (!unchanged) {
      let removeFile = false;
      if (fragment.remove && fragment.createdFile) {
        if (fragment.path.endsWith('.json')) {
          removeFile = Object.keys(JSON.parse(fragment.content.toString('utf8'))).length === 0;
        } else {
          removeFile = fragment.content.toString('utf8').trim() === '';
        }
      }
      if (removeFile) {
        fs.rmSync(filePath, { force: true });
        removeEmptyParents(filePath, plan.root);
      } else {
        writeFile(filePath, fragment.content);
      }
      changed = true;
    }
  }

  const now = new Date().toISOString();
  const nextState = {
    version: STATE_VERSION,
    installedAt: plan.previous?.installedAt || now,
    updatedAt: now,
    target: plan.target,
    config: plan.config,
    selection: plan.selection,
    files: plan.operations
      .filter(operation => !editablePaths.has(operation.path))
      .map(operation => ({ path: operation.path, hash: operation.hash }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    editableFiles: plan.editableFiles,
    jsonFragments: plan.jsonFragments.map(({ path: filePath, hooks, createdFile }) => ({ path: filePath, hooks, createdFile })),
    textFragments: plan.textFragments.map(({ path: filePath, block, createdFile }) => ({ path: filePath, block, createdFile })),
  };
  if (statesEqual(plan.previous, nextState)) {
    nextState.updatedAt = plan.previous.updatedAt;
  } else {
    changed = true;
  }
  if (changed || !plan.previous) {
    writeFile(safePath(plan.root, STATE_PATH), Buffer.from(`${JSON.stringify(nextState, null, 2)}\n`));
  }
  output.changed = changed;
  return output;
}
function install(projectRoot, command, options = {}) {
  const plan = buildPlan(projectRoot, { ...options, requireState: command === 'update' });
  return applyPlan(plan, command, options);
}
function plan(projectRoot, options = {}) {
  const installPlan = buildPlan(projectRoot, options);
  return publicPlan(installPlan, 'plan', true);
}
function doctor(projectRoot) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const issues = [];
  let state;
  try {
    state = loadState(root, true);
    loadConfig(root);
  } catch (error) {
    return { healthy: false, issues: [{ path: null, reason: error.message }] };
  }

  for (const entry of state.files) {
    const filePath = safePath(root, entry.path);
    if (!fs.existsSync(filePath)) {
      issues.push({ path: entry.path, reason: 'missing managed file' });
    } else if (hash(fs.readFileSync(filePath)) !== entry.hash) {
      issues.push({ path: entry.path, reason: 'managed file was modified' });
    }
  }
  for (const entry of state.editableFiles || []) {
    if (!fs.existsSync(safePath(root, entry.path))) {
      issues.push({ path: entry.path, reason: 'missing project config' });
    }
  }
  for (const fragment of state.jsonFragments || []) {
    const filePath = safePath(root, fragment.path);
    if (!fs.existsSync(filePath)) {
      issues.push({ path: fragment.path, reason: 'missing hook settings' });
      continue;
    }
    let document;
    try {
      document = readJson(filePath, 'hook settings');
    } catch (error) {
      issues.push({ path: fragment.path, reason: error.message });
      continue;
    }
    for (const [event, entries] of Object.entries(fragment.hooks)) {
      const current = document.hooks?.[event] || [];
      for (const entry of entries) {
        const found = current.find(candidate => candidate.id === entry.id);
        if (!found) issues.push({ path: fragment.path, reason: `missing managed hook ${entry.id}` });
        else if (!deepEqual(found, entry)) issues.push({ path: fragment.path, reason: `managed hook ${entry.id} was modified` });
      }
    }
  }
  for (const fragment of state.textFragments || []) {
    const filePath = safePath(root, fragment.path);
    if (!fs.existsSync(filePath) || !fs.readFileSync(filePath, 'utf8').includes(fragment.block)) {
      issues.push({ path: fragment.path, reason: 'managed configuration block is missing or modified' });
    }
  }
  return { healthy: issues.length === 0, target: state.target, selection: state.selection, issues };
}
function removeJsonFragment(projectRoot, fragment, outcome, dryRun) {
  const { preserved, removed, updated } = outcome;
  const filePath = safePath(projectRoot, fragment.path);
  if (!fs.existsSync(filePath)) return;
  let document;
  try {
    document = readJson(filePath, 'hook settings');
  } catch {
    preserved.push(fragment.path);
    return;
  }
  let changed = false;
  for (const [event, entries] of Object.entries(fragment.hooks || {})) {
    const current = Array.isArray(document.hooks?.[event]) ? document.hooks[event] : [];
    for (const entry of entries) {
      const index = current.findIndex(candidate => candidate.id === entry.id);
      if (index >= 0 && deepEqual(current[index], entry)) {
        current.splice(index, 1);
        changed = true;
      } else if (index >= 0) {
        preserved.push(`${fragment.path}#${entry.id}`);
      }
    }
    if (current.length === 0) delete document.hooks?.[event];
  }
  if (document.hooks && Object.keys(document.hooks).length === 0) delete document.hooks;
  if (!changed) return;
  if (fragment.createdFile && Object.keys(document).length === 0) {
    if (!dryRun) {
      fs.rmSync(filePath, { force: true });
      removeEmptyParents(filePath, projectRoot);
    }
    removed.push(fragment.path);
  } else {
    if (!dryRun) writeFile(filePath, Buffer.from(`${JSON.stringify(document, null, 2)}\n`));
    updated.push(fragment.path);
  }
}
function hasNonEmptyFile(root) {
  if (!fs.existsSync(root)) return false;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && fs.statSync(fullPath).size > 0) return true;
    }
  }
  return false;
}
function hasUserHarnessData(projectRoot) {
  return [
    safePath(projectRoot, '.aster/memory'),
    safePath(projectRoot, '.aster/state'),
  ].some(hasNonEmptyFile);
}
function uninstall(projectRoot, options = {}) {
  const root = fs.realpathSync(path.resolve(projectRoot));
  const state = loadState(root, true);
  const removed = [];
  const updated = [];
  const preserved = [];

  for (const entry of state.files) {
    const filePath = safePath(root, entry.path);
    if (!fs.existsSync(filePath)) continue;
    if (hash(fs.readFileSync(filePath)) !== entry.hash) {
      preserved.push(entry.path);
      continue;
    }
    if (!options.dryRun) {
      fs.rmSync(filePath, { force: true });
      removeEmptyParents(filePath, root);
    }
    removed.push(entry.path);
  }
  for (const entry of state.editableFiles || []) {
    const filePath = safePath(root, entry.path);
    if (!fs.existsSync(filePath)) continue;
    if (hash(fs.readFileSync(filePath)) !== entry.hash) {
      preserved.push(entry.path);
      continue;
    }
    if (!options.dryRun) {
      fs.rmSync(filePath, { force: true });
      removeEmptyParents(filePath, root);
    }
    removed.push(entry.path);
  }
  const dryRun = options.dryRun === true;
  const outcome = { removed, updated, preserved };
  for (const fragment of state.jsonFragments || []) removeJsonFragment(root, fragment, outcome, dryRun);
  for (const fragment of state.textFragments || []) {
    if (fragment.path === '.gitignore' && hasUserHarnessData(root)) {
      preserved.push('.gitignore#aster-data');
      continue;
    }
    const filePath = safePath(root, fragment.path);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    const next = removeExactBlock(content, fragment.block);
    if (next === null) {
      preserved.push(fragment.path);
    } else if (fragment.createdFile && next.trim() === '') {
      if (!dryRun) {
        fs.rmSync(filePath, { force: true });
        removeEmptyParents(filePath, root);
      }
      removed.push(fragment.path);
    } else {
      if (!dryRun) writeFile(filePath, Buffer.from(next));
      updated.push(fragment.path);
    }
  }
  if (!dryRun) {
    const statePath = safePath(root, STATE_PATH);
    fs.rmSync(statePath, { force: true });
    removeEmptyParents(statePath, root);
  }
  return { ok: true, dryRun, removed, updated, preserved };
}
function listMemory(projectRoot) {
  loadState(projectRoot, true);
  return memory.listMemory(projectRoot);
}
function decideMemory(projectRoot, action, rawId, options = {}) {
  loadState(projectRoot, true);
  return memory.decideMemory(projectRoot, action, rawId, options);
}

module.exports = {
  DEFAULT_CONFIG,
  assertProjectTestIsolation,
  buildPlan,
  decideMemory,
  doctor,
  install,
  listMemory,
  plan,
  ...records,
  uninstall,
};
