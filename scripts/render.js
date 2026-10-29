#!/usr/bin/env node
'use strict';
/**
 * render.js — write SVG previews (and optionally PNG rasterizations) of every
 * schematic sheet and PCB document.
 *
 *   node scripts/render.js --dir <project> [--out <dir>] [--png] [--scale 2] [--json]
 *
 * Default output: <project>/preview/<Schematic>_<sheet>.svg + <PCB>.svg
 * `--png` additionally rasterizes each SVG through a headless browser
 * (Edge on Windows by default — Chrome's headless screenshot was found not to
 * produce a file on a real machine while Edge did). Set `EPRJ3_BROWSER` to
 * force a specific executable.
 *
 * The SVGs are sketches, not plotter exports. Schematic: real symbol artwork
 * (diode triangle, LED arrows, cap plates), pin stubs, wires, block frames —
 * layout, spacing, routing and block structure judged in one look. PCB: board
 * outline, pads, refdes and the rats — how a human sanity-checks a
 * placement-only deliverable without opening the client. The PNG exists so an
 * agent can look at a picture instead of reading the SVG text (report §8:
 * reading a whole SVG cost ~20k tokens).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { renderProject } = require('./lib/render');
const { parseArgs, printHelp } = require('./lib/utils');

const SCHEMA = [
  { name: 'dir', desc: 'project directory', required: true },
  { name: 'out', desc: 'output directory (default: <project>/preview)' },
  { name: 'png', desc: 'also rasterize each SVG to PNG (headless browser)', hasValue: false },
  { name: 'scale', desc: 'PNG pixel scale (default 2)' },
  { name: 'json', desc: 'print the written file list as JSON', hasValue: false }
];

/** Candidate browser executables, most reliable first. */
function browserCandidates() {
  const env = process.env.EPRJ3_BROWSER;
  const list = env ? [env] : [];
  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA
    ].filter(Boolean);
    for (const r of roots) {
      list.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      list.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      list.push(path.join(r, 'Programs', 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    list.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge');
  }
  return list.filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

function svgSize(svg) {
  const m = /<svg[^>]*width="(\d+(?:\.\d+)?)"[^>]*height="(\d+(?:\.\d+)?)"/.exec(svg.slice(0, 600));
  if (!m) return { w: 1200, h: 900 };
  return { w: Math.ceil(Number(m[1])), h: Math.ceil(Number(m[2])) };
}

/**
 * Rasterize one SVG. Returns the PNG path, or throws with a hint.
 *
 * Two real-machine findings drove this implementation:
 *  · Edge headless produced no file when asked to write to an absolute path —
 *    it honours a RELATIVE --screenshot name in its cwd;
 *  · both Edge and Chrome refused to load a file:// URL under a non-ASCII
 *    (e.g. Chinese) project path.
 * So the page is built and screenshotted inside an ASCII temp directory, and
 * the PNG is copied to its destination afterwards.
 */
function rasterize(browser, svgFile, pngFile, scale) {
  const svg = fs.readFileSync(svgFile, 'utf8');
  const { w, h } = svgSize(svg);
  const pw = Math.round(w * scale);
  const ph = Math.round(h * scale);
  const work = path.join(os.tmpdir(), `eprj3-render-${process.pid}-${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  fs.copyFileSync(svgFile, path.join(work, 'src.svg'));
  // exact pixel size, white background, drawing only
  fs.writeFileSync(path.join(work, 'index.html'), `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#fff}img{display:block;width:${pw}px;height:${ph}px}</style>
<img src="src.svg">`, 'utf8');
  const profile = path.join(work, 'profile');
  const r = spawnSync(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    `--window-size=${pw},${ph}`,
    '--screenshot=out.png',
    `file:///${path.join(work, 'index.html').replace(/\\/g, '/')}`
  ], { cwd: work, encoding: 'utf8', timeout: 60000 });
  const produced = path.join(work, 'out.png');
  try {
    if (fs.existsSync(produced)) {
      fs.copyFileSync(produced, pngFile);
    } else {
      const why = (r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
      throw new Error(`headless browser produced no PNG (${path.basename(browser)} exit ${r.status}`
        + `${why ? `: ${why}` : ''}). Try EPRJ3_BROWSER=<chrome|edge path>, or open the SVG by hand.`);
    }
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return pngFile;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    printHelp('render.js [options]', SCHEMA,
      'Write SVG previews; --png additionally rasterizes them via a headless browser.');
    return;
  }
  const { opts } = parseArgs(argv, SCHEMA);
  const files = renderProject(opts.dir, opts.out ? path.resolve(opts.out) : null);
  const pngs = [];
  if (opts.png) {
    const scale = Math.max(1, Number(opts.scale) || 2);
    const browsers = browserCandidates();
    if (!browsers.length) {
      console.error('no headless browser found (Edge/Chrome). Set EPRJ3_BROWSER to an executable, or open the SVG by hand.');
    } else {
      for (const f of files) {
        const png = f.replace(/\.svg$/i, '.png');
        try {
          rasterize(browsers[0], f, png, scale);
          pngs.push(png);
        } catch (e) {
          console.error(`  ! ${e.message}`);
          break;                              // one browser failure is enough
        }
      }
    }
  }
  if (opts.json) {
    console.log(JSON.stringify({ svg: files, png: pngs }, null, 2));
    return;
  }
  for (const f of files) console.log(`wrote ${f} (${Math.round(fs.statSync(f).size / 1024)} KB)`);
  for (const f of pngs) console.log(`wrote ${f} (${Math.round(fs.statSync(f).size / 1024)} KB)`);
}

main();
