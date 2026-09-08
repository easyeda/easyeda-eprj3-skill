#!/usr/bin/env node
'use strict';
/**
 * open.js — Launch the EasyEDA Pro / LCEDA Pro offline client on a given .eprj3 file.
 *
 * Usage:
 *   node scripts/open.js open --dir <projectDir> [--client <path-to-exe>]
 *   node scripts/open.js where                       # print the path the script would launch
 *   node scripts/open.js set --client <path>         # save the path to a config file
 *   node scripts/open.js install                     # register .eprj3 file association (Windows only)
 *
 * Path resolution order:
 *   1. --client <path>                                            CLI flag
 *   2. $EASYEDA_PRO_CLIENT                                        env var
 *   3. .easyeda-pro-client.json in the project / parent dir       project config
 *   4. ~/.config/easyeda-pro/client.json                          user config
 *   5. Auto-detect in the locations listed in `searchDefaultCandidates`
 *   6. Abort with a clear "not found" message that lists the searched locations.
 *
 * Because the user can pick any install directory during installation, no
 * single default path is reliable. We probe many candidates instead.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { parseArgs, printHelp, die } = require('./lib/utils');

const schema = [
  { name: 'dir', alias: 'd', hasValue: true, desc: 'Project root (must contain <name>.eprj3)' },
  { name: 'client', alias: 'c', hasValue: true, desc: 'Path to the EasyEDA Pro / LCEDA Pro executable' }
];

// Documented default install locations (Windows). The user can pick any other
// directory during installation — see the `set --client <path>` flow.
const PRIMARY_WIN_DEFAULTS = [
  'C:/Program Files/easyeda-pro/easyeda-pro.exe',
  'C:/Program Files/lceda-pro/lceda-pro.exe'
];

// ---- config files ----
function configPaths(projectDir) {
  const paths = [];
  if (projectDir) {
    paths.push(path.join(projectDir, '.easyeda-pro-client.json'));
    paths.push(path.join(projectDir, '..', '.easyeda-pro-client.json'));
  }
  paths.push(path.join(os.homedir(), '.config', 'easyeda-pro', 'client.json'));
  return paths;
}

function readConfigClient(projectDir) {
  for (const p of configPaths(projectDir)) {
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (json.client && fs.existsSync(json.client)) return { client: json.client, source: p };
    } catch {}
  }
  return null;
}

function writeConfigClient(projectDir, client) {
  const p = configPaths(projectDir)[0];
  fs.writeFileSync(p, JSON.stringify({ client }, null, 2));
  return p;
}

// ---- detection ----
function isExe(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function candidateWin() {
  const candidates = [...PRIMARY_WIN_DEFAULTS];
  // Program Files (x86) variants — kept only for the two documented names.
  for (const p of PRIMARY_WIN_DEFAULTS) {
    candidates.push(p.replace('Program Files', 'Program Files (x86)'));
  }
  // Per-user installs that follow the same convention.
  const local = process.env.LOCALAPPDATA || '';
  const homes = [process.env.USERPROFILE || path.join(local, '..'), os.homedir()];
  for (const home of homes) {
    candidates.push(path.join(home, 'AppData', 'Local', 'Programs', 'easyeda-pro', 'easyeda-pro.exe'));
    candidates.push(path.join(home, 'AppData', 'Local', 'Programs', 'lceda-pro', 'lceda-pro.exe'));
  }
  return [...new Set(candidates)].filter(isExe);
}

function candidateMac() {
  // Same two brands; the .app bundle keeps the exe filename inside Contents/MacOS/.
  const apps = ['easyeda-pro', 'lceda-pro'];
  const candidates = [];
  for (const app of apps) {
    candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
  }
  return candidates.filter(p => fs.existsSync(p));
}

function candidateLinux() {
  // Linux / WSL — best effort. The two documented brand names only.
  const names = ['easyeda-pro', 'lceda-pro'];
  const out = [];
  for (const name of names) {
    out.push(`/usr/bin/${name}`);
    out.push(`/usr/local/bin/${name}`);
    out.push(`/snap/bin/${name}`);
    out.push(`/opt/${name}/${name}`);
  }
  return [...new Set(out)].filter(isExe);
}

function detectClient() {
  const platform = process.platform;
  if (platform === 'win32') return candidateWin()[0] || null;
  if (platform === 'darwin') return candidateMac()[0] || null;
  return candidateLinux()[0] || null;
}

function findClient(opts = {}) {
  if (opts.cli && isExe(opts.cli)) return { path: path.resolve(opts.cli), source: '--client' };
  if (process.env.EASYEDA_PRO_CLIENT && isExe(process.env.EASYEDA_PRO_CLIENT)) return { path: path.resolve(process.env.EASYEDA_PRO_CLIENT), source: 'EASYEDA_PRO_CLIENT' };
  const cfg = readConfigClient(opts.projectDir);
  if (cfg) return { path: path.resolve(cfg.client), source: 'config ' + cfg.source };
  const detected = detectClient();
  if (detected) return { path: detected, source: 'auto-detected' };
  return null;
}

function findIndexFile(dir) {
  const entries = fs.readdirSync(dir).filter(f => f.endsWith('.eprj3'));
  if (!entries.length) die(`No .eprj3 file found in ${dir}`);
  return path.join(dir, entries[0]);
}

async function main() {
  const sub = process.argv[2] || 'open';
  if (sub === 'help' || sub === '--help') { printHelp('open.js <open|where|set|install> [options]', schema); return; }
  const { opts } = parseArgs(process.argv.slice(3), schema);

  if (sub === 'where') {
    const r = findClient({ cli: opts.client, projectDir: opts.dir });
    console.log(r ? `${r.path} (from ${r.source})` : '(not found)');
    process.exit(r ? 0 : 1);
  }

  if (sub === 'set') {
    if (!opts.client) die('--client <path-to-exe> is required for `set`');
    if (!isExe(opts.client)) die(`File not found or not a regular file: ${opts.client}`);
    const dir = opts.dir ? path.resolve(opts.dir) : process.cwd();
    const configPath = writeConfigClient(dir, path.resolve(opts.client));
    console.log(`Saved client path to ${configPath}`);
    return;
  }

  if (sub === 'install') {
    if (process.platform !== 'win32') die('File association install only supports Windows');
    const r = findClient({ cli: opts.client, projectDir: opts.dir });
    if (!r) die('EasyEDA / LCEDA Pro client not found. Run `node scripts/open.js set --client <path>` first.');
    const dir = opts.dir ? path.resolve(opts.dir) : process.cwd();
    const indexFile = findIndexFile(dir);
    const ps = `$ext = '.eprj3'; $exe = '${r.path.replace(/'/g, "''")}'; cmd /c assoc $ext=EasyEDAPro.eprj3; cmd /c ftype EasyEDAPro.eprj3='${r.path.replace(/'/g, "''")}' '%1'`;
    spawn('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
    console.log(`Registered .eprj3 -> ${r.path}`);
    return;
  }

  if (sub === 'open') {
    const dir = path.resolve(opts.dir || '.');
    if (!fs.existsSync(dir)) die(`Project dir not found: ${dir}`);
    const indexFile = findIndexFile(dir);
    const r = findClient({ cli: opts.client, projectDir: dir });
    if (!r) {
      console.error('EasyEDA Pro / LCEDA Pro client executable was not found.');
      console.error('Searched (Windows defaults):');
      console.error('  - C:/Program Files/easyeda-pro/easyeda-pro.exe');
      console.error('  - C:/Program Files/lceda-pro/lceda-pro.exe');
      console.error('  - C:/Program Files (x86)/easyeda-pro/easyeda-pro.exe');
      console.error('  - C:/Program Files (x86)/lceda-pro/lceda-pro.exe');
      console.error('  - %LOCALAPPDATA%\\Programs\\easyeda-pro\\easyeda-pro.exe');
      console.error('  - %LOCALAPPDATA%\\Programs\\lceda-pro\\lceda-pro.exe');
      console.error('  - /Applications/easyeda-pro.app/Contents/MacOS/easyeda-pro');
      console.error('  - /Applications/lceda-pro.app/Contents/MacOS/lceda-pro');
      console.error('  - /usr/bin/easyeda-pro, /usr/bin/lceda-pro');
      for (const p of configPaths(dir)) console.error('  - config: ' + p);
      console.error('  - $EASYEDA_PRO_CLIENT env var');
      die('Pass --client <path-to-exe>, or run `node scripts/open.js set --client <path>` to persist.');
    }
    console.log(`Launching ${r.path} ${indexFile} (from ${r.source})`);
    const child = spawn(r.path, [indexFile], { stdio: 'ignore', detached: true });
    child.unref();
    return;
  }

  die(`Unknown command: ${sub}`);
}

main().catch(err => die(err.message, 1));