#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(repoRoot, 'scripts', 'aster.js');
const { parseArgs } = require(cliPath);
const { CORE_AGENTS, CORE_SKILLS, detectStacks, selectContent } = require('../../scripts/lib/aster/manifest');
const {
  PLAN_LIMIT,
  appendVerificationRecord,
  clearTaskRecords,
  readPlanRecord,
  readVerificationRecords,
  writePlanRecord,
} = require('../../scripts/lib/aster');
const { assertInside, requireHarnessTestIsolation } = require('../../scripts/lib/aster/test-isolation');

const isolation = requireHarnessTestIsolation(repoRoot);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}: ${error.stack || error.message}`);
    failed += 1;
  }
}

function makeFixture() {
  const fixtureRoot = path.join(isolation.testRoot, 'fixtures');
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureRoot, 'aster-test-'));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const fixture = {
    root,
    project,
    home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: path.join(home, '.codex-test'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude-test'),
      XDG_CONFIG_HOME: path.join(home, '.config-test'),
      XDG_DATA_HOME: path.join(home, '.data-test'),
    },
  };
  const initialized = spawnSync('git', ['init', '--quiet'], {
    cwd: project,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.strictEqual(initialized.status, 0, initialized.stderr || initialized.stdout);
  return fixture;
}

function projectEntriesWithoutGit(project) {
  return fs.readdirSync(project).filter(name => name !== '.git');
}

function run(fixture, args, expectedStatus = 0, cwd = fixture.project) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: fixture.env,
    encoding: 'utf8',
  });
  assert.strictEqual(
    result.status,
    expectedStatus,
    `command ${args.join(' ')} exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
  );
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

test('exports the canonical curated manifest and detects React/TypeScript', () => {
  assert.strictEqual(CORE_SKILLS.length, 44);
  assert.strictEqual(CORE_AGENTS.length, 23);

  const fixture = makeFixture();
  try {
    writeJson(path.join(fixture.project, 'package.json'), {
      dependencies: { react: '^19.0.0' },
      devDependencies: { typescript: '^6.0.0' },
    });
    const stacks = detectStacks(fixture.project);
    assert.ok(stacks.includes('web'));
    assert.ok(stacks.includes('typescript'));
    assert.ok(stacks.includes('react'));
    const selected = selectContent(fixture.project);
    assert.ok(selected.skills.includes('react-patterns'));
    assert.ok(selected.agents.includes('typescript-reviewer'));
    assert.ok(selected.agents.includes('react-build-resolver'));
  } finally {
    cleanup(fixture);
  }
});

test('supports Aster target and plugin shortcuts without ambiguous overrides', () => {
  assert.strictEqual(parseArgs(['init', '--codex']).options.target, 'codex');
  assert.strictEqual(parseArgs(['init', '--claude']).options.target, 'claude');
  assert.strictEqual(parseArgs(['init', '--both']).options.target, 'both');
  assert.strictEqual(parseArgs(['init', '--plugin']).options.distribution, 'plugin-overlay');
  assert.throws(() => parseArgs(['init', '--codex', '--claude']), /Conflicting target/);
  assert.throws(
    () => parseArgs(['init', '--plugin', '--distribution', 'project']),
    /Conflicting distribution/
  );
});

test('rejects invalid project configuration before writing managed files', () => {
  const cases = [
    [null, /must contain a JSON object/],
    [{ with: 'not-an-array' }, /"with" must be an array/],
    [{ without: 'not-an-array' }, /"without" must be an array/],
    [{ memory: null }, /"memory" must be an object/],
    [{ agents: [] }, /"agents" must be an object/],
    [{ distribution: 'global' }, /distribution/],
    [{ stacks: 42 }, /stacks/],
    [{ hooks: 'strict' }, /hooks/],
    [{ memory: { approvalRequired: false } }, /approval-gated/],
    [{ memory: { maxInjectedCharacters: 0 } }, /maxInjectedCharacters/],
    [{ agents: { maxThreads: 4 } }, /maxThreads/],
    [{ agents: { maxDepth: 2 } }, /maxDepth/],
  ];
  const fixture = makeFixture();
  try {
    for (const [config, expected] of cases) {
      writeJson(path.join(fixture.project, 'aster.json'), config);
      const result = run(fixture, ['init', '--json'], 1);
      assert.match(JSON.parse(result.stdout).error, expected);
      assert.ok(!fs.existsSync(path.join(fixture.project, '.aster', 'install-state.json')));
      fs.rmSync(path.join(fixture.project, 'aster.json'), { force: true });
    }
  } finally {
    cleanup(fixture);
  }
});

test('detects C, Xcode, .NET, and Kubernetes projects with their stack content', () => {
  const cases = [
    {
      name: 'C',
      stack: 'cpp',
      skill: 'cpp-coding-standards',
      agent: 'cpp-reviewer',
      setup: project => fs.writeFileSync(path.join(project, 'main.c'), 'int main(void) { return 0; }\n'),
    },
    {
      name: 'Xcode',
      stack: 'swift',
      skill: 'swiftui-patterns',
      agent: 'swift-reviewer',
      setup: project => fs.mkdirSync(path.join(project, 'Demo.xcodeproj')),
    },
    {
      name: '.NET',
      stack: 'dotnet',
      skill: 'dotnet-patterns',
      agent: 'csharp-reviewer',
      setup: project => {
        fs.writeFileSync(path.join(project, 'App.sln'), 'Microsoft Visual Studio Solution File\n');
        writeJson(path.join(project, 'global.json'), { sdk: { version: '9.0.100' } });
      },
    },
    {
      name: 'Kubernetes',
      stack: 'kubernetes',
      skill: 'kubernetes-patterns',
      agent: null,
      setup: project => fs.writeFileSync(
        path.join(project, 'deployment.yaml'),
        'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: fixture\n'
      ),
    },
  ];

  for (const item of cases) {
    const fixture = makeFixture();
    try {
      item.setup(fixture.project);
      const stacks = detectStacks(fixture.project);
      assert.ok(stacks.includes(item.stack), `${item.name} did not detect ${item.stack}`);
      const selected = selectContent(fixture.project);
      assert.ok(selected.skills.includes(item.skill), `${item.name} did not select ${item.skill}`);
      if (item.agent) assert.ok(selected.agents.includes(item.agent), `${item.name} did not select ${item.agent}`);
    } finally {
      cleanup(fixture);
    }
  }
});

test('dry-run plans a project-local install without touching project or homes', () => {
  const fixture = makeFixture();
  try {
    const result = run(fixture, ['init', '--dry-run', '--json']);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.dryRun, true);
    assert.strictEqual(output.target, 'both');
    assert.ok(output.files.some(file => file.path === '.agents/skills/harness-start/SKILL.md'));
    for (const filePath of [
      '.claude/settings.json',
      '.codex/hooks.json',
      '.codex/config.toml',
      'AGENTS.md',
      'CLAUDE.md',
      '.gitignore',
    ]) {
      assert.ok(output.files.some(file => file.path === filePath), `dry-run omitted ${filePath}`);
    }
    const codexOnly = JSON.parse(run(fixture, ['init', '--codex', '--dry-run', '--json']).stdout);
    assert.strictEqual(codexOnly.target, 'codex');
    assert.ok(codexOnly.files.some(file => file.path === '.codex/hooks.json'));
    assert.ok(!codexOnly.files.some(file => file.path.startsWith('.claude/')));
    assert.deepStrictEqual(projectEntriesWithoutGit(fixture.project), []);
    assert.deepStrictEqual(fs.readdirSync(fixture.home), []);
  } finally {
    cleanup(fixture);
  }
});

test('resolves nested Git invocations and rejects non-Git directories', () => {
  const fixture = makeFixture();
  try {
    const nested = path.join(fixture.project, 'src', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const nestedResult = JSON.parse(run(fixture, ['plan', '--dry-run', '--json'], 0, nested).stdout);
    assert.ok(nestedResult.files.some(file => file.path === '.agents/skills/harness-start/SKILL.md'));
    assert.ok(!fs.existsSync(path.join(nested, '.agents')));
    assert.ok(!fs.existsSync(path.join(fixture.project, 'src', 'aster.json')));

    const nonGit = JSON.parse(run(fixture, ['init', '--dry-run', '--json'], 1, fixture.home).stdout);
    assert.match(nonGit.error, /must be run from inside a Git project/);
    assert.deepStrictEqual(projectEntriesWithoutGit(fixture.home), []);
  } finally {
    cleanup(fixture);
  }
});

test('test-mode rejects a project-root junction that resolves outside the sandbox', () => {
  const fixture = makeFixture();
  const alias = path.join(fixture.root, 'project-alias');
  try {
    fs.symlinkSync(repoRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const result = spawnSync(process.execPath, [cliPath, 'init', '--dry-run', '--json'], {
      cwd: alias,
      env: fixture.env,
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 1);
    assert.match(JSON.parse(result.stdout).error, /repository-local test sandbox/);
  } finally {
    fs.rmSync(alias, { recursive: true, force: true });
    cleanup(fixture);
  }
});

test('isolation rejects a missing path below a junction that leaves the sandbox', () => {
  const fixture = makeFixture();
  const alias = path.join(fixture.root, 'outside-parent-alias');
  try {
    fs.symlinkSync(repoRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(
      () => assertInside(isolation.testRoot, path.join(alias, 'missing', '.codex'), 'CODEX_HOME'),
      /repository-local test sandbox/
    );
  } finally {
    fs.rmSync(alias, { recursive: true, force: true });
    cleanup(fixture);
  }
});

test('init is idempotent, preserves user hook settings, and installs both targets', () => {
  const fixture = makeFixture();
  try {
    writeJson(path.join(fixture.project, 'package.json'), {
      dependencies: { react: '^19.0.0' },
      devDependencies: { typescript: '^6.0.0' },
    });
    const userHook = {
      matcher: 'Bash',
      hooks: [{ type: 'command', command: 'node user-hook.js' }],
      id: 'user:hook',
    };
    writeJson(path.join(fixture.project, '.claude', 'settings.json'), {
      permissions: { allow: ['Read'] },
      hooks: { PreToolUse: [userHook] },
    });
    writeJson(path.join(fixture.project, '.codex', 'hooks.json'), {
      hooks: { PreToolUse: [userHook] },
    });
    fs.writeFileSync(path.join(fixture.project, 'AGENTS.md'), '# Existing Codex rules\n');
    fs.writeFileSync(path.join(fixture.project, 'CLAUDE.md'), '# Existing Claude rules\n');

    const first = JSON.parse(run(fixture, ['init', '--json']).stdout);
    assert.strictEqual(first.target, 'both');
    assert.ok(fs.existsSync(path.join(fixture.project, '.agents', 'skills', 'harness-start', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(fixture.project, '.claude', 'skills', 'harness-start', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(fixture.project, '.claude', 'commands', 'harness-start.md')));
    assert.ok(fs.existsSync(path.join(fixture.project, '.claude', 'agents', 'planner.md')));
    assert.ok(fs.existsSync(path.join(fixture.project, '.codex', 'agents', 'planner.toml')));
    assert.ok(fs.existsSync(path.join(fixture.project, '.codex', 'agents', 'typescript-reviewer.toml')));
    assert.ok(fs.existsSync(path.join(fixture.project, '.aster', 'scripts', 'aster-hooks', 'runner.js')));
    assert.match(fs.readFileSync(path.join(fixture.project, 'AGENTS.md'), 'utf8'), /Existing Codex rules[\s\S]*Aster/);
    assert.match(fs.readFileSync(path.join(fixture.project, 'CLAUDE.md'), 'utf8'), /Existing Claude rules[\s\S]*Aster/);
    assert.match(fs.readFileSync(path.join(fixture.project, '.codex', 'agents', 'planner.toml'), 'utf8'), /sandbox_mode = "read-only"/);
    assert.match(fs.readFileSync(path.join(fixture.project, '.codex', 'agents', 'build-error-resolver.toml'), 'utf8'), /sandbox_mode = "workspace-write"/);

    const claudeSettings = readJson(path.join(fixture.project, '.claude', 'settings.json'));
    assert.deepStrictEqual(claudeSettings.permissions, { allow: ['Read'] });
    assert.ok(claudeSettings.hooks.PreToolUse.some(entry => entry.id === 'user:hook'));
    assert.ok(claudeSettings.hooks.PreToolUse.some(entry => String(entry.id).startsWith('aster:')));
    assert.ok(claudeSettings.hooks.SessionEnd.some(entry => String(entry.id).startsWith('aster:')));
    assert.ok(!claudeSettings.hooks.Stop?.some(entry => String(entry.id).startsWith('aster:')));
    const codexHooks = readJson(path.join(fixture.project, '.codex', 'hooks.json'));
    assert.ok(codexHooks.hooks.PreToolUse.some(entry => entry.id === 'user:hook'));
    assert.ok(codexHooks.hooks.Stop.some(entry => String(entry.id).startsWith('aster:')));
    assert.ok(!codexHooks.hooks.SessionEnd);

    const statePath = path.join(fixture.project, '.aster', 'install-state.json');
    const before = fs.readFileSync(statePath, 'utf8');
    const second = JSON.parse(run(fixture, ['init', '--json']).stdout);
    const after = fs.readFileSync(statePath, 'utf8');
    assert.strictEqual(second.conflicts.length, 0);
    assert.strictEqual(before, after);
    assert.deepStrictEqual(fs.readdirSync(fixture.home), []);
  } finally {
    cleanup(fixture);
  }
});

test('init rejects malformed user hook settings without overwriting them', () => {
  const malformedDocuments = [
    { hooks: 'keep-this-invalid-value' },
    { hooks: { PreToolUse: { keep: 'this-invalid-event' } } },
  ];
  for (const document of malformedDocuments) {
    const fixture = makeFixture();
    try {
      const settingsPath = path.join(fixture.project, '.claude', 'settings.json');
      writeJson(settingsPath, document);
      const before = fs.readFileSync(settingsPath, 'utf8');
      const result = run(fixture, ['init', '--target', 'claude', '--json'], 1);
      assert.match(result.stdout, /Hook settings.*must contain/);
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), before);
      assert.ok(!fs.existsSync(path.join(fixture.project, '.aster', 'install-state.json')));
    } finally {
      cleanup(fixture);
    }
  }
});

test('test-mode CLI refuses any project outside the repository-local sandbox', () => {
  const fixture = makeFixture();
  try {
    const result = spawnSync(process.execPath, [cliPath, 'init', '--dry-run'], {
      cwd: repoRoot,
      env: fixture.env,
      encoding: 'utf8',
    });
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /must stay inside the repository-local test sandbox/);
    assert.deepStrictEqual(fs.readdirSync(fixture.home), []);
  } finally {
    cleanup(fixture);
  }
});

test('plugin overlay avoids duplicate core skills and hooks', () => {
  const fixture = makeFixture();
  try {
    writeJson(path.join(fixture.project, 'package.json'), {
      dependencies: { react: '^19.0.0' },
    });
    const result = JSON.parse(run(fixture, ['init', '--distribution', 'plugin-overlay', '--json']).stdout);
    assert.strictEqual(result.distribution, 'plugin-overlay');
    assert.ok(!fs.existsSync(path.join(fixture.project, '.agents', 'skills', 'harness-start')));
    assert.ok(fs.existsSync(path.join(fixture.project, '.agents', 'skills', 'react-patterns', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(fixture.project, '.codex', 'agents', 'planner.toml')));
    assert.ok(fs.existsSync(path.join(fixture.project, '.aster', 'scripts', 'aster', 'records.js')));
    assert.ok(!fs.existsSync(path.join(fixture.project, '.codex', 'hooks.json')));
    assert.ok(!fs.existsSync(path.join(fixture.project, '.claude', 'agents', 'planner.md')));
    assert.match(fs.readFileSync(path.join(fixture.project, 'AGENTS.md'), 'utf8'), /\$aster:harness-\*/);
    assert.deepStrictEqual(fs.readdirSync(fixture.home), []);
  } finally {
    cleanup(fixture);
  }
});

test('refuses managed paths that escape through a project symlink', () => {
  const fixture = makeFixture();
  try {
    const outside = path.join(fixture.root, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(fixture.project, '.codex'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = run(fixture, ['init', '--target', 'codex', '--json'], 1);
    assert.match(JSON.parse(result.stdout).error, /crosses a symlink/);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
    assert.deepStrictEqual(fs.readdirSync(fixture.home), []);
  } finally {
    cleanup(fixture);
  }
});

test('update protects drift unless force is explicit', () => {
  const fixture = makeFixture();
  try {
    run(fixture, ['init']);
    const managed = path.join(fixture.project, '.codex', 'agents', 'planner.toml');
    fs.appendFileSync(managed, '\n# local change\n');
    const failedUpdate = run(fixture, ['update', '--json'], 1);
    assert.ok(JSON.parse(failedUpdate.stdout).conflicts.some(conflict => conflict.path === '.codex/agents/planner.toml'));
    assert.match(fs.readFileSync(managed, 'utf8'), /local change/);
    run(fixture, ['update', '--force']);
    assert.doesNotMatch(fs.readFileSync(managed, 'utf8'), /local change/);
  } finally {
    cleanup(fixture);
  }
});

test('target changes remove obsolete surfaces and protect managed marker blocks', () => {
  const fixture = makeFixture();
  try {
    run(fixture, ['init']);
    const gitignore = path.join(fixture.project, '.gitignore');
    fs.writeFileSync(gitignore, fs.readFileSync(gitignore, 'utf8').replace('.aster/', '.aster/**'));
    const blocked = JSON.parse(run(fixture, ['update', '--json'], 1).stdout);
    assert.ok(blocked.conflicts.some(conflict => conflict.path === '.gitignore'));

    run(fixture, ['update', '--target', 'codex', '--force']);
    assert.ok(fs.existsSync(path.join(fixture.project, '.codex', 'agents', 'planner.toml')));
    assert.ok(!fs.existsSync(path.join(fixture.project, '.claude', 'agents', 'planner.md')));
    assert.ok(!fs.existsSync(path.join(fixture.project, '.claude', 'settings.json')));
  } finally {
    cleanup(fixture);
  }
});

test('memory approval and rejection only promote explicitly selected candidates', () => {
  const fixture = makeFixture();
  try {
    run(fixture, ['init']);
    const memoryDir = path.join(fixture.project, '.aster', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'candidates.jsonl'), [
      JSON.stringify({ id: 'cand-approve', content: 'Prefer focused Node tests.', status: 'pending' }),
      JSON.stringify({ id: 'cand-reject', content: 'Never test anything.', status: 'pending' }),
      '',
    ].join('\n'));

    const listed = JSON.parse(run(fixture, ['memory', 'list', '--json']).stdout);
    assert.deepStrictEqual(listed.candidates.map(item => item.id), ['cand-approve', 'cand-reject']);
    run(fixture, ['memory', 'approve', 'cand-approve']);
    const approved = fs.readFileSync(path.join(memoryDir, 'approved.md'), 'utf8');
    assert.match(approved, /## cand-approve/);
    assert.match(approved, /Prefer focused Node tests\./);
    assert.doesNotMatch(approved, /Never test anything/);
    run(fixture, ['memory', 'reject', 'cand-reject']);
    assert.strictEqual(fs.readFileSync(path.join(memoryDir, 'candidates.jsonl'), 'utf8'), '');
    assert.match(fs.readFileSync(path.join(memoryDir, 'rejected.jsonl'), 'utf8'), /cand-reject/);
  } finally {
    cleanup(fixture);
  }
});

test('plan and verification records stay bounded inside initialized project state', () => {
  const fixture = makeFixture();
  try {
    run(fixture, ['init']);
    const plan = '# Approved task plan\n\n1. Implement the focused behavior.\n';
    assert.strictEqual(writePlanRecord(fixture.project, plan).path, '.aster/state/current-plan.md');
    assert.strictEqual(readPlanRecord(fixture.project), plan);
    assert.throws(() => writePlanRecord(fixture.project, ''), /must contain text/);
    assert.throws(() => writePlanRecord(fixture.project, null), /must contain text/);
    writePlanRecord(fixture.project, `${plan}\nAPI_KEY=plan-secret-value\n`);
    assert.doesNotMatch(readPlanRecord(fixture.project), /plan-secret-value/);
    assert.match(readPlanRecord(fixture.project), /API_KEY=\[REDACTED\]/);
    assert.throws(() => writePlanRecord(fixture.project, 'x'.repeat(PLAN_LIMIT + 1)), /exceeds/);

    appendVerificationRecord(fixture.project, {
      command: 'npm test',
      status: 'passed',
      details: 'token=super-secret-record-value',
      token: 'plain-sensitive-value',
    });
    appendVerificationRecord(fixture.project, {
      command: 'npm run lint',
      status: 'skipped',
      reason: 'fixture only',
    });
    const verification = readVerificationRecords(fixture.project);
    assert.strictEqual(verification.length, 2);
    assert.strictEqual(verification[0].command, 'npm test');
    assert.match(verification[0].details, /\[REDACTED\]/);
    assert.strictEqual(verification[0].token, '[REDACTED]');
    assert.doesNotMatch(JSON.stringify(verification), /super-secret-record-value/);
    assert.doesNotMatch(JSON.stringify(verification), /plain-sensitive-value/);
    assert.throws(() => appendVerificationRecord(fixture.project, null), /must be an object/);
    assert.throws(() => appendVerificationRecord(fixture.project, []), /must be an object/);
    assert.throws(
      () => appendVerificationRecord(fixture.project, { details: Array(50).fill('x'.repeat(8000)) }),
      /exceeds/
    );

    const hardlinkRecord = path.join(fixture.project, '.aster', 'state', 'current-plan.md');
    const outsidePlan = path.join(fixture.root, 'outside-plan.md');
    fs.writeFileSync(outsidePlan, 'OUTSIDE_PLAN_SENTINEL\n');
    fs.mkdirSync(path.dirname(hardlinkRecord), { recursive: true });
    fs.rmSync(hardlinkRecord, { force: true });
    fs.linkSync(outsidePlan, hardlinkRecord);
    assert.throws(() => readPlanRecord(fixture.project), /hardlink/);
    assert.throws(() => writePlanRecord(fixture.project, plan), /hardlink/);
    assert.strictEqual(fs.readFileSync(outsidePlan, 'utf8'), 'OUTSIDE_PLAN_SENTINEL\n');
    fs.rmSync(hardlinkRecord);
    writePlanRecord(fixture.project, plan);

    const cleared = clearTaskRecords(fixture.project);
    assert.deepStrictEqual(cleared.removed.sort(), [
      '.aster/state/current-plan.md',
      '.aster/state/verification.jsonl',
    ]);
    assert.strictEqual(readPlanRecord(fixture.project), '');
    assert.deepStrictEqual(readVerificationRecords(fixture.project), []);
    assert.deepStrictEqual(clearTaskRecords(fixture.project).removed, []);

    const malformedVerification = path.join(fixture.project, '.aster', 'state', 'verification.jsonl');
    fs.mkdirSync(path.dirname(malformedVerification), { recursive: true });
    fs.writeFileSync(malformedVerification, '{malformed}\n');
    assert.deepStrictEqual(readVerificationRecords(fixture.project), []);
    fs.rmSync(malformedVerification);

    const stateDir = path.join(fixture.project, '.aster', 'state');
    const outside = path.join(fixture.root, 'outside-records');
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, stateDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => writePlanRecord(fixture.project, plan), /crosses a symlink/);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  } finally {
    cleanup(fixture);
  }
});

test('memory approval refuses a symlinked project memory directory', () => {
  const fixture = makeFixture();
  try {
    run(fixture, ['init']);
    const memoryDir = path.join(fixture.project, '.aster', 'memory');
    const outside = path.join(fixture.root, 'outside-memory');
    fs.rmSync(memoryDir, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(
      path.join(outside, 'candidates.jsonl'),
      `${JSON.stringify({ id: 'outside-candidate', content: 'must not be approved', status: 'pending' })}\n`
    );
    fs.symlinkSync(outside, memoryDir, process.platform === 'win32' ? 'junction' : 'dir');

    const listed = JSON.parse(run(fixture, ['memory', 'list', '--json'], 1).stdout);
    assert.match(listed.error, /Memory path crosses a symlink/);
    const approved = JSON.parse(run(fixture, ['memory', 'approve', 'outside-candidate', '--json'], 1).stdout);
    assert.match(approved.error, /Memory path crosses a symlink/);
    const rejected = JSON.parse(run(fixture, ['memory', 'reject', 'outside-candidate', '--json'], 1).stdout);
    assert.match(rejected.error, /Memory path crosses a symlink/);
    assert.doesNotMatch(fs.readFileSync(path.join(outside, 'candidates.jsonl'), 'utf8'), /approved.md/);
    assert.ok(!fs.existsSync(path.join(outside, 'approved.md')));
    assert.ok(!fs.existsSync(path.join(outside, 'rejected.jsonl')));
  } finally {
    cleanup(fixture);
  }
});

test('doctor reports drift and uninstall removes only unchanged managed content', () => {
  const fixture = makeFixture();
  try {
    run(fixture, ['init']);
    const changed = path.join(fixture.project, '.claude', 'agents', 'planner.md');
    const removable = path.join(fixture.project, '.claude', 'agents', 'architect.md');
    fs.appendFileSync(changed, '\nlocal project instruction\n');
    const doctor = run(fixture, ['doctor', '--json'], 1);
    assert.ok(JSON.parse(doctor.stdout).issues.some(issue => issue.path === '.claude/agents/planner.md'));

    const result = JSON.parse(run(fixture, ['uninstall', '--json']).stdout);
    assert.ok(result.preserved.includes('.claude/agents/planner.md'));
    assert.ok(fs.existsSync(changed));
    assert.ok(!fs.existsSync(removable));
    assert.ok(!fs.existsSync(path.join(fixture.project, '.aster', 'install-state.json')));
    assert.deepStrictEqual(fs.readdirSync(fixture.home), []);
  } finally {
    cleanup(fixture);
  }
});

test('uninstall keeps the Git ignore block while project task records remain', () => {
  const fixture = makeFixture();
  try {
    run(fixture, ['init']);
    const planRecord = writePlanRecord(fixture.project, '# Keep this local task plan\n');
    const planPath = path.join(fixture.project, planRecord.path);
    const preview = JSON.parse(run(fixture, ['uninstall', '--dry-run', '--json']).stdout);
    const previewedPaths = new Set([...preview.removed, ...preview.updated]);
    for (const fragmentPath of [
      '.claude/settings.json',
      '.codex/hooks.json',
      '.codex/config.toml',
      'AGENTS.md',
      'CLAUDE.md',
    ]) {
      assert.ok(previewedPaths.has(fragmentPath), `uninstall dry-run omitted ${fragmentPath}`);
    }
    assert.ok(preview.preserved.includes('.gitignore#aster-data'));
    assert.ok(fs.existsSync(path.join(fixture.project, '.aster', 'install-state.json')));
    assert.strictEqual(fs.readFileSync(planPath, 'utf8'), '# Keep this local task plan\n');

    const result = JSON.parse(run(fixture, ['uninstall', '--json']).stdout);
    assert.ok(result.preserved.includes('.gitignore#aster-data'));
    assert.match(fs.readFileSync(path.join(fixture.project, '.gitignore'), 'utf8'), /^\.aster\/$/m);
    assert.strictEqual(fs.readFileSync(planPath, 'utf8'), '# Keep this local task plan\n');
    assert.ok(!fs.existsSync(path.join(fixture.project, '.aster', 'install-state.json')));
    assert.deepStrictEqual(fs.readdirSync(fixture.home), []);
  } finally {
    cleanup(fixture);
  }
});

console.log(`\nResults: Passed: ${passed}, Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
