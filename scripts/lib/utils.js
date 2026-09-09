'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

function parseArgs(argv, schema) {
  // schema is array of {name, alias, hasValue, required, default}
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq >= 0 ? a.slice(2, eq) : a.slice(2));
      // Exact option name always wins over an alias — an alias that collides
      // with another option's name (e.g. --y) must not shadow it.
      const def = schema.find(s => s.name === key) || schema.find(s => s.alias === key);
      if (!def) throw new Error(`Unknown option: ${a}`);
      if (def.hasValue === false) {
        opts[def.name] = true;
      } else {
        const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new Error(`Missing value for ${a}`);
        opts[def.name] = v;
      }
    } else if (a.startsWith('-') && schema.some(s => s.alias === a.slice(1))) {
      const key = a.slice(1);
      const def = schema.find(s => s.alias === key);
      if (def.hasValue === false) {
        opts[def.name] = true;
      } else {
        opts[def.name] = argv[++i];
      }
    } else {
      positional.push(a);
    }
  }
  for (const s of schema) {
    if (s.required && opts[s.name] === undefined) {
      throw new Error(`Missing required option: --${s.name}`);
    }
    if (opts[s.name] === undefined && s.default !== undefined) {
      opts[s.name] = s.default;
    }
  }
  return { opts, positional };
}

function printHelp(scriptName, schema, description) {
  const lines = [];
  const hasOptions = scriptName.includes('[options]');
  lines.push(`Usage: node ${scriptName}${hasOptions ? '' : ' [options]'}`);
  if (description) lines.push('', description);
  lines.push('', 'Options:');
  for (const s of schema) {
    const flag = s.alias ? `-${s.alias}, --${s.name}` : `--${s.name}`;
    const tail = s.hasValue === false ? '' : ' <value>';
    lines.push(`  ${flag}${tail}  ${s.desc || ''}`);
  }
  console.log(lines.join('\n'));
}

function die(msg, code = 1) {
  console.error(`Error: ${msg}`);
  process.exit(code);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function existsOrDie(p) {
  if (!fs.existsSync(p)) die(`File not found: ${p}`);
  return p;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

function openFile(filePath) {
  // cross-platform: hand the file off to the OS so the default app handles it.
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  let cmd, args;
  if (isWin) { cmd = 'cmd'; args = ['/c', 'start', '""', filePath]; }
  else if (isMac) { cmd = 'open'; args = [filePath]; }
  else { cmd = 'xdg-open'; args = [filePath]; }
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.unref();
}

module.exports = { parseArgs, printHelp, die, ensureDir, existsOrDie, readJson, writeJson, openFile, execFileSync };