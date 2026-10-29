'use strict';
/**
 * icdirs.js — where model-specific IC entries live.
 *
 * Policy (user decision): `templates/library/` ships ONLY generic,
 * non-model entries — resistors, capacitors, inductors, diodes, LEDs, test
 * points, power flags and net ports/identifiers. Anything with a real part
 * number is NOT committed with the skill: it is fetched from the EasyEDA
 * official library on demand (`scripts/fetch-lcsc.js`) and cached locally.
 *
 * Search order (first hit wins):
 *   1. <project>/.tmp/library/ic   — part-scoped staging (removed by build)
 *   2. <skill>/.cache/ic           — repo-local cache (gitignored; dev/CI seed)
 *   3. ~/.easyeda-eprj3/ic         — per-user cache written by fetch-lcsc --install
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SKILL_ROOT = path.join(__dirname, '..', '..');
const SKILL_CACHE = path.join(SKILL_ROOT, '.cache', 'ic');
const USER_CACHE = path.join(os.homedir(), '.easyeda-eprj3', 'ic');

/** Directories to search, most specific first. */
function icSearchDirs(projectDir) {
  const dirs = [];
  if (projectDir) dirs.push(path.join(projectDir, '.tmp', 'library', 'ic'));
  dirs.push(SKILL_CACHE);
  dirs.push(USER_CACHE);
  return dirs;
}

/** Every *.json in the search dirs, de-duplicated by file name (first wins). */
function icFiles(projectDir) {
  const seen = new Set();
  const out = [];
  for (const dir of icSearchDirs(projectDir)) {
    if (!fs.existsSync(dir)) continue;
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { continue; }
    for (const f of names) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push(path.join(dir, f));
    }
  }
  return out;
}

/** Where `fetch-lcsc --install` writes (created on demand). */
function defaultInstallDir() {
  fs.mkdirSync(USER_CACHE, { recursive: true });
  return USER_CACHE;
}

module.exports = { SKILL_ROOT, SKILL_CACHE, USER_CACHE, icSearchDirs, icFiles, defaultInstallDir };
