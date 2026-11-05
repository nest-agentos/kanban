import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const entries = pkg.publishConfig?.exports ?? pkg.exports;
let checked = 0;
function visit(value) {
    if (typeof value === 'string') {
        if (!value.startsWith('./dist/') || !existsSync(resolve(root, value))) throw new Error(`Missing published entry: ${value}`);
        checked++; return;
    }
    for (const child of Object.values(value)) visit(child);
}
visit(entries);
for (const group of ['dependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(pkg[group] ?? {})) {
        if (/^(workspace:|file:|link:)/.test(version)) throw new Error(`Nonportable dependency: ${name}`);
    }
}
console.log(JSON.stringify({operation: 'package.check', package: pkg.name, result: 'success', entries: checked}));
