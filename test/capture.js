'use strict';
/**
 * capture.js — spawn a child node process and capture its output.
 *
 * Under some sandboxed environments a child's piped stdio (the spawnSync
 * default) is denied with EPERM while file redirection is allowed. The runner
 * therefore tries the pipe first and, when the spawn itself fails, retries
 * with the child's stdout/stderr redirected to temp files and reads them back.
 * The captured-output contract stays identical for the callers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function spawnCaptured(cmd, args, opts) {
  const o = Object.assign({ encoding: 'utf8' }, opts || {});
  const r = spawnSync(cmd, args, o);
  if (!(r.status === null && r.error)) return r;

  const tag = `eprj3-cap-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const outF = path.join(os.tmpdir(), `${tag}-out.txt`);
  const errF = path.join(os.tmpdir(), `${tag}-err.txt`);
  const outFd = fs.openSync(outF, 'w');
  const errFd = fs.openSync(errF, 'w');
  let r2;
  try {
    r2 = spawnSync(cmd, args, Object.assign({}, o, {
      encoding: 'utf8',
      timeout: o.timeout,
      stdio: ['ignore', outFd, errFd]
    }));
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.existsSync(outF) ? fs.readFileSync(outF, 'utf8') : '';
  const stderr = fs.existsSync(errF) ? fs.readFileSync(errF, 'utf8') : '';
  fs.rmSync(outF, { force: true });
  fs.rmSync(errF, { force: true });
  return {
    status: r2.status,
    signal: r2.signal,
    error: r2.error,
    stdout,
    stderr
  };
}

module.exports = { spawnCaptured };
