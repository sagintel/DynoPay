// Lists UI strings that the shipped dictionaries (src/i18n/locales.ts) don't translate yet.
// Run: npm run i18n:check  (after npm run i18n:extract). Exits 1 when something is missing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const gen = read('../src/i18n/strings.gen.ts');
const strings = JSON.parse(gen.slice(gen.indexOf('= [') + 2, gen.lastIndexOf(']') + 1));
const locales = read('../src/i18n/locales.ts');
const keys = new Set();
for (const m of locales.matchAll(/^ {2}\[('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"),/gm)) keys.add(Function(`return ${m[1]}`)());
// Names, brands and sample data stay as they are.
const KEEP = new Set(['Acme Studio', 'Sara Malik', 'Cloudflare', 'Gemini', 'Dyno', 'Client ID', 'English', 'Sandbox']);
const ar = read('../src/i18n/locales.ar.ts');
const arKeys = new Set();
for (const m of ar.matchAll(/^ {2}('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[A-Za-z]\w*):/gm)) arKeys.add(/^['"]/.test(m[1]) ? Function(`return ${m[1]}`)() : m[1]);
const missing = strings.filter((s) => !KEEP.has(s) && (!keys.has(s) || !arKeys.has(s))).map((s) => (keys.has(s) ? `${s}  (ar)` : s));
if (missing.length) {
  console.log(missing.map((s) => JSON.stringify(s)).join('\n'));
  console.log(`\n${missing.length} string(s) without a shipped translation (they are translated on demand by the server).`);
  process.exit(1);
}
console.log(`All ${strings.length} UI strings are translated in the shipped languages.`);
