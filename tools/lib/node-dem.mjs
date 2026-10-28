// DemSource for Node: the app's own elevation code (js/dem.js), with tiles fetched by
// curl (which honours HTTPS_PROXY and system certificates) and cached on disk, so
// repeated runs are fast and give identical results.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DemSource, TERRARIUM } from '../../js/dem.js';
import { decodePNG } from './png.mjs';

const run = promisify(execFile);
const CACHE = process.env.TOW_TILE_CACHE || path.join(os.homedir(), '.cache', 'terrain-of-war', 'tiles');

// A few downloads at a time is plenty and keeps the tile server happy.
let active = 0;
const waiting = [];
async function limited(fn) {
  if (active >= 8) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}

async function loadRGBA(url) {
  const file = path.join(CACHE, url.replace(/^https?:\/\//, '').replace(/[^\w.-]+/g, '_'));
  if (!fs.existsSync(file)) {
    fs.mkdirSync(CACHE, { recursive: true });
    const tmp = `${file}.${process.pid}.part`;
    await limited(() => run('curl', ['-sSf', '--retry', '2', '-m', '60', '-o', tmp, url]));
    fs.renameSync(tmp, file);
  }
  const png = decodePNG(fs.readFileSync(file));
  return png.rgba;
}

export function nodeDem() {
  return new DemSource(TERRARIUM, { loadRGBA });
}
