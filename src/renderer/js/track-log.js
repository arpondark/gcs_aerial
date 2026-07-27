// Track log serialization for KML / GPX files.
//
// `serializeTrackKML` produces a valid KML `LineString` from an array of
// {lat, lon, alt} points plus an optional home marker and mission
// waypoint placemarks. `serializeTrackGPX` writes the same track as a GPX
// `trk` element. Both functions are pure (no I/O) so they're safe in the
// renderer process; the main process handles file dialogs.

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]));
}

function num(v, digits = 6) {
  if (v == null || isNaN(v)) return '';
  return Number(v).toFixed(digits);
}

export function serializeTrackKML(track = [], home = null, mission = []) {
  const coords = track
    .filter((p) => p && isFinite(p.lat) && isFinite(p.lon))
    .map((p) => `${num(p.lon, 7)},${num(p.lat, 7)},${num(p.alt ?? 0, 2)}`)
    .join(' ');

  const placemarks = [];
  if (home && isFinite(home.lat) && isFinite(home.lon)) {
    placemarks.push(
      `<Placemark><name>HOME</name><Point><coordinates>${num(home.lon, 7)},${num(home.lat, 7)},0</coordinates></Point></Placemark>`,
    );
  }
  mission.forEach((wp, i) => {
    if (!wp || !isFinite(wp.lat) || !isFinite(wp.lon)) return;
    placemarks.push(
      `<Placemark><name>WP${i + 1}</name><Point><coordinates>${num(wp.lon, 7)},${num(wp.lat, 7)},${num(wp.alt ?? 0, 2)}</coordinates></Point></Placemark>`,
    );
  });

  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2">\n` +
    `  <Document>\n` +
    `    <name>AeroGCS Track</name>\n` +
    `    <Placemark>\n` +
    `      <name>Track</name>\n` +
    `      <Style><LineStyle><color>ff00daf3</color><width>2</width></LineStyle></Style>\n` +
    `      <LineString><coordinates>${coords}</coordinates></LineString>\n` +
    `    </Placemark>\n` +
    placemarks.map((p) => `    ${p}`).join('\n') + '\n' +
    `  </Document>\n` +
    `</kml>\n`;
}

export function serializeTrackGPX(track = []) {
  const pts = track
    .filter((p) => p && isFinite(p.lat) && isFinite(p.lon))
    .map((p) => `      <trkpt lat="${num(p.lat, 7)}" lon="${num(p.lon, 7)}"><ele>${num(p.alt ?? 0, 2)}</ele></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="AeroGCS-UIU">\n` +
    `  <trk><name>AeroGCS Track</name><trkseg>\n${pts}\n</trkseg></trk>\n` +
    `</gpx>\n`;
}

// Best-effort parser for KML and GPX. Returns { track, home, mission, format }.
export function parseTrackFile(formatHint, text) {
  if (!text) return { track: [], home: null, mission: [], format: formatHint };
  const trimmed = String(text).trimStart();
  const isGpx = /^<\?xml[^]+?<gpx/i.test(trimmed);
  if (isGpx) return parseGPX(trimmed);
  return parseKML(trimmed);
}

function parseKML(text) {
  const track = [];
  const mission = [];
  let home = null;
  // LineString coordinates
  const lineMatch = text.match(/<LineString[^>]*>([\s\S]*?)<\/LineString>/i);
  if (lineMatch) {
    const tuples = lineMatch[1].trim().split(/\s+/);
    for (const t of tuples) {
      const parts = t.split(',');
      if (parts.length < 2) continue;
      const lon = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      const alt = parts.length > 2 ? parseFloat(parts[2]) : 0;
      if (isFinite(lat) && isFinite(lon)) track.push({ lat, lon, alt });
    }
  }
  // Placemarks: HOME + WPn
  const pmRe = /<Placemark[^>]*>([\s\S]*?)<\/Placemark>/gi;
  let m;
  while ((m = pmRe.exec(text)) !== null) {
    const body = m[1];
    const nameMatch = body.match(/<name>([^<]*)<\/name>/i);
    const coordMatch = body.match(/<coordinates>([\s\S]*?)<\/coordinates>/i);
    if (!coordMatch) continue;
    const parts = coordMatch[1].trim().split(',');
    if (parts.length < 2) continue;
    const lon = parseFloat(parts[0]);
    const lat = parseFloat(parts[1]);
    const alt = parts.length > 2 ? parseFloat(parts[2]) : 0;
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const name = nameMatch ? nameMatch[1] : '';
    if (/home/i.test(name)) home = { lat, lon, alt };
    else if (/wp/i.test(name)) mission.push({ lat, lon, alt });
  }
  return { track, home, mission, format: 'kml' };
}

function parseGPX(text) {
  const track = [];
  const ptRe = /<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>/gi;
  let m;
  while ((m = ptRe.exec(text)) !== null) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    const eleMatch = m[3].match(/<ele>([^<]+)<\/ele>/i);
    const alt = eleMatch ? parseFloat(eleMatch[1]) : 0;
    if (isFinite(lat) && isFinite(lon)) track.push({ lat, lon, alt });
  }
  return { track, home: null, mission: [], format: 'gpx' };
}