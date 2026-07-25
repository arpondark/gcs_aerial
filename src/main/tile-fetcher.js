'use strict';

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

/**
 * Fetches slippy map tiles for the renderer.
 *
 * URLs come from the renderer as templates:
 *   osm://{z}/{x}/{y}            → OpenStreetMap standard tiles
 *   arcgis://sat/{z}/{y}/{x}    → ArcGIS World Imagery (satellite)
 *
 * We expand them server-side and return data-URLs so the renderer can
 * drop them straight into <img src=…>. Caching is in-memory.
 */

const TEMPLATES = {
  'osm://': {
    host: 'tile.openstreetmap.org',
    path: (z, x, y) => `/${z}/${x}/${y}.png`,
    headers: { 'User-Agent': 'AeroGCS-UIU/0.1 (educational)' },
    attribution: '© OpenStreetMap contributors',
  },
  'arcgis://sat/': {
    host: 'server.arcgisonline.com',
    path: (z, x, y) => `/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    headers: { 'User-Agent': 'AeroGCS-UIU/0.1' },
    attribution: '© Esri World Imagery',
  },
};

function expand(template) {
  for (const [prefix, def] of Object.entries(TEMPLATES)) {
    if (!template.startsWith(prefix)) continue;
    const rest = template.slice(prefix.length);
    // Each provider specifies how its axis order maps to (z, x, y).
    // osm uses z/x/y; arcgis uses z/y/x.
    const m = rest.match(/^(\d+)\/(\d+)\/(\d+)$/);
    if (!m) return null;
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const c = parseInt(m[3], 10);
    let z, x, y;
    if (prefix === 'osm://') { z = a; x = b; y = c; }
    else if (prefix === 'arcgis://sat/') { z = a; y = b; x = c; }
    else { z = a; x = b; y = c; }
    return { def, z, x, y };
  }
  return null;
}

function fetchTile(template) {
  return new Promise((resolve) => {
    const exp = expand(template);
    if (!exp) {
      resolve({ url: template, dataUrl: null, error: 'unknown tile template' });
      return;
    }
    const { def, z, x, y } = exp;
    const req = https.request({
      host: def.host,
      path: def.path(z, x, y),
      method: 'GET',
      headers: def.headers || {},
      timeout: 6000,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume();
        resolve({ url: template, dataUrl: null, error: `HTTP ${res.statusCode}` });
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const ct = (res.headers['content-type'] || 'image/png').split(';')[0];
        resolve({
          url: template,
          dataUrl: `data:${ct};base64,${buf.toString('base64')}`,
          error: null,
          attribution: def.attribution,
        });
      });
    });
    req.on('error', (err) => resolve({ url: template, dataUrl: null, error: err.message }));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function fetchTiles(templates) {
  if (!Array.isArray(templates)) return [];
  // Bound concurrency
  const results = [];
  const concurrency = 8;
  let i = 0;
  async function worker() {
    while (i < templates.length) {
      const idx = i++;
      results[idx] = await fetchTile(templates[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, templates.length) }, worker));
  return results;
}

module.exports = { fetchTiles, TEMPLATES };