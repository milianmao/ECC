#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  assertProjectTestIsolation,
  decideMemory,
  doctor,
  install,
  listMemory,
  plan,
  uninstall,
} = require('./lib/aster');

const COMMANDS = new Set(['init', 'plan', 'update', 'doctor', 'uninstall', 'memory']);

function help() {
  return `
  Aster project harness for Claude Code and Codex

Usage:
  aster init [options]
  aster plan [options]
  aster update [options]
  aster doctor [--json]
  aster uninstall [--dry-run] [--json]
  aster memory list [--json]
  aster memory approve <id> [--dry-run] [--json]
  aster memory reject <id> [--dry-run] [--json]

Options:
  --target <both|claude|codex>  Install project-local surfaces (default: both)
  --codex                       Shortcut for --target codex
  --claude                      Shortcut for --target claude
  --both                        Shortcut for --target both
  --distribution <project|plugin-overlay>
                                Install the full project bundle or a thin plugin overlay
  --plugin                      Shortcut for --distribution plugin-overlay
  --with <component>           Add a stack, skill:<name>, or agent:<name>
  --without <component>        Remove a stack, skill:<name>, or agent:<name>
  --dry-run                    Preview without writing
  --force                      Replace drifted managed files during init/update
  --json                       Emit machine-readable output
  --help                       Show this help
`;
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = { with: [], without: [], dryRun: false, force: false, json: false };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--target') {
      const target = takeValue(argv, index, arg);
      if (options.target && options.target !== target) throw new Error('Conflicting target options');
      options.target = target;
      index += 1;
    } else if (arg === '--codex' || arg === '--claude' || arg === '--both') {
      const target = arg.slice(2);
      if (options.target && options.target !== target) throw new Error('Conflicting target options');
      options.target = target;
    } else if (arg === '--distribution') {
      const distribution = takeValue(argv, index, arg);
      if (options.distribution && options.distribution !== distribution) {
        throw new Error('Conflicting distribution options');
      }
      options.distribution = distribution;
      index += 1;
    } else if (arg === '--plugin') {
      if (options.distribution && options.distribution !== 'plugin-overlay') {
        throw new Error('Conflicting distribution options');
      }
      options.distribution = 'plugin-overlay';
    } else if (arg === '--with' || arg === '--without') {
      const key = arg === '--with' ? 'with' : 'without';
      options[key].push(...takeValue(argv, index, arg).split(',').map(value => value.trim()).filter(Boolean));
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length === 0) return { command: null, options, args: [] };
  if (!COMMANDS.has(positionals[0])) throw new Error(`Unknown command: ${positionals[0]}`);
  return { command: positionals[0], options, args: positionals.slice(1) };
}

function printText(result) {
  if (result.healthy !== undefined) {
    console.log(result.healthy ? 'aster: healthy' : 'aster: issues found');
    for (const issue of result.issues) console.log(`- ${issue.path || 'project'}: ${issue.reason}`);
    return;
  }
  if (result.candidates) {
    if (result.candidates.length === 0) console.log('No pending memory candidates.');
    for (const candidate of result.candidates) console.log(`${candidate.id}\t${candidate.content}`);
    return;
  }
  if (result.action && result.candidate) {
    console.log(`${result.dryRun ? 'Would ' : ''}${result.action} ${result.candidate.id}`);
    return;
  }
  if (result.removed) {
    console.log(
      `${result.dryRun ? 'Would remove' : 'Removed'} ${result.removed.length} managed files; `
      + `${result.dryRun ? 'would update' : 'updated'} ${result.updated?.length || 0} config files; `
      + `preserved ${result.preserved.length}.`
    );
    return;
  }
  console.log(`${result.command}: ${result.ok ? 'ready' : 'blocked'} (${result.files.length} files, ${result.skills.length} skills, ${result.agents.length} agents)`);
  for (const conflict of result.conflicts) console.log(`- conflict ${conflict.path}: ${conflict.reason}`);
}

function emit(result, json) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else printText(result);
}

function resolveProjectRoot(cwd = process.cwd()) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  const candidate = String(result.stdout || '').trim();
  if (result.status !== 0 || !candidate) {
    throw new Error('aster must be run from inside a Git project; no project files were written');
  }
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(path.resolve(candidate)) : fs.realpathSync(path.resolve(candidate));
  } catch (error) {
    throw new Error(`Unable to resolve the Git project root: ${error.message}`);
  }
}

function run(parsed) {
  const { command, options, args } = parsed;
  if (!command || options.help) {
    process.stdout.write(help());
    return 0;
  }
  const projectRoot = resolveProjectRoot(process.cwd());
  assertProjectTestIsolation(projectRoot);
  let result;
  if (command === 'init' || command === 'update') {
    if (args.length > 0) throw new Error(`${command} takes no positional arguments`);
    result = install(projectRoot, command, options);
  } else if (command === 'plan') {
    if (args.length > 0) throw new Error('plan takes no positional arguments');
    result = plan(projectRoot, options);
  } else if (command === 'doctor') {
    if (args.length > 0) throw new Error('doctor takes no positional arguments');
    result = doctor(projectRoot);
  } else if (command === 'uninstall') {
    if (args.length > 0) throw new Error('uninstall takes no positional arguments');
    result = uninstall(projectRoot, options);
  } else {
    const action = args[0];
    if (action === 'list' && args.length === 1) result = listMemory(projectRoot);
    else if ((action === 'approve' || action === 'reject') && args.length === 2) {
      result = decideMemory(projectRoot, action, args[1], options);
    } else {
      throw new Error('Usage: aster memory list|approve <id>|reject <id>');
    }
  }
  emit(result, options.json);
  if (result.ok === false || result.healthy === false) return 1;
  return 0;
}

function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    return run(parsed);
  } catch (error) {
    if (parsed?.options.json || argv.includes('--json')) {
      console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
    } else {
      console.error(`Error: ${error.message}`);
    }
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { main, parseArgs, resolveProjectRoot };
