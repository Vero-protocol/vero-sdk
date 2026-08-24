import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const manifests = [
  { dir: join(root, 'dist', 'cjs'), body: { type: 'commonjs' } },
  { dir: join(root, 'dist', 'esm'), body: { type: 'module' } },
];

for (const { dir, body } of manifests) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(body, null, 2)}\n`);
}
