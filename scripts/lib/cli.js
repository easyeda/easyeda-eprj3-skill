'use strict';
/**
 * cli.js — thin bridge to the LCEDA Pro / EasyEDA Pro command-line interface.
 *
 * 2.x runs the EDA client as the authority for everything it can do itself:
 * library search, component placement, auto layout / auto route, copper pour,
 * netlist export and canvas screenshots. The skill keeps only the scripts
 * that drive this bridge; the client executes the actual source operations.
 *
 * CLI shape (4.1.94+):
 *   lceda-pro open --path <project> --headless   -> { sessionId }
 *   lceda-pro invoke --session <id> --code-file <js>
 *        -- the code runs in the editor command space; `eda.*` is available,
 *           __CLI__.args carries the JSON arguments, the return value is
 *           reported as value.
 *   lceda-pro session close --session <id> --destroy
 *   lceda-pro doctor                              -> bridgeVersion, connected
 *
 * Zero dependencies: child_process + fs only.
 */
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MIN_VERSION = '4.1.94';

const WIN_CANDIDATES = [
  'C:\\Program Files\\lceda-pro\\lceda-pro.exe',
  'C:\\Program Files\\lceda-pro\\lceda-pro',
  'C:\\Program Files\\EasyEDA Pro\\easyeda-pro.exe',
  'C:\\Program Files\\easyeda-pro\\easyeda-pro.exe'
];

/** Locate the CLI: explicit env, then the standard install locations, then PATH. */
function findCli(explicit) {
  const tries = [];
  if (explicit) tries.push(explicit);
  for (const k of ['LCEDA_PRO_CLI', 'EASYEDA_PRO_CLI']) {
    if (process.env[k]) tries.push(process.env[k]);
  }
  tries.push(...WIN_CANDIDATES);
  for (const name of ['lceda-pro', 'easyeda-pro', 'lceda', 'easyeda']) tries.push(name);
  for (const bin of tries) {
    if (path.isAbsolute(bin)) {
      if (fs.existsSync(bin)) return bin;
      continue;
    }
    const probe = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 15000 });
    if (!probe.error && probe.status === 0) return bin;
  }
  return null;
}

function parseJson(out) {
  const text = String(out || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* CLI may append a PNG warning */ }
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { return JSON.parse(t); } catch (e) { /* keep scanning */ }
  }
  return null;
}

/** Run one CLI command and return its parsed envelope {ok, value, error}. */
function run(bin, args, opts) {
  const o = opts || {};
  const res = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: o.timeout || 120000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    // Run inside the skill's tmp dir: the client occasionally materialises its
    // "current project" as a file in the working directory, and that must never
    // land in the repository root.
    cwd: scratchDir()
  });
  if (res.error) {
    return { ok: false, error: { code: 'SPAWN_FAILED', message: String(res.error.message || res.error) }, stderr: res.stderr || '' };
  }
  const parsed = parseJson(res.stdout);
  if (!parsed) {
    return {
      ok: false,
      error: { code: 'UNPARSEABLE_OUTPUT', message: 'the CLI printed no JSON envelope', stdout: String(res.stdout).slice(0, 800), stderr: String(res.stderr).slice(0, 800) }
    };
  }
  return parsed;
}

function versionOf(bin) {
  const doc = run(bin, ['doctor'], { timeout: 30000 });
  const v = doc && doc.value && doc.value.bridgeVersion;
  const connected = !!(doc && doc.value && doc.value.connected);
  // The editor version is only available through the running bridge. The
  // install folder also ships a `version` file, but that is the installer's
  // packaging string ("v41.2.1-jlc-sa-win-x64.6"), NOT the editor version — it
  // must never be used as the client version.
  if (!v) return { version: null, raw: null, connected };
  return {
    version: String(v).split(/[.+-]/).slice(0, 3).join('.'),
    raw: String(v),
    connected
  };
}

const _editorVersionCache = new Map();

/** Authoritative editor version from the running client, via
 *  `eda.sys_Environment.getEditorCurrentVersion(true)`. Requires a connected
 *  client; returns null when the API is unavailable. Cached per binary. */
function editorVersion(info, opts) {
  if (_editorVersionCache.has(info.bin)) return _editorVersionCache.get(info.bin);
  let v = null;
  // A server that was just stopped needs a moment before `open` succeeds, and
  // a freshly booted one rejects the first invoke while it loads. Retry both.
  for (let attempt = 0; attempt < 3 && !v; attempt += 1) {
    try {
      const session = openProject(info.bin, null);
      try {
        for (let i = 0; i < 5 && !v; i += 1) {
          try {
            const res = invoke(info.bin, session,
              `return { version: eda.sys_Environment.getEditorCurrentVersion(true) };`,
              { timeout: Number((opts && opts.timeout) || 60000) });
            if (res && typeof res.version === 'string' && res.version) v = res.version;
          } catch (e) { /* retry */ }
          if (!v) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
        }
      } finally {
        closeSession(info.bin, session);
      }
    } catch (e) { /* retry the whole open */ }
    if (!v) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  }
  _editorVersionCache.set(info.bin, v);
  return v;
}

function atLeast(version, min) {
  if (!version) return false;
  const a = String(version).split('.').map(Number);
  const b = String(min).split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

/** Locate + version-check the client. Throws a helpful error when unusable. */
function requireCli(opts) {
  const o = opts || {};
  const bin = findCli(o.cli);
  if (!bin) {
    const e = new Error('LCEDA Pro / EasyEDA Pro CLI not found. Install the desktop client (V4.1.94+) and/or set LCEDA_PRO_CLI to the executable path.');
    e.code = 'CLI_NOT_FOUND';
    throw e;
  }
  const info = versionOf(bin);
  const min = o.minVersion || MIN_VERSION;
  // The editor version API opens a bare headless session, so it also boots the
  // client when no server is running yet; try it before declaring the client
  // offline. `doctor`'s bridgeVersion is only a fallback.
  const v = editorVersion(info, o) || info.version;
  if (!v) {
    const e = info.connected
      ? new Error(`cannot determine the client version from ${bin}. Run "lceda-pro doctor" manually.`)
      : new Error('the EDA client is not running — start LCEDA Pro / EasyEDA Pro, then retry.');
    e.code = info.connected ? 'CLI_VERSION_UNKNOWN' : 'CLI_NOT_CONNECTED';
    throw e;
  }
  if (!atLeast(v, min)) {
    const e = new Error(`LCEDA Pro / EasyEDA Pro ${v} is too old — this skill needs ${min}+ (the source/auto APIs used here are 4.1.83+; 4.1.94 is the verified build).`);
    e.code = 'CLI_VERSION_TOO_OLD';
    e.version = v;
    throw e;
  }
  return { bin, version: v, rawVersion: info.raw, connected: info.connected };
}

/** Resolve a project folder to its .eprj3 index (the CLI opens the index). */
function projectIndex(p) {
  const abs = path.resolve(p);
  try {
    if (fs.statSync(abs).isDirectory()) {
      const hit = fs.readdirSync(abs).find((f) => /\.(eprj3|eprj2|eprj|elib)$/i.test(f));
      if (hit) return path.join(abs, hit);
    }
  } catch (e) { /* fall through */ }
  return abs;
}

/** Synchronous sleep — every CLI helper here is synchronous by design. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Make sure the local bridge runs WITHOUT a GUI window.
 *
 *  `lceda-pro open` on a cold client boots the full editor UI (`serve-gui`),
 *  even with `--headless`: that flag hides the render of the opened project,
 *  not the application the command starts. `lceda-pro --owner` starts the
 *  resident bridge in `serve-hidden` mode instead (tray only, no window), and
 *  exits immediately when a server is already up. Every open therefore goes
 *  through ensureServer() → open, so generating a project never pops the UI.
 */
function ensureServer(bin) {
  const up = () => {
    const d = run(bin, ['doctor'], { timeout: 20000 });
    return !!(d && d.value && d.value.connected);
  };
  if (up()) return true;
  try {
    const child = spawn(bin, ['--owner'], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
      cwd: scratchDir()
    });
    child.unref();
  } catch (e) {
    return false;
  }
  for (let i = 0; i < 40; i += 1) {
    sleep(750);
    if (up()) return true;
  }
  return false;
}

/** Open a project headless; returns the session id. No path = a bare editor. */
function openProject(bin, projectPath, opts) {
  const o = opts || {};
  // Boot order matters: `open` on a cold client starts the full GUI
  // (`serve-gui`) — `--headless` only hides the project render, not the app
  // that gets launched. `--owner` starts the resident bridge in `serve-hidden`
  // mode (tray only) and exits at once when a server already exists.
  ensureServer(bin);
  const args = ['open'];
  if (projectPath) args.push('--path', projectIndex(projectPath));
  args.push('--headless', String(o.headless !== false));
  const res = run(bin, args, { timeout: o.timeout || 120000 });
  if (!res.ok || !res.value || !res.value.sessionId) {
    const e = new Error(`open failed: ${JSON.stringify(res.error || res).slice(0, 500)}`);
    e.code = 'OPEN_FAILED';
    throw e;
  }
  // `open` returns before the project is fully loaded; give the tree a moment
  // (the invoked snippets also wait for readiness where the API offers it)
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  return res.value.sessionId;
}

function closeSession(bin, sessionId) {
  if (!sessionId) return;
  run(bin, ['session', 'close', '--session', String(sessionId), '--destroy', 'true'], { timeout: 30000 });
}

/** Scratch dir for invoke sources (inside the skill's tmp/, per project rules). */
function scratchDir() {
  const dir = path.join(__dirname, '..', '..', 'tmp', 'eda');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run source in the editor command space.
 * @param {string} code async function body; `__CLI__.args` carries `args`
 */
function invoke(bin, sessionId, code, opts) {
  const o = opts || {};
  const file = path.join(scratchDir(), `run-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(file, `'use strict';\n${code}\n`);
  const args = ['invoke', '--session', String(sessionId), '--code-file', file, '--timeout', String(o.timeout || 120000)];
  if (o.args !== undefined) args.push('--args', JSON.stringify(o.args));
  const res = run(bin, args, { timeout: (o.timeout || 120000) + 30000 });
  try { fs.unlinkSync(file); } catch (e) { /* best effort */ }
  if (!res.ok) {
    const e = new Error(`invoke failed: ${JSON.stringify(res.error).slice(0, 800)}`);
    e.code = 'INVOKE_FAILED';
    throw e;
  }
  return res.value;
}

/** Decode the base64 an invoked snippet returned for a File/Blob. */
function writeBase64(outFile, b64) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(b64, 'base64'));
  return outFile;
}

module.exports = {
  MIN_VERSION,
  findCli,
  run,
  versionOf,
  editorVersion,
  atLeast,
  requireCli,
  openProject,
  closeSession,
  invoke,
  writeBase64
};
