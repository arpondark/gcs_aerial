'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');

const MIN_ZOOM = 0;
const MAX_ZOOM = 6;
const CONCURRENCY = 12;
const OUT_DIR = path.resolve(__dirname, '..', 'osm');

function fetchTile(z, x, y) {
  const url = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        headers: { 'User-Agent': 'AeroGCS-UIU/0.1 (educational tile cache generator)' },
        timeout: 10000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            buf: Buffer.concat(chunks),
            contentType: (res.headers['content-type'] || 'image/png').split(';')[0],
          });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function saveTile(z, x, y, buf, contentType) {
  const dir = path.join(OUT_DIR, String(z), String(x));
  await fsp.mkdir(dir, { recursive: true });
  const tilePath = path.join(dir, `${y}.tile`);
  const jsonPath = path.join(dir, `${y}.json`);
  await fsp.writeFile(tilePath, buf);
  const meta = { contentType, downloadedAt: Date.now(), byteLength: buf.length };
  await fsp.writeFile(jsonPath, JSON.stringify(meta));
}

async function main() {
  console.log(`[downloader] Target directory: ${OUT_DIR}`);
  const tasks = [];
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const max = Math.pow(2, z);
    for (let x = 0; x < max; x++) {
      for (let y = 0; y < max; y++) {
        tasks.push({ z, x, y });
      }
    }
  }

  console.log(`[downloader] Total world tiles (Zoom ${MIN_ZOOM}..${MAX_ZOOM}): ${tasks.length}`);

  let completed = 0;
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  async function worker() {
    while (tasks.length > 0) {
      const t = tasks.shift();
      if (!t) break;
      const tilePath = path.join(OUT_DIR, String(t.z), String(t.x), `${t.y}.tile`);

      if (fs.existsSync(tilePath) && fs.statSync(tilePath).size > 0) {
        skipped++;
        completed++;
        continue;
      }

      let attempts = 0;
      let ok = false;
      while (attempts < 3 && !ok) {
        attempts++;
        try {
          const res = await fetchTile(t.z, t.x, t.y);
          await saveTile(t.z, t.x, t.y, res.buf, res.contentType);
          downloaded++;
          ok = true;
        } catch (err) {
          if (attempts >= 3) {
            failed++;
            console.warn(`[downloader] Failed z=${t.z} x=${t.x} y=${t.y}: ${err.message}`);
          } else {
            await new Promise((r) => setTimeout(r, 500 * attempts));
          }
        }
      }
      completed++;
      if (completed % 100 === 0 || completed === tasks.length) {
        const pct = ((completed / (downloaded + skipped + failed + tasks.length)) * 100).toFixed(1);
        console.log(`[downloader] Progress: ${completed} processed (downloaded=${downloaded}, skipped=${skipped}, failed=${failed})`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  console.log(`[downloader] Complete! Total downloaded=${downloaded}, skipped=${skipped}, failed=${failed}`);
}

main().catch((err) => {
  console.error('[downloader] Fatal error:', err);
  process.exit(1);
});
