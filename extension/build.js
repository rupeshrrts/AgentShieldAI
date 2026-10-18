const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');
// Shipped builds are minified (short names, no comments or source file names) so the code is hard to
// follow. This is obscurity, not protection: enforcement is on the server. `--readable` (and --watch)
// keep plain output for debugging.
const minify = !isWatch && !process.argv.includes('--readable');

const buildOptions = [
  // Background Service Worker
  {
    entryPoints: [path.join(__dirname, 'src/background/service-worker.ts')],
    bundle: true,
    outfile: path.join(__dirname, 'dist/background/service-worker.js'),
    format: 'iife',
    target: ['chrome110'],
    sourcemap: false,
  },
  // Content Script
  {
    entryPoints: [path.join(__dirname, 'src/content/content.ts')],
    bundle: true,
    outfile: path.join(__dirname, 'dist/content/content.js'),
    format: 'iife',
    target: ['chrome110'],
    sourcemap: false,
  },
  // Domain Blocker Script (document_start)
  {
    entryPoints: [path.join(__dirname, 'src/content/domain-blocker.ts')],
    bundle: true,
    outfile: path.join(__dirname, 'dist/content/domain-blocker.js'),
    format: 'iife',
    target: ['chrome110'],
    sourcemap: false,
  },
  // Popup script
  {
    entryPoints: [path.join(__dirname, 'src/popup/popup.ts')],
    bundle: true,
    outfile: path.join(__dirname, 'src/popup/popup.js'),
    format: 'iife',
    target: ['chrome110'],
    sourcemap: false,
  },
];

// Website-category rulesets declared in manifest.json must exist (scripts/update-web-categories.js)
function checkRulesets() {
  const fs = require('fs');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
  const missing = (manifest.declarative_net_request?.rule_resources || [])
    .filter((r) => !fs.existsSync(path.join(__dirname, r.path)))
    .map((r) => r.path);
  if (missing.length) {
    throw new Error(`Missing ${missing.join(', ')}. Run: node scripts/update-web-categories.js`);
  }
}

async function run() {
  try {
    checkRulesets();
    for (const base of buildOptions) {
      const opt = { ...base, minify, legalComments: 'none' };
      if (isWatch) {
        const ctx = await esbuild.context(opt);
        await ctx.watch();
      } else {
        await esbuild.build(opt);
      }
    }
    console.log('✓ AgentShield Extension built successfully!');
  } catch (err) {
    console.error('Build failed:', err);
    process.exit(1);
  }
}

run();
