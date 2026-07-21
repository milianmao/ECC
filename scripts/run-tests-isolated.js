#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  TEST_MODE,
  assertInside,
} = require('./lib/aster/test-isolation');

const REPO_ROOT = fs.realpathSync(path.resolve(__dirname, '..'));
const TEMP_PARENT = path.join(REPO_ROOT, 'temp');
const BLOCKED_COMMANDS = ['codex', 'claude', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx'];

const REPO_COMMANDS = [
  ['unicode safety', process.execPath, ['scripts/ci/check-unicode-safety.js']],
  ['agent validator', process.execPath, ['scripts/ci/validate-agents.js']],
  ['command validator', process.execPath, ['scripts/ci/validate-commands.js']],
  ['rules validator', process.execPath, ['scripts/ci/validate-rules.js']],
  ['skills validator', process.execPath, ['scripts/ci/validate-skills.js']],
  ['hooks validator', process.execPath, ['scripts/ci/validate-hooks.js']],
  ['install manifest validator', process.execPath, ['scripts/ci/validate-install-manifests.js']],
  ['personal path validator', process.execPath, ['scripts/ci/validate-no-personal-paths.js']],
  ['catalog check', process.execPath, ['scripts/ci/catalog.js', '--text']],
  ['command registry check', process.execPath, ['scripts/ci/generate-command-registry.js', '--check']],
  ['repository tests', process.execPath, ['tests/run-all.js']],
];

const ASTER_COMMANDS = [
  ['aster CLI tests', process.execPath, ['tests/scripts/aster.test.js']],
  ['aster hook tests', process.execPath, ['tests/scripts/aster-hooks.test.js']],
  ['aster plugin build tests', process.execPath, ['tests/scripts/build-aster-plugin.test.js']],
];

function safeRemove(sandbox) {
  assertInside(REPO_ROOT, sandbox, 'Aster test cleanup');
  if (!path.basename(sandbox).startsWith('run-')) {
    throw new Error(`Refusing unexpected harness test cleanup path: ${sandbox}`);
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
}

function writeCommandShims(shimRoot) {
  fs.mkdirSync(shimRoot, { recursive: true });
  const guardPath = path.join(shimRoot, 'guard.js');
  fs.writeFileSync(guardPath, [
    "'use strict';",
    "const command = process.argv[2] || 'unknown';",
    "process.stderr.write(`Blocked global command in project-isolated harness test: ${command} ${process.argv.slice(3).join(' ')}\\n`);",
    'process.exitCode = 86;',
    '',
  ].join('\n'));

  for (const command of BLOCKED_COMMANDS) {
    const posixPath = path.join(shimRoot, command);
    fs.writeFileSync(posixPath, [
      '#!/usr/bin/env node',
      `'use strict'; require('./guard.js');`,
      '',
    ].join('\n'));
    try { fs.chmodSync(posixPath, 0o755); } catch { /* Windows ignores POSIX modes. */ }

    const windowsPath = path.join(shimRoot, `${command}.cmd`);
    fs.writeFileSync(
      windowsPath,
      `@echo off\r\n"${process.execPath}" "%~dp0guard.js" ${command} %*\r\nexit /b %ERRORLEVEL%\r\n`
    );
  }
}

function commandDirectory(command) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(finder, [command], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Required test command is unavailable: ${command}`);
  const first = String(result.stdout || '').split(/\r?\n/).find(Boolean);
  if (!first) throw new Error(`Could not resolve required test command: ${command}`);
  return path.dirname(path.resolve(first.trim()));
}

function createEnvironment(sandbox, blockCommands, options = {}) {
  const home = path.join(sandbox, 'home');
  const tmp = path.join(sandbox, 'tmp');
  const appData = path.join(sandbox, 'appdata');
  const localAppData = path.join(sandbox, 'localappdata');
  const npmRoot = path.join(sandbox, 'npm');
  const directories = [home, tmp, appData, localAppData, npmRoot];
  for (const directory of directories) fs.mkdirSync(directory, { recursive: true });
  const npmrc = path.join(npmRoot, 'npmrc');
  const globalNpmrc = path.join(npmRoot, 'global-npmrc');
  fs.writeFileSync(npmrc, 'update-notifier=false\nfund=false\naudit=false\n');
  fs.writeFileSync(globalNpmrc, 'update-notifier=false\nfund=false\naudit=false\n');

  const isolatedTemp = options.isolateTemp === false ? {} : {
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
  };
  const env = {
    ...process.env,
    ASTER_TEST_MODE: TEST_MODE,
    ASTER_TEST_ROOT: sandbox,
    ASTER_REPO_ROOT: REPO_ROOT,
    HOME: home,
    USERPROFILE: home,
    AGENTS_HOME: path.join(home, '.agents'),
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CLAUDE_PLUGIN_DATA: path.join(home, '.claude-plugin-data'),
    PLUGIN_DATA: path.join(home, '.codex-plugin-data'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    ...isolatedTemp,
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    // The repository-local sandbox lives below this repo's own .git directory.
    // Stop fixture Git commands from accidentally treating the harness repo as
    // their project while still allowing real fixture repositories to resolve.
    GIT_CEILING_DIRECTORIES: sandbox,
    npm_config_cache: path.join(npmRoot, 'cache'),
    npm_config_prefix: path.join(npmRoot, 'prefix'),
    npm_config_userconfig: npmrc,
    npm_config_globalconfig: globalNpmrc,
    NPM_CONFIG_CACHE: path.join(npmRoot, 'cache'),
    NPM_CONFIG_PREFIX: path.join(npmRoot, 'prefix'),
    NPM_CONFIG_USERCONFIG: npmrc,
    NPM_CONFIG_GLOBALCONFIG: globalNpmrc,
    npm_config_update_notifier: 'false',
    NO_UPDATE_NOTIFIER: '1',
    PNPM_HOME: path.join(sandbox, 'pnpm'),
    YARN_CACHE_FOLDER: path.join(sandbox, 'yarn-cache'),
    BUN_INSTALL: path.join(sandbox, 'bun'),
    CI: '1',
  };

  if (blockCommands) {
    const shimRoot = path.join(sandbox, 'blocked-commands');
    writeCommandShims(shimRoot);
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
    const safePath = [
      shimRoot,
      path.dirname(process.execPath),
      commandDirectory('git'),
      process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin',
      process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows') : '/bin',
    ].filter((value, index, values) => values.indexOf(value) === index);
    env[pathKey] = safePath.join(path.delimiter);
    env.ASTER_BLOCK_GLOBAL_COMMANDS = '1';
  }
  return env;
}

function summarizePackage(output) {
  const payload = JSON.parse(output);
  const artifact = Array.isArray(payload) ? payload[0] : null;
  if (!artifact || !Array.isArray(artifact.files)) throw new Error('npm pack returned no file inventory');
  const files = new Set(artifact.files.map(entry => String(entry.path || '').replace(/\\/g, '/')));
  const required = [
    'scripts/aster.js',
    'scripts/lib/aster/records.js',
    'plugins/aster/.codex-plugin/plugin.json',
    'plugins/aster/.claude-plugin/plugin.json',
    'plugins/aster/scripts/aster-hooks/runner.js',
    'plugins/aster/scripts/aster/records.js',
  ];
  const missing = required.filter(filePath => !files.has(filePath));
  if (missing.length > 0) throw new Error(`npm package is missing Aster files: ${missing.join(', ')}`);
  if ([...files].some(filePath => filePath === '..' || filePath.startsWith('../'))) {
    throw new Error('npm package inventory contains a parent-relative path');
  }
  process.stdout.write(
    `npm pack: ${artifact.files.length} files, ${artifact.unpackedSize || 0} unpacked bytes; Aster files present.\n`
  );
}

function runCommand(label, command, args, env, outputMode) {
  process.stdout.write(`\n[isolated] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env,
    ...(outputMode ? { encoding: 'utf8' } : { stdio: 'inherit' }),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (outputMode && result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${label} exited with status ${result.status}`);
  }
  if (outputMode === 'npm-pack') summarizePackage(result.stdout);
}

function verifyBlockedCommands(env) {
  for (const [command, args] of [
    ['codex', ['plugin', 'add', 'fixture@fixture']],
    ['codex', ['plugin', 'marketplace', 'add', 'fixture']],
    ['claude', ['plugin', 'install', 'fixture@fixture']],
    ['claude', ['plugin', 'marketplace', 'add', 'fixture']],
    ['npm', ['link']],
    ['npx', ['fixture']],
    ['pnpm', ['add', '--global', 'fixture']],
    ['yarn', ['global', 'add', 'fixture']],
    ['bun', ['add', '--global', 'fixture']],
    ['bunx', ['fixture']],
  ]) {
    const result = spawnSync(command, args, {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (result.status !== 86 || !/Blocked global command/.test(result.stderr || '')) {
      throw new Error(`Global command guard failed for ${command} ${args.join(' ')}`);
    }
  }
}

function coverageCommand() {
  const c8 = require.resolve('c8/bin/c8.js');
  return [[
    'coverage',
    process.execPath,
    [
      c8,
      '--all',
      '--include=scripts/**/*.js',
      '--check-coverage',
      '--lines', '80',
      '--functions', '80',
      '--branches', '79',
      '--statements', '80',
      '--reporter=text',
      '--reporter=lcov',
      'tests/run-all.js',
    ],
  ]];
}

function commandsFor(mode) {
  if (mode === 'repo') return REPO_COMMANDS;
  if (mode === 'aster') return ASTER_COMMANDS;
  if (mode === 'coverage') return coverageCommand();
  if (mode === 'pack') {
    const args = ['pack', '--dry-run', '--ignore-scripts', '--json'];
    if (process.env.npm_execpath) {
      return [['npm package dry-run', process.execPath, [process.env.npm_execpath, ...args], 'npm-pack']];
    }

    // A .cmd file is not directly spawnable by Node on Windows (spawnSync
    // reports EINVAL). Invoke it through the native command interpreter when
    // this runner is launched directly with `node`, outside an npm script.
    if (process.platform === 'win32') {
      const commandShell = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
      return [[
        'npm package dry-run',
        commandShell,
        ['/d', '/s', '/c', ['npm.cmd', ...args].join(' ')],
        'npm-pack',
      ]];
    }

    return [['npm package dry-run', 'npm', args, 'npm-pack']];
  }
  if (mode === 'claude-plugin') {
    return [['Claude plugin validator', 'claude', ['plugin', 'validate', '--strict', 'plugins/aster']]];
  }
  throw new Error('Usage: node scripts/run-tests-isolated.js <repo|aster|coverage|pack|claude-plugin>');
}

function main(argv = process.argv.slice(2)) {
  const mode = argv[0];
  const blockCommands = mode === 'aster';
  fs.mkdirSync(TEMP_PARENT, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(TEMP_PARENT, 'run-'));
  assertInside(REPO_ROOT, sandbox, 'Aster test sandbox');
  const isolateTemp = mode !== 'repo' && mode !== 'coverage';
  const env = createEnvironment(sandbox, blockCommands, { isolateTemp });
  try {
    if (blockCommands) verifyBlockedCommands(env);
    for (const [label, command, args, outputMode] of commandsFor(mode)) {
      runCommand(label, command, args, env, outputMode);
    }
    process.stdout.write(`\nIsolated ${mode} tests passed; sandbox removed.\n`);
    return 0;
  } finally {
    safeRemove(sandbox);
  }
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`Isolated test failure: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { BLOCKED_COMMANDS, commandsFor, createEnvironment, main, safeRemove };
