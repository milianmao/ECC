#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const {
  CORE_AGENTS,
  CORE_SKILLS,
  STACK_PACKS,
} = require('./lib/aster/manifest');

const REPO_ROOT = path.resolve(__dirname, '..');
const CANONICAL_PLUGIN_ROOT = path.join(REPO_ROOT, 'plugins', 'aster');
const WORKFLOW_SKILLS = CORE_SKILLS.filter(name => name.startsWith('harness-'));

function unique(values) {
  return [...new Set(values)];
}

function allAgents() {
  return unique([
    ...CORE_AGENTS,
    ...Object.values(STACK_PACKS).flatMap(pack => pack.agents),
  ]);
}

function copy(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Missing plugin source: ${source}`);
  fs.cpSync(source, destination, {
    recursive: true,
    filter: value => !['__pycache__', '.pytest_cache'].includes(path.basename(value)),
  });
}

function reset(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
}

function assertSafeOutput(output) {
  if (output === REPO_ROOT || REPO_ROOT.startsWith(`${output}${path.sep}`)) {
    throw new Error(`Refusing plugin output at repository root or its ancestor: ${output}`);
  }
  if (!fs.existsSync(output)) return;
  if (fs.lstatSync(output).isSymbolicLink()) {
    throw new Error(`Refusing symlink plugin output: ${output}`);
  }
  const entries = fs.readdirSync(output);
  const isPlugin = fs.existsSync(path.join(output, '.codex-plugin', 'plugin.json'))
    && fs.existsSync(path.join(output, '.claude-plugin', 'plugin.json'));
  if (entries.length > 0 && !isPlugin) {
    throw new Error(`Refusing non-plugin output directory: ${output}`);
  }
}

function buildPlugin(outputRoot = CANONICAL_PLUGIN_ROOT) {
  const output = path.resolve(outputRoot);
  assertSafeOutput(output);
  fs.mkdirSync(output, { recursive: true });

  if (output !== CANONICAL_PLUGIN_ROOT) {
    copy(path.join(CANONICAL_PLUGIN_ROOT, '.codex-plugin'), path.join(output, '.codex-plugin'));
    copy(path.join(CANONICAL_PLUGIN_ROOT, '.claude-plugin'), path.join(output, '.claude-plugin'));
  }

  const skillsRoot = path.join(output, 'skills');
  const commandsRoot = path.join(output, 'commands');
  const agentsRoot = path.join(output, 'agents');
  const hooksRoot = path.join(output, 'hooks');
  const scriptsRoot = path.join(output, 'scripts');
  const assetsRoot = path.join(output, 'assets');
  for (const directory of [skillsRoot, commandsRoot, agentsRoot, hooksRoot, scriptsRoot, assetsRoot]) {
    reset(directory);
  }

  for (const skill of CORE_SKILLS) {
    copy(path.join(REPO_ROOT, 'skills', skill), path.join(skillsRoot, skill));
  }
  for (const skill of WORKFLOW_SKILLS) {
    const shortName = skill.slice('harness-'.length);
    copy(path.join(REPO_ROOT, 'commands', `${skill}.md`), path.join(commandsRoot, `${shortName}.md`));
  }
  for (const agent of allAgents()) {
    copy(path.join(REPO_ROOT, 'agents', `${agent}.md`), path.join(agentsRoot, `${agent}.md`));
  }

  copy(path.join(REPO_ROOT, 'hooks', 'aster-hooks.json'), path.join(hooksRoot, 'hooks.json'));
  copy(path.join(REPO_ROOT, 'scripts', 'aster-hooks'), path.join(scriptsRoot, 'aster-hooks'));
  copy(
    path.join(REPO_ROOT, 'scripts', 'lib', 'aster', 'records.js'),
    path.join(scriptsRoot, 'aster', 'records.js')
  );
  copy(path.join(REPO_ROOT, 'assets', 'ecc-icon.svg'), path.join(assetsRoot, 'ecc-icon.svg'));
  copy(path.join(REPO_ROOT, 'assets', 'hero.png'), path.join(assetsRoot, 'hero.png'));
  copy(path.join(REPO_ROOT, 'LICENSE'), path.join(output, 'LICENSE'));

  return {
    output,
    skills: CORE_SKILLS.length,
    commands: WORKFLOW_SKILLS.length,
    agents: allAgents().length,
  };
}

function main() {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : CANONICAL_PLUGIN_ROOT;
  if (outputIndex >= 0 && !output) throw new Error('--output requires a path');
  const result = buildPlugin(output);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { allAgents, assertSafeOutput, buildPlugin };
