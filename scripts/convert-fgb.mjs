import { readFileSync, writeFileSync } from 'fs'
import { gzipSync } from 'zlib'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { serialize } from '../node_modules/flatgeobuf/lib/mjs/geojson.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src  = f => resolve(ROOT, 'tpp', f)
const dst  = f => resolve(ROOT, 'public', 'fgb', f)

// ── alias map ─────────────────────────────────────────────────────────────────
const aliasMap = {}
let aliasIdx = 0

function alias(key) {
  if (!aliasMap[key]) aliasMap[key] = `k${aliasIdx++}`
  return aliasMap[key]
}

// ── TPP geometry simplification (Douglas-Peucker) ────────────────────────────
// Romania TPP: 2.4 MB with only 3 features — all wasted on dense boundary vertices.
// 0.0005° ≈ 50m tolerance: invisible at any zoom where TPP is visible.

const TPP_TOLERANCE = 0.0005

function dpDistance(p, a, b) {
  const [x, y] = p, [x1, y1] = a, [x2, y2] = b
  const dx = x2 - x1, dy = y2 - y1
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1)
  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
}

function dp(pts, tol) {
  if (pts.length <= 2) return pts
  let maxD = 0, idx = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const d = dpDistance(pts[i], pts[0], pts[pts.length - 1])
    if (d > maxD) { maxD = d; idx = i }
  }
  if (maxD > tol) {
    const l = dp(pts.slice(0, idx + 1), tol)
    const r = dp(pts.slice(idx), tol)
    return [...l.slice(0, -1), ...r]
  }
  return [pts[0], pts[pts.length - 1]]
}

function simplifyRing(ring, tol) {
  const s = dp(ring, tol)
  if (s.length < 4) return ring   // never simplify below a valid ring
  if (s[0] !== s[s.length - 1]) s.push(s[0])
  return s
}

function simplifyGeom(geom, tol) {
  if (geom.type === 'Polygon') {
    return { ...geom, coordinates: geom.coordinates.map(r => simplifyRing(r, tol)) }
  }
  if (geom.type === 'MultiPolygon') {
    return {
      ...geom,
      coordinates: geom.coordinates.map(poly =>
        poly.map(r => simplifyRing(r, tol))
      ),
    }
  }
  return geom
}

function countVerts(geom) {
  const rings = geom.type === 'Polygon' ? geom.coordinates
    : geom.coordinates.flat()
  return rings.reduce((s, r) => s + r.length, 0)
}

// ── cell geometry helpers ─────────────────────────────────────────────────────

// Average vertex offsets from centroid over first N features.
// All cells in a country share the same shape — only position differs.
// x-offsets vary ~1% across latitudes within a country, y-offsets are constant.
// Using averaged template gives <100m error per cell at 10km scale — invisible at zoom 10+.
function computeCellTemplate(features, n = 300) {
  const sample = features.slice(0, Math.min(n, features.length))
  const nVerts = sample[0].geometry.coordinates[0].length - 1  // exclude closing point
  const sum = Array.from({ length: nVerts }, () => [0, 0])

  for (const f of sample) {
    const ring = f.geometry.coordinates[0].slice(0, nVerts)
    const cx = ring.reduce((s, p) => s + p[0], 0) / nVerts
    const cy = ring.reduce((s, p) => s + p[1], 0) / nVerts
    ring.forEach(([x, y], i) => { sum[i][0] += x - cx; sum[i][1] += y - cy })
  }

  return sum.map(([sx, sy]) => [
    +(sx / sample.length).toFixed(7),
    +(sy / sample.length).toFixed(7),
  ])
}

// Convert polygon feature → centroid Point (no per-feature geometry overhead)
function toCentroid(feature, nVerts) {
  const ring = feature.geometry.coordinates[0].slice(0, nVerts)
  const cx = ring.reduce((s, p) => s + p[0], 0) / nVerts
  const cy = ring.reduce((s, p) => s + p[1], 0) / nVerts
  return {
    ...feature,
    geometry: { type: 'Point', coordinates: [+cx.toFixed(6), +cy.toFixed(6)] },
  }
}

// ── property flattening ────────────────────────────────────────────────────────

function flattenHexProps(props) {
  const norm = props.facetSummary?.bySource?.normalized ?? {}
  const result = { matched: props.matched, count: props.count }

  for (const [key, val] of Object.entries(norm)) {
    if (key === 'count') continue
    const a = alias(key)
    if (typeof val === 'number') {
      result[a] = val
    } else if (typeof val === 'object' && val !== null) {
      result[a] = Object.entries(val).map(([k, v]) => `${k} (${v})`).join(', ')
    } else {
      result[a] = String(val)
    }
  }
  return result
}

// ── file list ─────────────────────────────────────────────────────────────────

const files = [
  { src: src('ukraine_tpp.json'),       dst: dst('ukraine_tpp.fgb'),       type: 'tpp' },
  { src: src('ukraine_hex_grid.json'),  dst: dst('ukraine_hex_grid.fgb'),  type: 'hex', key: 'ukraine_hex_grid' },
  // { src: src('hungary_tpp_.json'),      dst: dst('hungary_tpp.fgb'),       type: 'tpp' },
  // { src: src('hungary_hexgrid_.json'),  dst: dst('hungary_hexgrid.fgb'),   type: 'hex', key: 'hungary_hexgrid' },
  // { src: src('romania_tpp.json'),       dst: dst('romania_tpp.fgb'),       type: 'tpp' },
  // { src: src('romania_hexgrid.json'),   dst: dst('romania_hexgrid.fgb'),   type: 'hex', key: 'romania_hexgrid' },
]

// ── main loop ─────────────────────────────────────────────────────────────────

const cellTemplates = {}  // key → { offsets, vertexCount }

for (const { src, dst, type, key } of files) {
  process.stdout.write(`Converting ${src} ... `)
  const geojson = JSON.parse(readFileSync(src, 'utf-8'))

  if (type === 'tpp') {
    const before = geojson.features.reduce((s, f) => s + countVerts(f.geometry), 0)
    geojson.features = geojson.features.map(f => ({
      ...f,
      geometry: simplifyGeom(f.geometry, TPP_TOLERANCE),
    }))
    const after = geojson.features.reduce((s, f) => s + countVerts(f.geometry), 0)
    process.stdout.write(`  [simplify: ${before.toLocaleString()} → ${after.toLocaleString()} verts] `)
  }

  if (type === 'hex') {
    const nVerts = geojson.features[0].geometry.coordinates[0].length - 1
    const offsets = computeCellTemplate(geojson.features)
    cellTemplates[key] = { offsets, vertexCount: nVerts }
    geojson.features = geojson.features.map(f => ({
      ...toCentroid(f, nVerts),
      properties: flattenHexProps(f.properties),
    }))
  }

  const bytes   = serialize(geojson)
  const gzipped = gzipSync(bytes, { level: 9 })

  writeFileSync(dst, bytes)
  writeFileSync(`${dst}.gz`, gzipped)

  const srcKB = (readFileSync(src).byteLength / 1024).toFixed(1)
  const rawKB = (bytes.byteLength / 1024).toFixed(1)
  const gzKB  = (gzipped.byteLength / 1024).toFixed(1)
  const saved = ((1 - gzipped.byteLength / readFileSync(src).byteLength) * 100).toFixed(0)
  console.log(`json=${srcKB}KB  fgb=${rawKB}KB  fgb.gz=${gzKB}KB  (${saved}% vs source)`)
}

// ── metadata files ────────────────────────────────────────────────────────────

const reverseAlias = Object.fromEntries(Object.entries(aliasMap).map(([k, v]) => [v, k]))
writeFileSync(dst('alias.json'), JSON.stringify(reverseAlias, null, 2))
console.log(`\nWrote alias.json — ${Object.keys(reverseAlias).length} keys`)

writeFileSync(dst('hex-meta.json'), JSON.stringify(cellTemplates, null, 2))
console.log(`Wrote hex-meta.json — ${Object.keys(cellTemplates).length} country templates`)

console.log('\nDone.')
console.log('Note: upload .fgb.gz to S3 with Content-Encoding: gzip  Content-Type: application/octet-stream')
