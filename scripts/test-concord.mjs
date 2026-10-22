import { mkdtemp, cp, rm, realpath, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

// Deno cannot strip TypeScript inside node_modules. Run the exact vendored
// upstream sources outside that directory, with its pinned Deno lockfile.
const directory = await mkdtemp(join(tmpdir(), 'accordion-concord-'));
try {
  const source = await realpath('node_modules/@applesauce/concord');
  for (const name of ['src', 'deno.json', 'deno.lock']) {
    await cp(join(source, name), join(directory, name), { recursive: true });
  }
  const configPath = join(directory, 'deno.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  delete config.workspace;
  config.nodeModulesDir = 'auto';
  // Test the same SDK versions as the application rather than future ^7 releases.
  for (const [specifier, target] of Object.entries(config.imports)) {
    if (!target.startsWith('npm:')) continue;
    const packageName = specifier.replace(/\/$/, '');
    const require = createRequire(join(source, 'package.json'));
    let packageDirectory = dirname(require.resolve(packageName));
    let manifest;
    while (!manifest) {
      try {
        const candidate = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
        if (candidate.name === packageName) manifest = candidate;
      } catch { /* Entry point may be nested below the package manifest. */ }
      if (!manifest) {
        const parent = dirname(packageDirectory);
        if (parent === packageDirectory) throw new Error(`Missing manifest for ${packageName}`);
        packageDirectory = parent;
      }
    }
    config.imports[specifier] = specifier.endsWith('/')
      ? `npm:/${packageName}@${manifest.version}/`
      : `npm:${packageName}@${manifest.version}`;
  }
  await writeFile(configPath, JSON.stringify(config));
  const result = spawnSync('deno', ['task', 'test'], { cwd: directory, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
