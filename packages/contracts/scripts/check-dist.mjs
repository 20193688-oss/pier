// Fails the build when the compiled output (JavaScript or declarations) still
// imports through the `@/` alias: a consumer of the package cannot resolve it,
// so tsc-alias must have rewritten every one to a relative path with its
// `.js` extension.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const ALIAS = /(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)['"]@\//;
const offenders = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(?:js|d\.ts)$/.test(name) && ALIAS.test(readFileSync(path, 'utf8'))) {
      offenders.push(path);
    }
  }
}

walk(dist);
if (offenders.length > 0) {
  console.error(`Unresolved @/ imports in the build:\n  ${offenders.join('\n  ')}`);
  process.exit(1);
}
console.log('dist: no unresolved @/ imports');
