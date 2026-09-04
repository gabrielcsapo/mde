import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const packages = [
  {
    directory: 'web/plugin-sdk',
    name: '@mdink/plugin-sdk',
    required: ['package/dist/index.js', 'package/dist/index.d.ts'],
  },
  {
    directory: 'web',
    name: '@mdink/web',
    required: [
      'package/dist/index.js',
      'package/dist/mde.wasm',
      'package/dist/types/src/index.d.ts',
      'package/src/theme.css',
    ],
  },
  {
    directory: 'web/plugins',
    name: '@mdink/plugins',
    required: [
      'package/dist/composer.js',
      'package/dist/types/composer.d.ts',
      'package/extensions.css',
    ],
  },
  {
    directory: 'web/react',
    name: '@mdink/react',
    required: ['package/dist/index.js', 'package/types/index.d.ts'],
  },
];

const commonFiles = ['package/package.json', 'package/README.md', 'package/CHANGELOG.md', 'package/LICENSE'];
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'mde-pack-check-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
  }

  return result.stdout.trim();
}

try {
  for (const packageSpec of packages) {
    const output = run('pnpm', [
      '--dir',
      packageSpec.directory,
      'pack',
      '--pack-destination',
      temporaryDirectory,
      '--json',
    ]);
    const packed = JSON.parse(output);
    const archive = isAbsolute(packed.filename)
      ? packed.filename
      : join(temporaryDirectory, packed.filename);
    const entries = new Set(run('tar', ['-tzf', archive]).split('\n'));

    for (const file of [...commonFiles, ...packageSpec.required]) {
      if (!entries.has(file)) throw new Error(`${packageSpec.name} is missing ${file}`);
    }

    const manifest = JSON.parse(run('tar', ['-xOzf', archive, 'package/package.json']));
    if (manifest.name !== packageSpec.name) {
      throw new Error(`${packageSpec.directory} packed as ${manifest.name}`);
    }
    if (manifest.publishConfig?.access !== 'public') {
      throw new Error(`${packageSpec.name} must publish publicly`);
    }

    const dependencyRanges = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    for (const [name, range] of Object.entries(dependencyRanges)) {
      if (String(range).startsWith('workspace:')) {
        throw new Error(`${packageSpec.name} left ${name} as ${range} in its tarball`);
      }
    }

    console.log(`✓ ${packageSpec.name}@${manifest.version} (${entries.size} files)`);
  }
} finally {
  const validatedPrefix = join(tmpdir(), 'mde-pack-check-');
  if (!temporaryDirectory.startsWith(validatedPrefix)) {
    throw new Error(`Refusing to clean unexpected directory: ${temporaryDirectory}`);
  }
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
