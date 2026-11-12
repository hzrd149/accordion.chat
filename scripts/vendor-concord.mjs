import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const revision = '00ceaa38355d';
const source = resolve(process.argv[2] ?? '../applesauce-concord');
const actual = execFileSync('git', ['-C', source, 'rev-parse', revision], { encoding: 'utf8' }).trim();
if (!actual.startsWith(revision)) throw new Error(`Expected ${revision}, got ${actual}`);
const temporary = await mkdtemp(join(tmpdir(), 'accordion-vendor-'));
try {
  const directory = join(temporary, 'package');
  const archive = execFileSync('git', ['-C', source, 'archive', actual, 'src', 'e2e', 'LICENSE', 'deno.json', 'deno.lock', 'CHANGELOG.md'], { maxBuffer: 16 * 1024 * 1024 });
  await writeFile(join(temporary, 'source.tar'), archive);
  await mkdir(directory);
  execFileSync('tar', ['-xf', join(temporary, 'source.tar'), '-C', directory]);
  const config = JSON.parse(await readFile(join(directory, 'deno.json'), 'utf8'));
  const manifest = {
    name: '@applesauce/concord', version: `0.1.0-dev.${revision}`, type: 'module', license: 'MIT',
    exports: Object.fromEntries(Object.entries(config.exports).map(([key, value]) => [key, {
      types: value.replace('./src/', './dist/').replace('.ts', '.d.ts'),
      import: value.replace('./src/', './dist/').replace('.ts', '.js'),
    }])),
    peerDependencies: {
      'applesauce-core': '^7.1.3', 'applesauce-common': '^7.1.1', 'applesauce-relay': '^7.1.1',
      'applesauce-signers': '^7.1.0', 'applesauce-loaders': '^7.2.0', rxjs: '^7.8.2',
      '@noble/curves': '^2.2.0', '@noble/hashes': '^2.2.0',
    },
    dependencies: { '@scure/base': '^2.2.0' },
  };
  await writeFile(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(directory, 'PROVENANCE.json'), JSON.stringify({
    repository: 'nostr://hzrd149.com/git.shakespeare.diy/applesauce-concord', revision: actual,
    changes: 'Added Node manifest and compiled JavaScript/declarations; upstream source unmodified.',
  }, null, 2) + '\n');
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', outDir: 'dist', rootDir: 'src',
      declaration: true, noCheck: true, rewriteRelativeImportExtensions: true, skipLibCheck: true },
    include: ['src/**/*.ts'], exclude: ['src/**/__tests__/**'],
  }) + '\n');
  // Transpilation only: upstream Deno tests/checks own source type validation.
  execFileSync(resolve('node_modules/.bin/tsc'), ['-p', join(directory, 'tsconfig.json')], { stdio: 'inherit' });
  execFileSync('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf',
    resolve(`vendor/applesauce-concord-${revision}.tgz`), '-C', temporary, 'package']);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
