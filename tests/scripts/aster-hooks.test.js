'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..', '..');
const runner = path.join(repoRoot, 'scripts', 'aster-hooks', 'runner.js');
const configPath = path.join(repoRoot, 'hooks', 'aster-hooks.json');
const { requireHarnessTestIsolation } = require('../../scripts/lib/aster/test-isolation');

const isolation = requireHarnessTestIsolation(repoRoot);

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function runHook(event, input, cwd, env = {}) {
  const home = path.join(cwd, '.test-home');
  fs.mkdirSync(home, { recursive: true });
  return spawnSync(process.execPath, [runner, event], {
    cwd,
    encoding: 'utf8',
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: '',
      PLUGIN_ROOT: '',
      PLUGIN_DATA: '',
      CLAUDE_PLUGIN_ROOT: '',
      CLAUDE_PLUGIN_DATA: '',
      ...env,
    },
    timeout: 10000,
  });
}

function assertOk(result) {
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
}

function runTests() {
  const fixtureRoot = path.join(isolation.testRoot, 'fixtures');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(fixtureRoot, 'aster-hooks-'));
  const project = path.join(temp, 'project');
  const data = path.join(project, '.aster');
  fs.mkdirSync(project, { recursive: true });
  const initialized = spawnSync('git', ['init', '--quiet'], {
    cwd: project,
    env: process.env,
    encoding: 'utf8',
  });
  assertOk(initialized);

  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(Object.keys(config.hooks), [
      'SessionStart',
      'PreCompact',
      'PreToolUse',
      'PostToolUse',
      'Stop',
    ]);
    const handlers = Object.values(config.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
    assert.ok(handlers.every(handler => handler.type === 'command' && !('async' in handler)));
    assert.ok(handlers.every(handler => handler.command.includes('PLUGIN_ROOT')));
    assert.ok(handlers.every(handler => handler.command.includes('CLAUDE_PLUGIN_ROOT')));
    assert.doesNotMatch(
      JSON.stringify(config),
      /auto-tmux|gateguard|config-protection|desktop-notify|quality-gate/i
    );

    write(path.join(data, 'memory', 'approved.md'), `APPROVED_MEMORY\n${'a'.repeat(7990)}UNAPPROVED_TAIL`);
    write(
      path.join(data, 'memory', 'candidates.jsonl'),
      `${JSON.stringify({ id: 'pending', content: 'PENDING_ONLY_SENTINEL', status: 'pending' })}\n`
    );
    write(
      path.join(data, 'state', 'current-task.json'),
      `${JSON.stringify({ id: 'HARNESS-03', next: 'run focused hook fixtures' })}\n`
    );
    write(path.join(data, 'state', 'current-plan.md'), 'UNAPPROVED_PLAN_SENTINEL\n');

    const start = runHook(
      'SessionStart',
      { session_id: 'claude-session', cwd: project, hook_event_name: 'SessionStart' },
      project,
      { CLAUDE_PLUGIN_ROOT: repoRoot }
    );
    assertOk(start);
    const startOutput = JSON.parse(start.stdout);
    const context = startOutput.hookSpecificOutput.additionalContext;
    assert.strictEqual(startOutput.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(context, /APPROVED_MEMORY/);
    assert.doesNotMatch(context, /PENDING_ONLY_SENTINEL|UNAPPROVED_TAIL/);
    assert.ok(context.length <= 8000, `Session context was ${context.length} characters`);

    write(
      path.join(project, 'aster.json'),
      `${JSON.stringify({ memory: { maxInjectedCharacters: 1200 } })}\n`
    );
    write(path.join(data, 'memory', 'approved.md'), `APPROVED_SMALL\n${'b'.repeat(2000)}SMALL_TAIL`);
    const boundedStart = runHook(
      'SessionStart',
      { session_id: 'bounded-session', cwd: project },
      project,
      { CLAUDE_PLUGIN_ROOT: repoRoot }
    );
    assertOk(boundedStart);
    const boundedContext = JSON.parse(boundedStart.stdout).hookSpecificOutput.additionalContext;
    assert.match(boundedContext, /APPROVED_SMALL/);
    assert.doesNotMatch(boundedContext, /SMALL_TAIL|PENDING_ONLY_SENTINEL/);
    assert.ok(boundedContext.length <= 1200, `Configured session context was ${boundedContext.length} characters`);

    write(path.join(project, 'aster.json'), '{invalid-json');
    write(path.join(data, 'memory', 'approved.md'), `APPROVED_FALLBACK\n${'c'.repeat(8100)}FALLBACK_TAIL`);
    const fallbackStart = runHook(
      'SessionStart',
      { session_id: 'fallback-session', cwd: project },
      project,
      { CLAUDE_PLUGIN_ROOT: repoRoot }
    );
    assertOk(fallbackStart);
    const fallbackContext = JSON.parse(fallbackStart.stdout).hookSpecificOutput.additionalContext;
    assert.ok(fallbackContext.length > 1200 && fallbackContext.length <= 8000);
    assert.doesNotMatch(fallbackContext, /FALLBACK_TAIL|PENDING_ONLY_SENTINEL/);

    write(
      path.join(project, 'aster.json'),
      `${JSON.stringify({ memory: { approvalRequired: true, maxInjectedCharacters: 8000 } })}\n`
    );
    write(path.join(data, 'memory', 'approved.md'), 'APPROVED_MEMORY\nKeep project tests isolated.\n');
    const recordIsolationStart = runHook(
      'SessionStart',
      { session_id: 'record-isolation', cwd: project },
      project,
      { CLAUDE_PLUGIN_ROOT: repoRoot }
    );
    assertOk(recordIsolationStart);
    const recordIsolationContext = JSON.parse(recordIsolationStart.stdout).hookSpecificOutput.additionalContext;
    assert.match(recordIsolationContext, /APPROVED_MEMORY/);
    assert.match(recordIsolationContext, /HARNESS-03/);
    assert.doesNotMatch(recordIsolationContext, /UNAPPROVED_PLAN_SENTINEL/);
    write(path.join(data, 'memory', 'approved.md'), `APPROVED_MEMORY\n${'a'.repeat(7990)}UNAPPROVED_TAIL`);

    const pre = runHook(
      'PreToolUse',
      {
        sessionId: 'codex-session',
        cwd: project,
        hookEventName: 'PreToolUse',
        turnId: 'turn-1',
        toolName: 'apply_patch',
        toolInput: {
          filePath: 'src/app.js',
          memoryCandidate: 'Project convention: token=super-secret-value is never stored.',
        },
        contextRemainingPct: 19,
      },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(pre);
    const preOutput = JSON.parse(pre.stdout);
    assert.match(preOutput.systemMessage, /compact at the next logical boundary/i);
    assert.ok(!('continue' in preOutput), 'Reminder must never block a tool');

    const candidateRows = fs
      .readFileSync(path.join(data, 'memory', 'candidates.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(line => JSON.parse(line));
    const captured = candidateRows.at(-1);
    assert.match(captured.id, /^cand-[a-f0-9]{16}$/);
    assert.strictEqual(captured.source, 'PreToolUse');
    assert.strictEqual(captured.sessionId, 'codex-session');
    assert.strictEqual(captured.status, 'pending');
    assert.match(captured.content, /\[REDACTED\]/);
    assert.doesNotMatch(captured.content, /super-secret-value/);

    const startAfterCandidate = runHook(
      'SessionStart',
      { session_id: 'claude-session', cwd: project },
      project,
      { CLAUDE_PLUGIN_ROOT: repoRoot }
    );
    assertOk(startAfterCandidate);
    assert.doesNotMatch(startAfterCandidate.stdout, /Project convention|super-secret-value/);

    const mcpHealthPath = path.join(data, 'runtime', 'mcp-health.json');
    write(path.join(project, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }));
    const noMcpConfig = runHook(
      'PreToolUse',
      { session_id: 'mcp-none', cwd: project, tool_name: 'mcp__fixture__ping' },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(noMcpConfig);
    assert.ok(!fs.existsSync(mcpHealthPath), 'MCP state must not exist without project-local MCP config');

    write(
      path.join(project, '.mcp.json'),
      `${JSON.stringify({
        mcpServers: {
          fixture: {
            command: process.execPath,
            env: { TOKEN: 'MCP_SECRET_SENTINEL' },
          },
        },
      })}\n`
    );
    const configuredMcp = runHook(
      'PreToolUse',
      { session_id: 'mcp-configured', cwd: project, tool_name: 'mcp__fixture__ping' },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(configuredMcp);
    const mcpStateText = fs.readFileSync(mcpHealthPath, 'utf8');
    const mcpState = JSON.parse(mcpStateText);
    assert.strictEqual(mcpState.servers.fixture.status, 'configured');
    assert.strictEqual(mcpState.servers.fixture.source, '.mcp.json');
    assert.doesNotMatch(mcpStateText, /MCP_SECRET_SENTINEL/);

    write(path.join(project, '.mcp.json'), '{malformed');
    const malformedMcp = runHook(
      'PreToolUse',
      { session_id: 'mcp-malformed', cwd: project, tool_name: 'mcp__fixture__ping' },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(malformedMcp);
    assert.match(JSON.parse(malformedMcp.stdout).systemMessage, /MCP configuration health.*fail-open/i);
    assert.strictEqual(JSON.parse(fs.readFileSync(mcpHealthPath, 'utf8')).servers.fixture.status, 'invalid');
    fs.rmSync(path.join(project, '.mcp.json'));

    write(
      path.join(project, '.claude', 'settings.json'),
      `${JSON.stringify({ hooks: {}, mcpServers: 'invalid' })}\n`
    );
    const invalidSettingsMcp = runHook(
      'PreToolUse',
      { session_id: 'mcp-invalid-settings', cwd: project, tool_name: 'mcp__fixture__ping' },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(invalidSettingsMcp);
    assert.match(JSON.parse(invalidSettingsMcp.stdout).systemMessage, /MCP configuration health.*fail-open/i);
    const invalidSettingsState = JSON.parse(fs.readFileSync(mcpHealthPath, 'utf8'));
    assert.strictEqual(invalidSettingsState.servers.fixture.status, 'invalid');
    assert.strictEqual(invalidSettingsState.servers.fixture.source, '.claude/settings.json');

    write(path.join(project, 'package.json'), '{"scripts":{"test":"node test.js"}}\n');
    write(path.join(project, 'src', 'app.js'), 'console.log("temporary");\n');
    const post = runHook(
      'PostToolUse',
      {
        sessionId: 'codex-session',
        cwd: project,
        turnId: 'turn-1',
        toolName: 'Write',
        toolInput: { filePath: 'src/app.js' },
        toolOutput: { success: true },
      },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(post);
    assert.match(JSON.parse(post.stdout).systemMessage, /Non-blocking Node warning.*console\.log/i);
    const sessionState = JSON.parse(
      fs.readFileSync(path.join(data, 'runtime', 'sessions', 'codex-session.json'), 'utf8')
    );
    assert.strictEqual(sessionState.activities.at(-1).tool, 'Write');
    assert.strictEqual(sessionState.contextRemainingPct, 19);

    const uiFile = path.join(project, 'src', 'page.tsx');
    write(uiFile, 'export const Page = () => <button>Get Started</button>;\n');
    const design = runHook(
      'PostToolUse',
      {
        sessionId: 'codex-session',
        cwd: project,
        toolName: 'Write',
        toolInput: { filePath: 'src/page.tsx' },
        toolOutput: { success: true },
      },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(design);
    assert.match(JSON.parse(design.stdout).systemMessage, /Frontend design warning/);

    write(path.join(project, 'tsconfig.json'), '{}\n');
    write(
      path.join(project, 'node_modules', 'prettier', 'package.json'),
      JSON.stringify({ name: 'prettier', bin: { prettier: 'bin/prettier.js' } })
    );
    write(
      path.join(project, 'node_modules', 'prettier', 'bin', 'prettier.js'),
      "const fs=require('fs');for(const p of process.argv.slice(3))fs.appendFileSync(p,'// formatted\\n');\n"
    );
    write(
      path.join(project, 'node_modules', 'typescript', 'package.json'),
      JSON.stringify({ name: 'typescript', bin: { tsc: 'bin/tsc.js' } })
    );
    write(
      path.join(project, 'node_modules', 'typescript', 'bin', 'tsc.js'),
      "require('fs').writeFileSync('typecheck-ran.txt','yes');\n"
    );

    const outsideQuality = path.join(temp, 'outside-quality');
    const outsideQualityFile = path.join(outsideQuality, 'linked.js');
    const qualityLink = path.join(project, 'src', 'external-link');
    fs.mkdirSync(outsideQuality, { recursive: true });
    write(outsideQualityFile, 'const linked = true;\n');
    fs.symlinkSync(outsideQuality, qualityLink, process.platform === 'win32' ? 'junction' : 'dir');
    const linkedPost = runHook(
      'PostToolUse',
      {
        session_id: 'codex-session',
        cwd: project,
        tool_name: 'Write',
        tool_input: { filePath: 'src/external-link/linked.js' },
        tool_output: { success: true },
      },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(linkedPost);
    const linkedStop = runHook(
      'Stop',
      { session_id: 'codex-session', cwd: project },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(linkedStop);
    assert.doesNotMatch(fs.readFileSync(outsideQualityFile, 'utf8'), /formatted/);
    fs.rmSync(qualityLink, { recursive: true, force: true });

    const compact = runHook(
      'PreCompact',
      { session_id: 'codex-session', cwd: project, trigger: 'auto' },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(compact);
    assert.strictEqual(compact.stdout, '');
    assert.ok(fs.existsSync(path.join(data, 'runtime', 'latest-snapshot.json')));

    const costs = path.join(data, 'runtime', 'costs.jsonl');
    const stopWithoutCost = runHook(
      'Stop',
      {
        session_id: 'codex-session',
        cwd: project,
        last_assistant_message: 'Root cause: the shared parser discarded the value.',
      },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(stopWithoutCost);
    assert.ok(!fs.existsSync(costs), 'No cost row should exist without cost or usage evidence');
    assert.match(fs.readFileSync(uiFile, 'utf8'), /formatted/);
    assert.strictEqual(fs.readFileSync(path.join(project, 'typecheck-ran.txt'), 'utf8'), 'yes');

    write(
      path.join(project, 'node_modules', 'prettier', 'bin', 'prettier.js'),
      "process.stderr.write('fixture format failure');process.exit(2);\n"
    );
    write(
      path.join(project, 'node_modules', 'typescript', 'bin', 'tsc.js'),
      "process.stderr.write('fixture typecheck failure');process.exit(2);\n"
    );
    const qualityFailure = runHook(
      'Stop',
      { session_id: 'codex-session', cwd: project },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(qualityFailure);
    assert.match(JSON.parse(qualityFailure.stdout).systemMessage, /Prettier warning: fixture format failure/);
    assert.match(JSON.parse(qualityFailure.stdout).systemMessage, /TypeScript warning: fixture typecheck failure/);

    const qualityDisabled = runHook(
      'Stop',
      { session_id: 'codex-session', cwd: project },
      project,
      { PLUGIN_ROOT: repoRoot, ASTER_LOCAL_QUALITY: 'off' }
    );
    assertOk(qualityDisabled);
    assert.strictEqual(qualityDisabled.stdout, '');

    const stopWithCost = runHook(
      'Stop',
      {
        sessionId: 'codex-session',
        cwd: project,
        model: 'test-model',
        cost: { totalCostUsd: 1.25 },
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      project,
      { PLUGIN_ROOT: repoRoot }
    );
    assertOk(stopWithCost);
    const costRow = JSON.parse(fs.readFileSync(costs, 'utf8').trim());
    assert.strictEqual(costRow.costUsd, 1.25);
    assert.deepStrictEqual(costRow.usage, { inputTokens: 100, outputTokens: 20 });

    const sessionEnd = runHook(
      'SessionEnd',
      {
        session_id: 'claude-session-end',
        cwd: project,
        last_assistant_message: 'Decision: keep Claude session persistence on SessionEnd.',
      },
      project,
      { CLAUDE_PLUGIN_ROOT: repoRoot }
    );
    assertOk(sessionEnd);
    assert.strictEqual(sessionEnd.stdout, '');
    const sessionEndState = JSON.parse(
      fs.readFileSync(path.join(data, 'runtime', 'sessions', 'claude-session-end.json'), 'utf8')
    );
    assert.strictEqual(sessionEndState.lastEvent, 'SessionEnd');
    const sessionEndSnapshot = JSON.parse(
      fs.readFileSync(path.join(data, 'runtime', 'snapshots', 'claude-session-end.json'), 'utf8')
    );
    assert.strictEqual(sessionEndSnapshot.reason, 'session-end');
    assert.match(fs.readFileSync(path.join(data, 'memory', 'candidates.jsonl'), 'utf8'), /"source":"SessionEnd"/);

    const pluginProject = path.join(temp, 'plugin-project');
    const pluginData = path.join(temp, 'plugin-data');
    fs.mkdirSync(pluginProject, { recursive: true });
    const pluginGit = spawnSync('git', ['init', '--quiet'], {
      cwd: pluginProject,
      env: process.env,
      encoding: 'utf8',
    });
    assertOk(pluginGit);
    const pluginRun = runHook(
      'PreToolUse',
      { session_id: 'plugin-session', cwd: pluginProject, tool_name: 'Read' },
      pluginProject,
      { PLUGIN_ROOT: repoRoot, PLUGIN_DATA: pluginData }
    );
    assertOk(pluginRun);
    assert.ok(fs.existsSync(path.join(pluginData, 'projects')), 'PLUGIN_DATA fallback should be writable');
    assert.ok(!fs.existsSync(path.join(pluginProject, '.aster')));

    const claudePluginData = path.join(temp, 'claude-plugin-data');
    const claudePluginRun = runHook(
      'PreToolUse',
      { session_id: 'claude-plugin-session', cwd: pluginProject, tool_name: 'Read' },
      pluginProject,
      { CLAUDE_PLUGIN_ROOT: repoRoot, CLAUDE_PLUGIN_DATA: claudePluginData }
    );
    assertOk(claudePluginRun);
    assert.ok(
      fs.existsSync(path.join(claudePluginData, 'projects')),
      'CLAUDE_PLUGIN_DATA fallback should be writable'
    );

    const badData = path.join(temp, 'not-a-directory');
    write(badData, 'file');
    const failOpen = runHook(
      'PreToolUse',
      { session_id: 'fail-open', cwd: pluginProject, tool_name: 'Read' },
      pluginProject,
      { PLUGIN_DATA: badData }
    );
    assertOk(failOpen);
    assert.strictEqual(failOpen.stdout, '');

    const invalid = runHook('Stop', '{not-json', pluginProject, { PLUGIN_DATA: pluginData });
    assertOk(invalid);
    assert.strictEqual(invalid.stdout, '');

    const nonGitPayload = path.join(temp, 'non-git-payload');
    const nonGitData = path.join(temp, 'non-git-data');
    fs.mkdirSync(nonGitPayload, { recursive: true });
    const rejectedPayload = runHook(
      'PreToolUse',
      { session_id: 'external-payload', cwd: nonGitPayload, tool_name: 'Read' },
      project,
      { PLUGIN_DATA: nonGitData }
    );
    assertOk(rejectedPayload);
    assert.strictEqual(rejectedPayload.stdout, '');
    assert.ok(!fs.existsSync(nonGitData), 'Non-Git payload cwd must not create plugin data');

    const symlinkProject = path.join(temp, 'symlink-project');
    const outsideLocalData = path.join(temp, 'outside-local-data');
    fs.mkdirSync(symlinkProject, { recursive: true });
    fs.mkdirSync(outsideLocalData, { recursive: true });
    const symlinkGit = spawnSync('git', ['init', '--quiet'], {
      cwd: symlinkProject,
      env: process.env,
      encoding: 'utf8',
    });
    assertOk(symlinkGit);
    const localDataLink = path.join(symlinkProject, '.aster');
    fs.symlinkSync(outsideLocalData, localDataLink, process.platform === 'win32' ? 'junction' : 'dir');
    const rejectedLocalLink = runHook(
      'PreToolUse',
      { session_id: 'local-link', cwd: symlinkProject, tool_name: 'Read' },
      symlinkProject
    );
    assertOk(rejectedLocalLink);
    assert.strictEqual(rejectedLocalLink.stdout, '');
    assert.deepStrictEqual(fs.readdirSync(outsideLocalData), []);
    fs.rmSync(localDataLink, { recursive: true, force: true });

    const outsidePluginData = path.join(temp, 'outside-plugin-data');
    const pluginDataLink = path.join(temp, 'plugin-data-link');
    fs.mkdirSync(outsidePluginData, { recursive: true });
    fs.symlinkSync(outsidePluginData, pluginDataLink, process.platform === 'win32' ? 'junction' : 'dir');
    const rejectedPluginLink = runHook(
      'PreToolUse',
      { session_id: 'plugin-link', cwd: pluginProject, tool_name: 'Read' },
      pluginProject,
      { PLUGIN_DATA: pluginDataLink }
    );
    assertOk(rejectedPluginLink);
    assert.strictEqual(rejectedPluginLink.stdout, '');
    assert.deepStrictEqual(fs.readdirSync(outsidePluginData), []);
    fs.rmSync(pluginDataLink, { recursive: true, force: true });

    const hardlinkProject = path.join(temp, 'hardlink-project');
    const hardlinkData = path.join(hardlinkProject, '.aster');
    fs.mkdirSync(hardlinkProject, { recursive: true });
    const hardlinkGit = spawnSync('git', ['init', '--quiet'], {
      cwd: hardlinkProject,
      env: process.env,
      encoding: 'utf8',
    });
    assertOk(hardlinkGit);

    const outsideCandidates = path.join(temp, 'outside-candidates.jsonl');
    const linkedCandidates = path.join(hardlinkData, 'memory', 'candidates.jsonl');
    write(outsideCandidates, 'OUTSIDE_CANDIDATES_SENTINEL\n');
    fs.mkdirSync(path.dirname(linkedCandidates), { recursive: true });
    fs.linkSync(outsideCandidates, linkedCandidates);
    const rejectedCandidateHardlink = runHook(
      'PreToolUse',
      {
        session_id: 'candidate-hardlink',
        cwd: hardlinkProject,
        tool_name: 'Read',
        memory_candidate: 'This must stay inside the project.',
      },
      hardlinkProject
    );
    assertOk(rejectedCandidateHardlink);
    assert.strictEqual(rejectedCandidateHardlink.stdout, '');
    assert.strictEqual(fs.readFileSync(outsideCandidates, 'utf8'), 'OUTSIDE_CANDIDATES_SENTINEL\n');
    fs.rmSync(linkedCandidates);

    const outsideCosts = path.join(temp, 'outside-costs.jsonl');
    const linkedCosts = path.join(hardlinkData, 'runtime', 'costs.jsonl');
    write(outsideCosts, 'OUTSIDE_COSTS_SENTINEL\n');
    fs.mkdirSync(path.dirname(linkedCosts), { recursive: true });
    fs.linkSync(outsideCosts, linkedCosts);
    const rejectedCostHardlink = runHook(
      'Stop',
      {
        session_id: 'cost-hardlink',
        cwd: hardlinkProject,
        cost: { totalCostUsd: 99 },
      },
      hardlinkProject
    );
    assertOk(rejectedCostHardlink);
    assert.strictEqual(rejectedCostHardlink.stdout, '');
    assert.strictEqual(fs.readFileSync(outsideCosts, 'utf8'), 'OUTSIDE_COSTS_SENTINEL\n');

    const externalProjectAlias = path.join(temp, 'external-project-alias');
    const externalProjectData = path.join(temp, 'external-project-data');
    fs.symlinkSync(repoRoot, externalProjectAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const rejectedExternalProject = runHook(
      'PreToolUse',
      { session_id: 'external-project', cwd: externalProjectAlias, tool_name: 'Read' },
      pluginProject,
      { PLUGIN_DATA: externalProjectData }
    );
    assertOk(rejectedExternalProject);
    assert.strictEqual(rejectedExternalProject.stdout, '');
    assert.ok(!fs.existsSync(externalProjectData), 'External project payload must not create plugin data');
    fs.rmSync(externalProjectAlias, { recursive: true, force: true });

    const command = config.hooks.SessionStart[0].hooks[0].command;
    const bootstrap = spawnSync(command, {
      cwd: project,
      shell: true,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'bootstrap', cwd: project }),
      env: {
        ...process.env,
        HOME: path.join(temp, 'bootstrap-home'),
        USERPROFILE: path.join(temp, 'bootstrap-home'),
        PLUGIN_ROOT: repoRoot,
        PLUGIN_DATA: path.join(temp, 'bootstrap-data'),
        CLAUDE_PLUGIN_ROOT: '',
        CLAUDE_PLUGIN_DATA: '',
        CODEX_HOME: '',
      },
      timeout: 10000,
    });
    assertOk(bootstrap);
    assert.match(bootstrap.stdout, /APPROVED_MEMORY/);

    const installedRunner = path.join(data, 'scripts', 'aster-hooks', 'runner.js');
    fs.mkdirSync(path.dirname(installedRunner), { recursive: true });
    for (const runtimeFile of ['runner.js', 'quality.js']) {
      fs.copyFileSync(
        path.join(path.dirname(runner), runtimeFile),
        path.join(path.dirname(installedRunner), runtimeFile)
      );
    }
    const isolatedHome = path.join(temp, 'project-bootstrap-home');
    fs.mkdirSync(isolatedHome, { recursive: true });
    const gitInit = spawnSync('git', ['init'], {
      cwd: project,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        GIT_CONFIG_GLOBAL: path.join(isolatedHome, '.gitconfig'),
      },
    });
    assertOk(gitInit);
    const projectBootstrap = spawnSync(command, {
      cwd: path.join(project, 'src'),
      shell: true,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 'project-bootstrap', cwd: project }),
      env: {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        GIT_CONFIG_GLOBAL: path.join(isolatedHome, '.gitconfig'),
        PLUGIN_ROOT: '',
        PLUGIN_DATA: '',
        CLAUDE_PLUGIN_ROOT: '',
        CLAUDE_PLUGIN_DATA: '',
        CODEX_HOME: '',
      },
      timeout: 10000,
    });
    assertOk(projectBootstrap);
    assert.match(projectBootstrap.stdout, /APPROVED_MEMORY/);

    console.log('PASS aster hooks: Codex Stop, Claude SessionEnd, bounded approved memory, fail-open persistence');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

runTests();
