#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { frontendWarning, runQuality } = require('./quality');

const MEMORY_LIMIT = 8000;
const TASK_LIMIT = 1000;
const SNAPSHOT_CONTEXT_LIMIT = 700;
const OUTPUT_LIMIT = 10000;
const INPUT_LIMIT = 1024 * 1024;
const STATE_ITEMS_LIMIT = 30;
const CANDIDATE_LIMIT = 1200;
const KNOWN_EVENTS = new Set([
  'SessionStart',
  'PreCompact',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
]);

function now() {
  return new Date().toISOString();
}

function trimText(value, limit) {
  const text = typeof value === 'string' ? value : '';
  const boundedLimit = Math.max(0, Number(limit) || 0);
  if (text.length <= boundedLimit) return text;
  if (boundedLimit <= 3) return text.slice(0, boundedLimit);
  return `${text.slice(0, boundedLimit - 3)}...`;
}

function redact(value) {
  return String(value || '')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_-]{8,}\b/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function sanitizeSessionId(value) {
  return trimText(String(value || 'default').replace(/[^A-Za-z0-9._-]/g, '-'), 80) || 'default';
}

function firstNumber(values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function contextRemaining(raw) {
  const context = raw.context || raw.context_usage || raw.contextUsage || {};
  const window = raw.context_window || raw.contextWindow || {};
  const remaining = firstNumber([
    raw.context_remaining_pct,
    raw.contextRemainingPct,
    context.remaining_pct,
    context.remaining_percent,
    window.remaining_pct,
    window.remaining_percent,
  ]);
  if (remaining !== null) return Math.max(0, Math.min(100, remaining));

  const used = firstNumber([
    raw.context_used_pct,
    raw.contextUsedPct,
    context.used_pct,
    context.used_percent,
    window.used_pct,
    window.used_percent,
  ]);
  if (used !== null) return Math.max(0, Math.min(100, 100 - used));

  const usedTokens = firstNumber([window.used_tokens, window.usedTokens]);
  const maxTokens = firstNumber([window.max_tokens, window.maxTokens]);
  if (usedTokens !== null && maxTokens > 0) {
    return Math.max(0, Math.min(100, 100 - (usedTokens / maxTokens) * 100));
  }
  return null;
}

function normalizeInput(raw, forcedEvent, env = process.env) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const tool = input.tool && typeof input.tool === 'object' ? input.tool : {};
  const cwdValue = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd : process.cwd();
  const event = forcedEvent || input.hook_event_name || input.hookEventName || env.CLAUDE_HOOK_EVENT_NAME || '';

  return {
    raw: input,
    event: String(event),
    cwd: path.resolve(cwdValue),
    sessionId: sanitizeSessionId(
      input.session_id || input.sessionId || env.CODEX_SESSION_ID || env.CLAUDE_SESSION_ID
    ),
    toolName: String(input.tool_name || input.toolName || tool.name || ''),
    toolInput: input.tool_input || input.toolInput || tool.input || {},
    toolOutput:
      input.tool_response ?? input.toolResponse ?? input.tool_output ?? input.toolOutput ?? input.result,
    contextRemainingPct: contextRemaining(input),
  };
}

function projectKey(cwd) {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

function realPath(filePath) {
  return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
}

function comparable(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathInside(root, candidate) {
  const relative = path.relative(comparable(root), comparable(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

function safeDescendant(root, candidate) {
  const resolvedRoot = resolvedPath(root);
  const resolvedCandidate = resolvedPath(candidate);
  if (!pathInside(resolvedRoot, resolvedCandidate)) return false;

  let current = path.resolve(root);
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return false;
    if (current === path.resolve(candidate) && stat.isFile() && stat.nlink > 1) return false;
  }
  return true;
}

function resolveProjectRoot(cwd, env = process.env) {
  let realCwd;
  try {
    realCwd = realPath(path.resolve(cwd));
    if (!fs.statSync(realCwd).isDirectory()) return null;
  } catch {
    return null;
  }

  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: realCwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  const reported = String(result.stdout || '').trim();
  if (result.status !== 0 || !reported) return null;

  let projectRoot;
  try {
    projectRoot = realPath(path.resolve(reported));
  } catch {
    return null;
  }
  if (!pathInside(projectRoot, realCwd)) return null;

  if (env.ASTER_TEST_MODE === 'project-isolated') {
    const testRoot = String(env.ASTER_TEST_ROOT || '').trim();
    if (!testRoot || !pathInside(resolvedPath(testRoot), projectRoot)) return null;
  }
  return projectRoot;
}

function resolvePluginDataRoot(env = process.env) {
  const configured = String(env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA || '').trim();
  if (!configured) return null;
  const root = resolvedPath(configured);
  try {
    if (fs.existsSync(configured) && fs.lstatSync(configured).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  if (env.ASTER_TEST_MODE === 'project-isolated') {
    const testRoot = String(env.ASTER_TEST_ROOT || '').trim();
    if (!testRoot || !pathInside(resolvedPath(testRoot), root)) return null;
  }
  return root;
}

function resolveDataDir(input, env = process.env) {
  const projectRoot = resolveProjectRoot(input.cwd, env);
  if (!projectRoot) return null;

  const local = path.join(projectRoot, '.aster');
  if (fs.existsSync(local)) {
    return safeDescendant(projectRoot, local) ? { root: resolvedPath(local), projectRoot } : null;
  }

  const pluginData = resolvePluginDataRoot(env);
  if (!pluginData) return null;
  const root = path.join(pluginData, 'projects', projectKey(projectRoot));
  return safeDescendant(pluginData, root) ? { root, projectRoot } : null;
}

function dataPaths(input, env = process.env) {
  const resolved = resolveDataDir(input, env);
  if (!resolved) return null;
  const { root, projectRoot } = resolved;
  const runtime = path.join(root, 'runtime');
  const paths = {
    root,
    projectRoot,
    approved: path.join(root, 'memory', 'approved.md'),
    candidates: path.join(root, 'memory', 'candidates.jsonl'),
    currentTask: path.join(root, 'state', 'current-task.json'),
    currentPlan: path.join(root, 'state', 'current-plan.md'),
    verification: path.join(root, 'state', 'verification.jsonl'),
    session: path.join(runtime, 'sessions', `${input.sessionId}.json`),
    snapshot: path.join(runtime, 'snapshots', `${input.sessionId}.json`),
    latestSnapshot: path.join(runtime, 'latest-snapshot.json'),
    costs: path.join(runtime, 'costs.jsonl'),
    mcpHealth: path.join(runtime, 'mcp-health.json'),
  };
  return Object.entries(paths)
    .filter(([name]) => name !== 'projectRoot')
    .every(([, value]) => typeof value !== 'string' || safeDescendant(root, value))
    ? paths
    : null;
}

function readText(filePath, maxChars) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(Math.max(1, maxChars * 4));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytes).toString('utf8').slice(0, maxChars);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath, 64 * 1024));
  } catch {
    return null;
  }
}

function configuredMemoryLimit(projectRoot) {
  const configPath = path.join(projectRoot, 'aster.json');
  if (!safeDescendant(projectRoot, configPath) || !fs.existsSync(configPath)) return MEMORY_LIMIT;
  const config = readJson(configPath);
  const value = config?.memory?.maxInjectedCharacters;
  return Number.isInteger(value) && value >= 1 && value <= MEMORY_LIMIT ? value : MEMORY_LIMIT;
}

const MCP_CONFIG_FILES = [
  '.mcp.json',
  '.codex/mcp.json',
  '.claude/mcp.json',
  '.claude/settings.json',
];

function mcpTarget(input) {
  const explicitServer = input.raw.server
    || input.raw.mcp_server
    || input.toolInput?.server
    || input.toolInput?.mcp_server;
  const explicitTool = input.raw.mcp_tool || input.toolInput?.mcp_tool;
  if (explicitServer) {
    return {
      server: String(explicitServer),
      tool: String(explicitTool || input.toolName || ''),
    };
  }
  if (!input.toolName.startsWith('mcp__')) return null;
  const segments = input.toolName.slice(5).split('__');
  if (segments.length < 2 || !segments[0]) return null;
  return { server: segments[0], tool: segments.slice(1).join('__') };
}

function readProjectMcpConfig(projectRoot) {
  for (const relativePath of MCP_CONFIG_FILES) {
    const filePath = path.join(projectRoot, relativePath);
    if (!fs.existsSync(filePath) || !safeDescendant(projectRoot, filePath)) continue;
    const raw = readText(filePath, 1024 * 1024);
    const optionalSettings = relativePath.endsWith('/settings.json');
    if (!raw) {
      if (optionalSettings) continue;
      return { present: true, source: relativePath, config: null, reason: 'empty or unreadable config' };
    }
    try {
      const parsed = JSON.parse(raw);
      const hasMcpServers = parsed !== null
        && typeof parsed === 'object'
        && (
          Object.prototype.hasOwnProperty.call(parsed, 'mcpServers')
          || Object.prototype.hasOwnProperty.call(parsed, 'mcp_servers')
        );
      if (optionalSettings && !hasMcpServers) continue;
      const servers = parsed?.mcpServers || parsed?.mcp_servers;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
        return { present: true, source: relativePath, config: null, reason: 'mcpServers must be an object' };
      }
      return { present: true, source: relativePath, config: servers, reason: null };
    } catch {
      if (optionalSettings) continue;
      return { present: true, source: relativePath, config: null, reason: 'invalid JSON' };
    }
  }
  return { present: false, source: null, config: null, reason: null };
}

function inspectMcpServer(serverName, serverConfig, projectRoot) {
  if (!serverConfig || typeof serverConfig !== 'object' || Array.isArray(serverConfig)) {
    return { status: 'missing', reason: `server ${serverName} is not configured` };
  }
  if (typeof serverConfig.url === 'string' || typeof serverConfig.endpoint === 'string') {
    const url = String(serverConfig.url || serverConfig.endpoint);
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URL must use HTTP(S)');
      return { status: 'configured', reason: 'HTTP endpoint configuration is valid' };
    } catch (error) {
      return { status: 'invalid', reason: `invalid endpoint: ${error.message}` };
    }
  }
  if (typeof serverConfig.command === 'string' && serverConfig.command.trim()) {
    const command = serverConfig.command.trim();
    if (path.isAbsolute(command) && !fs.existsSync(command)) {
      return { status: 'invalid', reason: 'configured command does not exist' };
    }
    if (!path.isAbsolute(command) && (command.includes('/') || command.includes('\\'))) {
      const resolved = path.resolve(projectRoot, command);
      if (!safeDescendant(projectRoot, resolved) || !fs.existsSync(resolved)) {
        return { status: 'invalid', reason: 'configured command path is outside the project or missing' };
      }
    }
    return { status: 'configured', reason: 'stdio command configuration is valid' };
  }
  return { status: 'invalid', reason: 'server needs a URL or command' };
}

function mcpHealth(input, paths) {
  const target = mcpTarget(input);
  if (!target) return '';
  const projectConfig = readProjectMcpConfig(paths.projectRoot);
  // The generic project hook is always present, but MCP work is deliberately
  // a no-op until a project-local config is found. User-level MCP settings are
  // never consulted here.
  if (!projectConfig.present) return '';

  const nowValue = now();
  const state = readJson(paths.mcpHealth) || { version: 1, servers: {} };
  state.version = 1;
  state.servers = state.servers && typeof state.servers === 'object' ? state.servers : {};
  const result = projectConfig.reason
    ? { status: 'invalid', reason: projectConfig.reason }
    : inspectMcpServer(target.server, projectConfig.config[target.server], paths.projectRoot);
  state.servers[target.server] = {
    status: result.status,
    reason: result.reason,
    source: projectConfig.source,
    checkedAt: nowValue,
  };
  writeJson(paths.mcpHealth, state);
  if (result.status === 'configured') return '';
  return `MCP configuration health: ${target.server} ${result.reason}. Continuing in fail-open mode.`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, filePath);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The original write error is the useful failure.
    }
    throw error;
  }
}

function appendJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function readState(input, paths) {
  const state = readJson(paths.session);
  return state && typeof state === 'object'
    ? state
    : {
        version: 1,
        sessionId: input.sessionId,
        cwd: input.cwd,
        toolCount: 0,
        activities: [],
        observations: [],
      };
}

function boundedState(state) {
  return {
    version: 1,
    sessionId: sanitizeSessionId(state.sessionId),
    cwd: trimText(state.cwd, 1000),
    toolCount: Math.max(0, Math.min(1000000, Number(state.toolCount) || 0)),
    lastEvent: trimText(state.lastEvent, 40),
    lastTool: trimText(state.lastTool, 120),
    contextRemainingPct: Number.isFinite(state.contextRemainingPct)
      ? Math.max(0, Math.min(100, state.contextRemainingPct))
      : null,
    lastReminderKey: trimText(state.lastReminderKey, 80),
    activities: Array.isArray(state.activities) ? state.activities.slice(-STATE_ITEMS_LIMIT) : [],
    observations: Array.isArray(state.observations) ? state.observations.slice(-STATE_ITEMS_LIMIT) : [],
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    updatedAt: now(),
  };
}

function saveState(paths, state) {
  const bounded = boundedState(state);
  writeJson(paths.session, bounded);
  return bounded;
}

function collectPaths(value, output = [], depth = 0, key = '') {
  if (depth > 4 || output.length >= 12 || value === null || value === undefined) return output;
  if (typeof value === 'string') {
    if (/^(?:file_?path|path|source_?path|destination_?path)$/i.test(key)) {
      const candidate = trimText(value, 500);
      if (candidate && !output.includes(candidate)) output.push(candidate);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, output, depth + 1, key);
    return output;
  }
  if (typeof value !== 'object') return output;
  for (const [nestedKey, nestedValue] of Object.entries(value)) {
    collectPaths(nestedValue, output, depth + 1, nestedKey);
  }
  return output;
}

function toolFailed(input) {
  const output = input.toolOutput;
  if (!output || typeof output !== 'object') return false;
  return Boolean(
    output.is_error ||
      output.isError ||
      output.error ||
      output.success === false ||
      (Number.isFinite(Number(output.exit_code)) && Number(output.exit_code) !== 0) ||
      (Number.isFinite(Number(output.exitCode)) && Number(output.exitCode) !== 0)
  );
}

function explicitCandidate(input, source) {
  const raw = input.raw;
  const toolInput = input.toolInput && typeof input.toolInput === 'object' ? input.toolInput : {};
  const values = [
    raw.memory_candidate,
    raw.memoryCandidate,
    raw.observation,
    raw.learning,
    toolInput.memory_candidate,
    toolInput.memoryCandidate,
    toolInput.observation,
    toolInput.learning,
  ];
  let content = values.find(value => typeof value === 'string' && value.trim());

  if (!content && (source === 'Stop' || source === 'SessionEnd')) {
    const assistant = raw.last_assistant_message || raw.lastAssistantMessage || '';
    if (typeof assistant === 'string') {
      content = assistant
        .split(/\r?\n/)
        .filter(line => /\b(?:learned|root cause|decision|convention|lesson)\b|(?:根因|约定|经验|决定)/i.test(line))
        .slice(0, 3)
        .join('\n');
    }
  }

  content = trimText(redact(content || '').trim(), CANDIDATE_LIMIT);
  if (!content) return null;
  const id = `cand-${crypto
    .createHash('sha256')
    .update(`${source}\0${input.sessionId}\0${content}`)
    .digest('hex')
    .slice(0, 16)}`;
  return {
    id,
    createdAt: now(),
    source,
    sessionId: input.sessionId,
    content,
    status: 'pending',
  };
}

function stackInfo(cwd) {
  const has = name => fs.existsSync(path.join(cwd, name));
  const stacks = [];
  if (has('package.json')) stacks.push('Node');
  if (has('pyproject.toml') || has('requirements.txt')) stacks.push('Python');
  if (has('go.mod')) stacks.push('Go');
  if (has('Cargo.toml')) stacks.push('Rust');
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) stacks.push('JVM');
  if (has('global.json') || fs.readdirSync(cwd, { withFileTypes: true }).some(entry => /\.sln$|\.csproj$/i.test(entry.name))) {
    stacks.push('.NET');
  }
  return stacks;
}

function failureAdvice(stacks) {
  if (stacks.includes('Node')) return 'inspect the first error, then rerun the project test/typecheck script';
  if (stacks.includes('Python')) return 'inspect the first traceback, then rerun the focused pytest target';
  if (stacks.includes('Go')) return 'inspect the first compiler error, then rerun go test ./...';
  if (stacks.includes('Rust')) return 'inspect the first compiler error, then rerun cargo test';
  if (stacks.includes('JVM')) return 'inspect the first build error, then rerun the focused Gradle/Maven test';
  if (stacks.includes('.NET')) return 'inspect the first build error, then rerun dotnet test';
  return 'inspect the first error and rerun the smallest focused check';
}

function within(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function consoleWarning(input, paths) {
  const tool = input.toolName.toLowerCase();
  if (!/(?:write|edit|apply_patch)/.test(tool)) return '';
  for (const filePath of collectPaths(input.toolInput)) {
    const absolute = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(input.cwd, filePath);
    if (!within(input.cwd, absolute) || !/\.[cm]?[jt]sx?$/i.test(absolute)) continue;
    if (/\bconsole\.log\s*\(/.test(readText(absolute, 256 * 1024))) {
      return `Non-blocking ${paths.includes('Node') ? 'Node' : 'JavaScript'} warning: ${trimText(
        path.relative(input.cwd, absolute),
        300
      )} contains console.log; remove it if it is not intentional.`;
    }
  }
  return '';
}

function contextOutput(input, message, limit = OUTPUT_LIMIT) {
  const text = trimText(message, Math.min(OUTPUT_LIMIT, Math.max(0, Number(limit) || 0)));
  if (!text) return '';
  return JSON.stringify({
    systemMessage: text,
    hookSpecificOutput: {
      hookEventName: input.event,
      additionalContext: text,
    },
  });
}

function snapshot(paths, state, reason) {
  const value = {
    ...boundedState(state),
    reason,
    snapshotAt: now(),
  };
  writeJson(paths.snapshot, value);
  writeJson(paths.latestSnapshot, value);
  return value;
}

function handleSessionStart(input, paths) {
  const state = readState(input, paths);
  state.lastEvent = 'SessionStart';
  state.startedAt = state.startedAt || now();
  saveState(paths, state);

  const memoryLimit = configuredMemoryLimit(paths.projectRoot);
  const approved = readText(paths.approved, memoryLimit).trim();
  const task = readText(paths.currentTask, TASK_LIMIT).trim();
  const previous = readText(paths.latestSnapshot, SNAPSHOT_CONTEXT_LIMIT).trim();
  const sections = [];
  if (approved) sections.push(`Approved project memory (human-reviewed):\n${approved}`);
  if (task) sections.push(`Current local task state:\n${task}`);
  if (previous) sections.push(`Recovered bounded session snapshot:\n${previous}`);
  return contextOutput(input, sections.join('\n\n'), memoryLimit);
}

function handlePreCompact(input, paths) {
  const state = readState(input, paths);
  state.lastEvent = 'PreCompact';
  snapshot(paths, state, 'pre-compact');
  saveState(paths, state);
  return '';
}

function reminderKey(state, input) {
  const remaining = input.contextRemainingPct ?? state.contextRemainingPct;
  if (remaining !== null && remaining <= 20) return 'context-critical';
  if (remaining !== null && remaining <= 30) return 'context-low';
  return state.toolCount > 0 && state.toolCount % 25 === 0 ? `tools-${state.toolCount}` : '';
}

function handlePreToolUse(input, paths) {
  const state = readState(input, paths);
  state.lastEvent = 'PreToolUse';
  state.lastTool = input.toolName;
  state.toolCount = (Number(state.toolCount) || 0) + 1;
  if (input.contextRemainingPct !== null) state.contextRemainingPct = input.contextRemainingPct;
  state.observations = [
    ...(Array.isArray(state.observations) ? state.observations : []),
    {
      at: now(),
      cwd: trimText(input.cwd, 1000),
      tool: trimText(input.toolName || 'unknown', 120),
      files: collectPaths(input.toolInput),
    },
  ].slice(-STATE_ITEMS_LIMIT);

  const candidate = explicitCandidate(input, 'PreToolUse');
  if (candidate) appendJson(paths.candidates, candidate);

  const warnings = [];
  const mcpMessage = mcpHealth(input, paths);
  if (mcpMessage) warnings.push(mcpMessage);

  const key = reminderKey(state, input);
  const shouldRemind = key && key !== state.lastReminderKey;
  if (shouldRemind) state.lastReminderKey = key;
  saveState(paths, state);

  if (shouldRemind) {
    warnings.push('Context is getting dense. Compact at the next logical boundary after preserving decisions, failures, and the next action.');
  }
  return contextOutput(input, warnings.join('\n'));
}

function handlePostToolUse(input, paths) {
  const state = readState(input, paths);
  state.lastEvent = 'PostToolUse';
  state.lastTool = input.toolName;
  if (input.contextRemainingPct !== null) state.contextRemainingPct = input.contextRemainingPct;
  state.activities = [
    ...(Array.isArray(state.activities) ? state.activities : []),
    {
      at: now(),
      cwd: trimText(input.cwd, 1000),
      tool: trimText(input.toolName || 'unknown', 120),
      files: collectPaths(input.toolInput),
      failed: toolFailed(input),
    },
  ].slice(-STATE_ITEMS_LIMIT);

  const stacks = stackInfo(input.cwd);
  const warnings = [];
  if (toolFailed(input)) warnings.push(`Non-blocking ${stacks.join('/') || 'project'} warning: ${failureAdvice(stacks)}.`);
  const consoleMessage = consoleWarning(input, stacks);
  if (consoleMessage) warnings.push(consoleMessage);
  const designMessage = frontendWarning(input.cwd, collectPaths(input.toolInput));
  if (designMessage) warnings.push(designMessage);

  const key = reminderKey(state, input);
  if (key && key !== state.lastReminderKey) {
    state.lastReminderKey = key;
    warnings.push('Context is low. Preserve the current task state and compact at the next logical boundary.');
  }
  saveState(paths, state);
  return contextOutput(input, warnings.join('\n'));
}

function costEvidence(input) {
  const raw = input.raw;
  const costObject = raw.cost && typeof raw.cost === 'object' ? raw.cost : {};
  const suppliedCost = firstNumber([
    costObject.total_cost_usd,
    costObject.totalCostUsd,
    typeof raw.cost === 'number' ? raw.cost : undefined,
    raw.total_cost_usd,
    raw.totalCostUsd,
    raw.cost_usd,
    raw.costUsd,
  ]);
  const cost = suppliedCost !== null && suppliedCost >= 0 ? suppliedCost : null;
  const usageSource = raw.usage || costObject.usage;
  const usage = {};
  if (usageSource && typeof usageSource === 'object') {
    for (const key of [
      'input_tokens',
      'output_tokens',
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
      'inputTokens',
      'outputTokens',
    ]) {
      const value = Number(usageSource[key]);
      if (Number.isFinite(value) && value >= 0) usage[key] = value;
    }
  }
  if (cost === null && Object.keys(usage).length === 0) return null;
  return {
    createdAt: now(),
    sessionId: input.sessionId,
    model: trimText(String(raw.model || ''), 160),
    ...(cost === null ? {} : { costUsd: Math.max(0, cost) }),
    ...(Object.keys(usage).length === 0 ? {} : { usage }),
  };
}

function handleStop(input, paths) {
  const event = input.event === 'SessionEnd' ? 'SessionEnd' : 'Stop';
  const state = readState(input, paths);
  state.lastEvent = event;
  state.stoppedAt = now();
  snapshot(paths, state, event === 'SessionEnd' ? 'session-end' : 'stop');
  saveState(paths, state);

  const candidate = explicitCandidate(input, event);
  if (candidate) appendJson(paths.candidates, candidate);
  const cost = costEvidence(input);
  if (cost) appendJson(paths.costs, cost);
  const quality = runQuality(paths.projectRoot, state);
  return event === 'SessionEnd' ? '' : contextOutput(input, quality);
}

function run(rawInput, forcedEvent, env = process.env) {
  try {
    const raw = typeof rawInput === 'string' && rawInput.trim() ? JSON.parse(rawInput) : {};
    const input = normalizeInput(raw, forcedEvent, env);
    if (!KNOWN_EVENTS.has(input.event)) return '';
    const paths = dataPaths(input, env);
    if (!paths) return '';
    if (input.event === 'SessionStart') return handleSessionStart(input, paths);
    if (input.event === 'PreCompact') return handlePreCompact(input, paths);
    if (input.event === 'PreToolUse') return handlePreToolUse(input, paths);
    if (input.event === 'PostToolUse') return handlePostToolUse(input, paths);
    return handleStop(input, paths);
  } catch (error) {
    if (/^(?:1|true|yes)$/i.test(String(env.ASTER_HOOK_DEBUG || ''))) {
      process.stderr.write(`[aster hook] ${trimText(error.message, 500)}\n`);
    }
    return '';
  }
}

function main(forcedEvent = process.argv[2]) {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8').slice(0, INPUT_LIMIT);
  } catch {
    // Empty input is a valid fail-open hook invocation.
  }
  const output = run(raw, forcedEvent);
  if (output) process.stdout.write(output);
}

if (require.main === module) main();

module.exports = {
  MEMORY_LIMIT,
  costEvidence,
  dataPaths,
  configuredMemoryLimit,
  mcpHealth,
  normalizeInput,
  resolveProjectRoot,
  projectKey,
  resolveDataDir,
  run,
  main,
};
