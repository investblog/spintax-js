// tsup only emits JS; the node icon must sit next to the compiled .node.js
// because the description references it as `icon: 'file:spintax.svg'`.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(pkg, 'dist', 'nodes', 'Spintax', 'spintax.svg');
mkdirSync(dirname(dest), { recursive: true });
copyFileSync(join(pkg, 'src', 'nodes', 'Spintax', 'spintax.svg'), dest);
