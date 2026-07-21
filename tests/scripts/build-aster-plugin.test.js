'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { allAgents, buildPlugin } = require('../../scripts/build-aster-plugin');
const { CORE_SKILLS } = require('../../scripts/lib/aster/manifest');
const { requireHarnessTestIsolation } = require('../../scripts/lib/aster/test-isolation');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL ${name}: ${error.message}`);
    failed += 1;
  }
}

const repoRoot = path.resolve(__dirname, '..', '..');

const isolation = requireHarnessTestIsolation(repoRoot);
const fixtureRoot = path.join(isolation.testRoot, 'fixtures');
fs.mkdirSync(fixtureRoot, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(fixtureRoot, 'aster-plugin-'));
const pluginRoot = path.join(tempRoot, 'plugin');

function generatedDigest(root) {
  const hash = crypto.createHash('sha256');
  const pending = ['skills', 'commands', 'agents', 'hooks', 'scripts', 'assets', 'LICENSE'];
  while (pending.length > 0) {
    const relativePath = pending.shift();
    const fullPath = path.join(root, relativePath);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(fullPath).sort()) pending.push(path.join(relativePath, name));
    } else {
      hash.update(relativePath.split(path.sep).join('/'));
      hash.update(fs.readFileSync(fullPath));
    }
  }
  return hash.digest('hex');
}

try {
  const result = buildPlugin(pluginRoot);

  test('builds the curated self-contained surface', () => {
    assert.strictEqual(result.skills, 44);
    assert.strictEqual(result.commands, 9);
    assert.strictEqual(result.agents, allAgents().length);
    assert.strictEqual(fs.readdirSync(path.join(pluginRoot, 'skills')).length, CORE_SKILLS.length);
    assert.strictEqual(fs.readdirSync(path.join(pluginRoot, 'commands')).length, 9);
    assert.strictEqual(fs.readdirSync(path.join(pluginRoot, 'agents')).length, allAgents().length);
  });

  test('ships both manifests, hooks, assets, and license', () => {
    for (const relativePath of [
      '.codex-plugin/plugin.json',
      '.claude-plugin/plugin.json',
      'hooks/hooks.json',
      'scripts/aster-hooks/runner.js',
      'scripts/aster/records.js',
      'assets/ecc-icon.svg',
      'assets/hero.png',
      'LICENSE',
    ]) {
      assert.ok(fs.existsSync(path.join(pluginRoot, relativePath)), relativePath);
    }
  });

  test('keeps manifest references inside the plugin', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
    for (const reference of [manifest.skills, manifest.interface.composerIcon, manifest.interface.logo]) {
      assert.ok(!reference.includes('..'), reference);
      const resolved = path.resolve(pluginRoot, reference);
      assert.ok(resolved.startsWith(pluginRoot + path.sep), reference);
      assert.ok(fs.existsSync(resolved), reference);
    }
  });

  test('uses short Claude plugin commands', () => {
    for (const name of ['start', 'plan', 'implement', 'verify', 'review', 'debug', 'finish', 'release', 'parallel']) {
      const command = fs.readFileSync(path.join(pluginRoot, 'commands', `${name}.md`), 'utf8');
      assert.ok(command.includes(`canonical \`harness-${name}\` skill`));
      assert.strictEqual((command.match(/\$ARGUMENTS/g) || []).length, 1);
    }
    assert.ok(!fs.existsSync(path.join(pluginRoot, 'commands', 'harness-plan.md')));
  });

  test('resolves Claude manifest component paths inside the plugin', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
    for (const reference of [...manifest.skills, ...manifest.commands]) {
      assert.ok(!reference.includes('..'), reference);
      assert.ok(fs.existsSync(path.resolve(pluginRoot, reference)), reference);
    }
  });

  test('does not direct installed skills to execute target project helper names', () => {
    for (const skill of ['tdd-workflow', 'autonomous-loops', 'dmux-workflows']) {
      const source = fs.readFileSync(path.join(pluginRoot, 'skills', skill, 'SKILL.md'), 'utf8');
      assert.doesNotMatch(source, /node scripts\/(?:setup-package-manager|claw|orchestrate-worktrees)\.js/);
    }
  });

  test('matches the committed canonical generated content', () => {
    assert.strictEqual(generatedDigest(pluginRoot), generatedDigest(path.join(repoRoot, 'plugins', 'aster')));
  });

  test('rejects destructive output locations', () => {
    assert.throws(() => buildPlugin(path.resolve(__dirname, '..', '..')), /Refusing plugin output/);
    const unrelated = path.join(tempRoot, 'unrelated');
    fs.mkdirSync(path.join(unrelated, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(unrelated, 'skills', 'keep.txt'), 'keep');
    assert.throws(() => buildPlugin(unrelated), /Refusing non-plugin output/);
    assert.strictEqual(fs.readFileSync(path.join(unrelated, 'skills', 'keep.txt'), 'utf8'), 'keep');
  });
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
