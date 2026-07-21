'use strict';

const fs = require('fs');
const path = require('path');

const CORE_SKILLS = Object.freeze([
  'harness-start', 'harness-plan', 'harness-implement', 'harness-verify',
  'harness-review', 'harness-debug', 'harness-finish', 'harness-release',
  'harness-parallel', 'strategic-compact', 'context-budget',
  'continuous-learning-v2', 'iterative-retrieval', 'growth-log',
  'intent-driven-development', 'search-first', 'codebase-onboarding',
  'code-tour', 'coding-standards', 'error-handling', 'git-workflow',
  'tdd-workflow', 'verification-loop', 'eval-harness',
  'architecture-decision-records', 'security-review', 'security-scan',
  'production-audit', 'delivery-gate', 'agent-self-evaluation',
  'agent-introspection-debugging', 'agent-harness-construction', 'skill-scout',
  'skill-stocktake', 'rules-distill', 'config-gc', 'hookify-rules',
  'team-agent-orchestration', 'plan-orchestrate', 'loop-design-check',
  'autonomous-loops', 'token-budget-advisor', 'cost-aware-llm-pipeline',
  'dmux-workflows',
]);

const CORE_AGENTS = Object.freeze([
  'planner', 'architect', 'code-architect', 'code-explorer', 'spec-miner',
  'tdd-guide', 'code-reviewer', 'security-reviewer', 'build-error-resolver',
  'silent-failure-hunter', 'code-simplifier', 'refactor-cleaner',
  'performance-optimizer', 'type-design-analyzer', 'comment-analyzer',
  'pr-test-analyzer', 'e2e-runner', 'doc-updater', 'docs-lookup',
  'harness-optimizer', 'loop-operator', 'agent-evaluator', 'a11y-architect',
]);

const STACK_PACKS = Object.freeze({
  web: {
    skills: ['frontend-patterns', 'e2e-testing', 'frontend-a11y'],
    agents: [],
  },
  typescript: {
    skills: [],
    agents: ['typescript-reviewer'],
  },
  react: {
    skills: ['react-patterns', 'react-testing', 'react-performance'],
    agents: ['react-reviewer', 'react-build-resolver'],
  },
  vue: {
    skills: ['vue-patterns'],
    agents: ['vue-reviewer'],
  },
  angular: {
    skills: ['angular-developer'],
    agents: [],
  },
  python: {
    skills: ['python-patterns', 'python-testing'],
    agents: ['python-reviewer'],
  },
  fastapi: {
    skills: ['fastapi-patterns'],
    agents: ['fastapi-reviewer'],
  },
  django: {
    skills: ['django-patterns', 'django-security', 'django-tdd', 'django-verification'],
    agents: ['django-reviewer', 'django-build-resolver'],
  },
  go: {
    skills: ['golang-patterns', 'golang-testing'],
    agents: ['go-reviewer', 'go-build-resolver'],
  },
  rust: {
    skills: ['rust-patterns', 'rust-testing'],
    agents: ['rust-reviewer', 'rust-build-resolver'],
  },
  java: {
    skills: ['java-coding-standards'],
    agents: ['java-reviewer', 'java-build-resolver'],
  },
  spring: {
    skills: ['springboot-patterns', 'springboot-security', 'springboot-tdd', 'springboot-verification', 'jpa-patterns'],
    agents: ['java-reviewer', 'java-build-resolver'],
  },
  kotlin: {
    skills: ['kotlin-patterns', 'kotlin-testing', 'kotlin-coroutines-flows', 'kotlin-ktor-patterns', 'kotlin-exposed-patterns'],
    agents: ['kotlin-reviewer', 'kotlin-build-resolver'],
  },
  cpp: {
    skills: ['cpp-coding-standards', 'cpp-testing'],
    agents: ['cpp-reviewer', 'cpp-build-resolver'],
  },
  dotnet: {
    skills: ['dotnet-patterns', 'csharp-testing', 'fsharp-testing'],
    agents: ['csharp-reviewer', 'fsharp-reviewer'],
  },
  laravel: {
    skills: ['laravel-patterns', 'laravel-security', 'laravel-tdd', 'laravel-verification'],
    agents: ['php-reviewer'],
  },
  flutter: {
    skills: ['dart-flutter-patterns', 'flutter-dart-code-review'],
    agents: ['flutter-reviewer', 'dart-build-resolver'],
  },
  swift: {
    skills: ['swift-actor-persistence', 'swift-concurrency-6-2', 'swift-protocol-di-testing', 'swiftui-patterns'],
    agents: ['swift-reviewer', 'swift-build-resolver'],
  },
  database: {
    skills: ['database-migrations'],
    agents: ['database-reviewer'],
  },
  prisma: {
    skills: ['prisma-patterns'],
    agents: ['database-reviewer'],
  },
  docker: {
    skills: ['docker-patterns'],
    agents: [],
  },
  kubernetes: {
    skills: ['kubernetes-patterns'],
    agents: [],
  },
  ml: {
    skills: ['mle-workflow', 'pytorch-patterns'],
    agents: ['mle-reviewer', 'pytorch-build-resolver'],
  },
});

const SKIP_DIRS = new Set([
  '.git', '.aster', '.agents', '.claude', '.codex', 'node_modules',
  'vendor', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__',
]);
const MANIFEST_NAMES = new Set([
  'package.json', 'tsconfig.json', 'pyproject.toml', 'requirements.txt',
  'setup.py', 'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'cmakelists.txt',
  'meson.build', 'composer.json', 'pubspec.yaml', 'package.swift',
  'schema.prisma', 'dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'global.json',
]);

function inspectProject(projectRoot) {
  const names = new Set();
  const extensions = new Set();
  const packages = new Set();
  const text = [];
  let visited = 0;

  function walk(directory, depth) {
    if (depth > 3 || visited >= 2000) return;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visited >= 2000) break;
      visited += 1;
      const lowerName = entry.name.toLowerCase();
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(lowerName)) {
          names.add(lowerName);
          walk(fullPath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) continue;

      names.add(lowerName);
      extensions.add(path.extname(lowerName));
      const readableYaml = lowerName.endsWith('.yaml') || lowerName.endsWith('.yml');
      if (!MANIFEST_NAMES.has(lowerName)
        && !lowerName.endsWith('.csproj')
        && !lowerName.endsWith('.fsproj')
        && !lowerName.endsWith('.sln')
        && !readableYaml) {
        continue;
      }

      try {
        const content = fs.readFileSync(fullPath, 'utf8').slice(0, 1024 * 1024);
        text.push(content.toLowerCase());
        if (lowerName === 'package.json') {
          const pkg = JSON.parse(content);
          for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
            for (const dependency of Object.keys(pkg[field] || {})) packages.add(dependency.toLowerCase());
          }
        }
      } catch {
        // Detection is best-effort; malformed manifests are handled by their own tools.
      }
    }
  }

  walk(path.resolve(projectRoot), 0);
  return { names, extensions, packages, corpus: text.join('\n') };
}

function detectStacks(projectRoot) {
  const { names, extensions, packages, corpus } = inspectProject(projectRoot);
  const result = [];
  const add = (id, matches) => { if (matches) result.push(id); };
  const hasPackage = (...ids) => ids.some(id => packages.has(id));
  const hasText = (...needles) => needles.some(needle => corpus.includes(needle));

  const react = hasPackage('react', 'next', 'react-native');
  const vue = hasPackage('vue', 'nuxt');
  const angular = hasPackage('@angular/core');
  add('web', react || vue || angular || hasPackage('vite', 'svelte', '@remix-run/react'));
  add('typescript', names.has('tsconfig.json') || hasPackage('typescript'));
  add('react', react);
  add('vue', vue);
  add('angular', angular);

  const python = names.has('pyproject.toml') || names.has('requirements.txt') || names.has('setup.py') || extensions.has('.py');
  add('python', python);
  add('fastapi', python && hasText('fastapi'));
  add('django', python && hasText('django'));
  add('go', names.has('go.mod') || extensions.has('.go'));
  add('rust', names.has('cargo.toml') || extensions.has('.rs'));
  const java = names.has('pom.xml') || names.has('build.gradle') || names.has('build.gradle.kts') || extensions.has('.java');
  add('java', java);
  add('spring', java && hasText('spring-boot', 'org.springframework'));
  add('kotlin', extensions.has('.kt') || extensions.has('.kts') || hasText('kotlin("', 'org.jetbrains.kotlin'));
  add('cpp', names.has('cmakelists.txt') || names.has('meson.build') || extensions.has('.c') || extensions.has('.h') || extensions.has('.hpp') || extensions.has('.cpp') || extensions.has('.cc') || extensions.has('.cxx'));
  add('dotnet', names.has('global.json') || [...names].some(name => name.endsWith('.sln') || name.endsWith('.csproj') || name.endsWith('.fsproj')) || extensions.has('.cs') || extensions.has('.fs'));
  add('laravel', names.has('composer.json') && hasText('laravel/framework'));
  add('flutter', names.has('pubspec.yaml') && hasText('flutter:'));
  add('swift', names.has('package.swift') || [...names].some(name => name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace')) || extensions.has('.swift'));
  const prisma = names.has('schema.prisma') || hasPackage('prisma', '@prisma/client');
  add('database', prisma || hasPackage('typeorm', 'sequelize', 'knex', 'drizzle-orm', 'mongoose') || hasText('sqlalchemy', 'psycopg', 'mysqlclient'));
  add('prisma', prisma);
  add('docker', names.has('dockerfile') || names.has('docker-compose.yml') || names.has('docker-compose.yaml'));
  add('kubernetes', names.has('k8s') || names.has('kubernetes') || hasText('apiversion: apps/v1'));
  add('ml', hasPackage('@tensorflow/tfjs') || hasText('torch', 'tensorflow', 'scikit-learn'));
  return result;
}

function unique(values) {
  return [...new Set(values)];
}

function classifySelector(rawSelector) {
  const selector = String(rawSelector || '').trim();
  if (!selector) throw new Error('Empty --with/--without selector');
  const separator = selector.indexOf(':');
  const prefix = separator > 0 ? selector.slice(0, separator) : null;
  const value = separator > 0 ? selector.slice(separator + 1) : selector;
  const stackNames = Object.keys(STACK_PACKS);
  const skillNames = unique([...CORE_SKILLS, ...stackNames.flatMap(id => STACK_PACKS[id].skills)]);
  const agentNames = unique([...CORE_AGENTS, ...stackNames.flatMap(id => STACK_PACKS[id].agents)]);

  if ((prefix === 'stack' || prefix === 'pack') && STACK_PACKS[value]) return { type: 'stack', value };
  if (prefix === 'skill' && skillNames.includes(value)) return { type: 'skill', value };
  if (prefix === 'agent' && agentNames.includes(value)) return { type: 'agent', value };
  if (!prefix && STACK_PACKS[value]) return { type: 'stack', value };
  if (!prefix && skillNames.includes(value)) return { type: 'skill', value };
  if (!prefix && agentNames.includes(value)) return { type: 'agent', value };
  throw new Error(`Unknown harness component: ${selector}`);
}

function selectContent(projectRoot, options = {}) {
  const detectedStacks = options.stacks === 'none' ? [] : detectStacks(projectRoot);
  if (Array.isArray(options.stacks)) {
    for (const id of options.stacks) {
      if (!STACK_PACKS[id]) throw new Error(`Unknown harness stack: ${id}`);
    }
  }
  const stackIds = new Set(Array.isArray(options.stacks) ? options.stacks : detectedStacks);
  const includedSkills = [];
  const includedAgents = [];
  const excludedSkills = new Set();
  const excludedAgents = new Set();

  for (const selector of options.with || []) {
    const item = classifySelector(selector);
    if (item.type === 'stack') stackIds.add(item.value);
    if (item.type === 'skill') includedSkills.push(item.value);
    if (item.type === 'agent') includedAgents.push(item.value);
  }
  for (const selector of options.without || []) {
    const item = classifySelector(selector);
    if (item.type === 'stack') stackIds.delete(item.value);
    if (item.type === 'skill') excludedSkills.add(item.value);
    if (item.type === 'agent') excludedAgents.add(item.value);
  }

  const stacks = Object.keys(STACK_PACKS).filter(id => stackIds.has(id));
  const stackSkills = stacks.flatMap(id => STACK_PACKS[id].skills);
  const stackAgents = stacks.flatMap(id => STACK_PACKS[id].agents);
  return {
    detectedStacks,
    stacks,
    skills: unique([...CORE_SKILLS, ...stackSkills, ...includedSkills]).filter(id => !excludedSkills.has(id)),
    agents: unique([...CORE_AGENTS, ...stackAgents, ...includedAgents]).filter(id => !excludedAgents.has(id)),
  };
}

module.exports = {
  CORE_AGENTS,
  CORE_SKILLS,
  STACK_PACKS,
  detectStacks,
  selectContent,
};
