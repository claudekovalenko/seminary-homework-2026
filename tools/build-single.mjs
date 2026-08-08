// Build a single self-contained HTML file: no server, no network, no install.
// Each ES module becomes an IIFE that returns its exports, so the modules keep
// their own scopes and name clashes between them stay impossible.
//
//   node tools/build-single.mjs   ->  dist/seminary.html

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

/** Rewrite one module's source into `const NAME = (() => { ... })()`. */
function moduleToIife(name, source) {
  const bindings = [];

  let body = source
    // import * as store from './store.js'
    .replace(/^import\s+\*\s+as\s+(\w+)\s+from\s+'\.\/(\w+)\.js';$/gm, (_, ns, mod) => {
      bindings.push(`const ${ns} = __mod_${mod};`);
      return '';
    })
    // import { a, b } from './store.js'
    .replace(/^import\s+\{([^}]+)\}\s+from\s+'\.\/(\w+)\.js';$/gm, (_, names, mod) => {
      bindings.push(`const {${names.trim()}} = __mod_${mod};`);
      return '';
    });

  // Collect every exported binding, then drop the `export` keyword itself.
  const exported = [];
  body = body.replace(/^export\s+(async\s+)?(function|const|let|var|class)\s+(\w+)/gm, (m, _a, _k, id) => {
    exported.push(id);
    return m.replace(/^export\s+/, '');
  });

  if (/^export\s/m.test(body)) throw new Error(`${name}: unsupported export form`);

  return [
    `const __mod_${name} = (() => {`,
    ...bindings,
    body.trim(),
    `return { ${exported.join(', ')} };`,
    '})();'
  ].join('\n');
}

const modules = ['store', 'schedule', 'notify'].map((m) => moduleToIife(m, read(`js/${m}.js`)));

// app.js is the entry point: same import rewriting, but nothing to export.
const app = moduleToIife('app', read('js/app.js')).replace(/^const __mod_app = /, '');

const courses = JSON.parse(read('data/courses.json'));
const css = read('css/styles.css');
const iconSvg = read('icons/icon.svg');
const iconDataUri = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString('base64')}`;

// Reuse the real index.html so the two builds cannot drift apart.
const html = read('index.html')
  .replace(/<link rel="manifest"[^>]*>\s*/, '')
  .replace(/<link rel="icon"[^>]*>/, `<link rel="icon" href="${iconDataUri}" type="image/svg+xml" />`)
  .replace(/<link rel="apple-touch-icon"[^>]*>/, `<link rel="apple-touch-icon" href="${iconDataUri}" />`)
  .replace(/<link rel="stylesheet"[^>]*>/, `<style>\n${css}\n</style>`)
  .replace(
    /<script type="module" src="\.\/js\/app\.js"><\/script>/,
    [
      '<script type="module">',
      `globalThis.__COURSES__ = ${JSON.stringify(courses)};`,
      ...modules,
      app,
      '</script>'
    ].join('\n')
  )
  .replace('<title>Seminary — Today</title>', '<title>Seminary — Today (offline)</title>');

mkdirSync(resolve(ROOT, 'dist'), { recursive: true });
writeFileSync(resolve(ROOT, 'dist/seminary.html'), html);
console.log(`dist/seminary.html — ${(html.length / 1024).toFixed(0)} KB`);
