#!/usr/bin/env node
/**
 * AgentShieldAI - run the whole project locally in ONE terminal.
 *
 *   npm start                              backend :8000 + website :5172 + user dashboard :5173 + developer console :5175
 *   npm start -- --owner you@company.com   also create your developer-console login (first time)
 *   npm start -- --reset                   start with empty test data
 *   npm start -- --no-open                 do not open the website in the browser
 *
 * Ctrl+C stops everything. Uses a local SQLite test database (backend/local_test.db),
 * never the live Supabase database from .env. First run installs what is missing.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const win = process.platform === 'win32';
const args = process.argv.slice(2);
const ownerIdx = args.indexOf('--owner');
const owner = ownerIdx >= 0 ? args[ownerIdx + 1] : null;
const reset = args.includes('--reset');
const openBrowser = !args.includes('--no-open');
const WEBSITE_URL = 'http://localhost:5172';

const backendDir = path.join(root, 'backend');
const python = path.join(backendDir, '.venv', win ? 'Scripts/python.exe' : 'bin/python');
const npm = win ? 'npm.cmd' : 'npm';

// Real email only if SMTP_HOST and SMTP_FROM are set in .env (or this shell); otherwise the backend
// prints confirmation / reset links in this terminal, highlighted below. Only SMTP_* is read from .env.
const dotenvSmtp = {};
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(SMTP_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) dotenvSmtp[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}
const smtp = { ...dotenvSmtp, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('SMTP_'))) };
const emailOn = !!(smtp.SMTP_HOST && smtp.SMTP_FROM);

const env = {
  ...process.env,
  DATABASE_URL: 'sqlite:///./local_test.db',
  ALLOWED_ORIGINS: 'http://localhost:5173,http://localhost:5175',
  DASHBOARD_URL: 'http://localhost:5173',
  ADMIN_CONSOLE_URL: 'http://localhost:5175',
  ...(emailOn ? smtp : { SMTP_HOST: '' }), // without SMTP, emails (confirmation links) are printed in this terminal
  PYTHONUNBUFFERED: '1',
};

const COLORS = { backend: '\x1b[36m', dashboard: '\x1b[35m', console: '\x1b[33m', website: '\x1b[32m' };
const RESET = '\x1b[0m';
const HILITE = '\x1b[30;43m'; // black on yellow

// npm.cmd needs a shell on Windows; executables are started directly (the project path has spaces)
const needsShell = (cmd) => win && cmd.endsWith('.cmd');
// With a shell, pass one command line (our arguments contain no spaces); otherwise the argument list
const spawnArgs = (cmd, cmdArgs) => (needsShell(cmd) ? [[cmd, ...cmdArgs].join(' '), []] : [cmd, cmdArgs]);

function run(cmd, cmdArgs, cwd, label) {
  console.log(`> ${label}...`);
  const [c, a] = spawnArgs(cmd, cmdArgs);
  const r = spawnSync(c, a, { cwd, env, stdio: 'inherit', shell: needsShell(cmd) });
  if (r.status !== 0) {
    console.error(`\n${label} failed. Check that Python 3.10+ and Node.js 18+ are installed.`);
    process.exit(1);
  }
}

// --- First run: install what is missing -------------------------------------------------------
if (!fs.existsSync(python)) {
  run(win ? 'python' : 'python3', ['-m', 'venv', '.venv'], backendDir, 'Creating the Python environment');
  run(python, ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'], backendDir, 'Installing backend packages');
}
for (const app of ['dashboard', 'admin-console', 'website', 'extension']) {
  if (!fs.existsSync(path.join(root, app, 'node_modules'))) {
    run(npm, ['install', '--no-audit', '--no-fund'], path.join(root, app), `Installing ${app} packages`);
  }
}
if (reset) {
  fs.rmSync(path.join(backendDir, 'local_test.db'), { force: true });
  console.log('> Test data cleared');
}
run('node', ['build.js'], path.join(root, 'extension'), 'Building the extension');

// --- Start the three apps in this terminal ------------------------------------------------------
const children = [];
function start(name, cmd, cmdArgs, cwd) {
  const [c, a] = spawnArgs(cmd, cmdArgs);
  const child = spawn(c, a, { cwd, env, shell: needsShell(cmd) });
  const prefix = `${COLORS[name]}[${name}]${RESET} `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        if (line.includes('[DEV EMAIL')) {
          out.write(`\n${HILITE}  EMAIL NOT SENT (local test mode) - open the link below in your browser  ${RESET}\n`);
        }
        // Make links from printed emails easy to spot
        out.write(/https?:\/\/\S+#(verify|reset|invite|staff-invite)=/.test(line) ? `${prefix}${HILITE} >> ${line.trim()} ${RESET}\n` : prefix + line + '\n');
      }
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => {
    if (!stopping) console.log(`${prefix}stopped (exit ${code}). Press Ctrl+C to stop the rest.`);
  });
  children.push(child);
}

start('backend', python, ['-m', 'uvicorn', 'app.main:app', '--port', '8000', '--reload'], backendDir);
start('dashboard', npm, ['run', 'dev', '--', '--port', '5173', '--strictPort'], path.join(root, 'dashboard'));
start('console', npm, ['run', 'dev', '--', '--port', '5175', '--strictPort'], path.join(root, 'admin-console'));
start('website', npm, ['run', 'dev', '--', '--port', '5172', '--strictPort'], path.join(root, 'website'));

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  console.log('\nStopping AgentShieldAI...');
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (win) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  process.exit(0);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

setTimeout(() => {
  if (owner) {
    console.log(`\n> Creating your developer-console login for ${owner}...`);
    spawnSync(python, ['-m', 'app.cli', 'create-platform-owner', '--email', owner], { cwd: backendDir, env, stdio: 'inherit', shell: false });
  }
  console.log(`
==============================================================
 AgentShieldAI is running  (Ctrl+C stops everything)

  START HERE >>  Website  ${WEBSITE_URL}   (Sign up / Log in go to the portal)

  User dashboard     http://localhost:5173
  Developer console  http://localhost:5175
  Backend API docs   http://localhost:8000/docs

${emailOn
    ? `  Emails are sent through ${smtp.SMTP_HOST} (from .env).`
    : `  Emails are NOT sent: confirmation links appear here, highlighted in yellow.
  To send real emails, add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD
  and SMTP_FROM to .env and restart.`}
  First time, create your developer login:
    npm start -- --owner you@company.com
  Extension: chrome://extensions > Developer mode >
    Load unpacked > ${path.join(root, 'extension')}
==============================================================
`);
  // Open the public website first; Sign up / Log in on it lead to the user dashboard
  if (openBrowser) {
    const opener = win ? ['cmd', ['/c', 'start', '""', WEBSITE_URL]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [WEBSITE_URL]];
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true, windowsVerbatimArguments: win }).on('error', () => {}).unref();
  }
}, 6000);
