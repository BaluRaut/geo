import { useEffect, useMemo, useRef, useState } from 'react'
import { GeoJSON, MapContainer, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { geojson } from 'flatgeobuf'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// ─── types & config ──────────────────────────────────────────────────────────

type ActiveLayer = 'tpp' | 'hex' | 'all'
type CountryKey  = 'ukraine' | 'hungary' | 'romania'

const COUNTRIES: Record<CountryKey, { label: string; tpp: string; hex: string }> = {
  ukraine: { label: '🇺🇦 Ukraine', tpp: 'ukraine_tpp.fgb',  hex: 'ukraine_hex_grid.fgb' },
  hungary: { label: '🇭🇺 Hungary', tpp: 'hungary_tpp.fgb',  hex: 'hungary_hexgrid.fgb'  },
  romania: { label: '🇷🇴 Romania', tpp: 'romania_tpp.fgb',  hex: 'romania_hexgrid.fgb'  },
}

const ALL_COUNTRIES = Object.keys(COUNTRIES) as CountryKey[]

// initial view that frames all three countries
const ALL_CENTER: [number, number] = [48, 26]
const ALL_ZOOM = 5

const CLUSTER_ZOOM_THRESHOLD = 1

const TPP_COLORS: Record<string, string> = {
  B: '#e63946',
  C: '#2a9d8f',
  D: '#e9c46a',
  E: '#f4a261',
  F: '#457b9d',
}

// SVG renderer used instead of canvas — canvas doesn't respect pane z-index for click interception

// ─── helpers ─────────────────────────────────────────────────────────────────

function polygonCentroid(geometry: any): [number, number] {
  const ring = geometry.type === 'Polygon'
    ? geometry.coordinates[0]
    : geometry.coordinates[0][0]
  let lng = 0, lat = 0
  for (const [x, y] of ring) { lng += x; lat += y }
  return [lng / ring.length, lat / ring.length]
}

function humanLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim()
}

async function loadFgb(url: string, signal: AbortSignal): Promise<any[]> {
  const res = await fetch(url, { signal })
  const all: any[] = []
  for await (const f of geojson.deserialize(res.body!)) all.push(f)
  return all
}

// ─── sub-components ───────────────────────────────────────────────────────────

function ZoomToData({ features }: { features: any[] }) {
  const map = useMap()
  useEffect(() => {
    if (!features.length) return
    const bounds = L.geoJSON({ type: 'FeatureCollection', features } as any).getBounds()
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] })
  }, [features, map])
  return null
}

function ZoomTracker({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMapEvents({ zoomend: () => onZoom(map.getZoom()) })
  void map
  return null
}

// Puts hex above TPP so clicks reach hex cells even when TPP is also shown
function PaneSetup() {
  const map = useMap()
  useEffect(() => {
    if (!map.getPane('hexPane')) {
      const pane = map.createPane('hexPane')
      pane.style.zIndex = '450'   // default overlayPane is 400
    }
  }, [map])
  return null
}

/** Imperative hex polygon layer — uses pane option directly, bypassing react-leaflet prop types */
function HexPolygonLayer({ features }: { features: any[] }) {
  const map = useMap()
  const layerRef = useRef<L.GeoJSON | null>(null)

  useEffect(() => {
    if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null }
    if (!features.length) return

    const layer = L.geoJSON({ type: 'FeatureCollection', features } as any, {
      pane: 'hexPane',
      style: hexStyle,
      onEachFeature: (f: any, l: L.Layer) => {
        hexPopup(f, l)
        l.on({
          mouseover: (e: any) => e.target.setStyle({ weight: 2, fillOpacity: 0.7 }),
          mouseout:  (e: any) => e.target.setStyle(hexStyle(e.target.feature)),
        })
      },
    })
    layer.addTo(map)
    layerRef.current = layer

    return () => { if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null } }
  }, [features, map])

  return null
}

/** Grid-based cluster bubbles rendered as L.divIcon markers */
function HexClusterLayer({ features, zoom }: { features: any[]; zoom: number }) {
  const map = useMap()
  const layerRef = useRef<L.LayerGroup | null>(null)

  useEffect(() => {
    if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null }
    if (!features.length) return

    const cellDeg = zoom < 5 ? 4 : zoom < 7 ? 2 : zoom < 9 ? 1 : zoom < 11 ? 0.5 : 0.25
    const grid: Record<string, { lat: number; lng: number; count: number; matched: number }> = {}

    for (const f of features) {
      const [lng, lat] = polygonCentroid(f.geometry)
      const key = `${Math.floor(lat / cellDeg)}_${Math.floor(lng / cellDeg)}`
      if (!grid[key]) grid[key] = { lat, lng, count: 0, matched: 0 }
      grid[key].count++
      if (f.properties.matched) grid[key].matched++
    }

    const group = L.layerGroup()

    for (const c of Object.values(grid)) {
      const ratio  = c.matched / c.count
      const bg     = ratio > 0.6 ? '#22c55e' : ratio > 0.3 ? '#f59e0b' : '#64748b'
      const size   = Math.max(28, Math.min(58, 18 + Math.sqrt(c.count) * 2.2))
      const fs     = size < 36 ? 11 : 13

      const icon = L.divIcon({
        className: '',
        iconSize:   [size, size],
        iconAnchor: [size / 2, size / 2],
        html: `<div style="
          width:${size}px;height:${size}px;border-radius:50%;
          background:${bg};border:2.5px solid rgba(255,255,255,0.85);
          display:flex;align-items:center;justify-content:center;
          color:#fff;font-weight:700;font-size:${fs}px;
          box-shadow:0 2px 8px rgba(0,0,0,0.28);
          font-family:system-ui,sans-serif">${c.count}</div>`,
      })

      L.marker([c.lat, c.lng], { icon })
        .bindPopup(`
          <div style="font-family:sans-serif;font-size:13px;min-width:160px">
            <div style="font-weight:700;margin-bottom:6px;color:#1e293b">${c.count} hex cells</div>
            <table style="border-collapse:collapse;width:100%">
              <tr><td style="color:#64748b;padding:3px 8px 3px 0">Matched</td>
                  <td style="color:#16a34a;font-weight:600">${c.matched} (${Math.round(ratio * 100)}%)</td></tr>
              <tr><td style="color:#64748b;padding:3px 8px 3px 0">Not matched</td>
                  <td>${c.count - c.matched}</td></tr>
            </table>
            <div style="color:#94a3b8;font-size:11px;margin-top:6px">Zoom in to see individual cells</div>
          </div>
        `, { maxWidth: 240 })
        .addTo(group)
    }

    group.addTo(map)
    layerRef.current = group

    return () => { if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null } }
  }, [features, zoom, map])

  return null
}

// ─── styles & popups ─────────────────────────────────────────────────────────

function tppStyle(feature: any) {
  const group = feature?.properties?.TPP_group ?? ''
  const color = TPP_COLORS[group] ?? '#888'
  return { color, weight: 1.5, fillColor: color, fillOpacity: 0.35 }
}

function hexStyle(feature: any) {
  const matched = feature?.properties?.matched
  const count   = Number(feature?.properties?.count ?? 0)
  return {
    color:       matched ? '#16a34a' : '#6b7280',
    weight:      0.4,
    fillColor:   matched ? '#22c55e' : '#94a3b8',
    fillOpacity: matched ? Math.min(0.18 + count * 0.008, 0.72) : 0.1,
  }
}

function tppPopup(feature: any, layer: L.Layer) {
  const p = feature.properties ?? {}
  const crops = Array.isArray(p.ProdList_2)
    ? p.ProdList_2.slice(0, 6).join(', ') + (p.ProdList_2.length > 6 ? ` +${p.ProdList_2.length - 6} more` : '')
    : p.ProdList_2 ?? '—'

  ;(layer as L.Path).bindPopup(`
    <div style="min-width:200px;font-family:sans-serif;font-size:13px">
      <div style="font-weight:700;font-size:14px;color:#1e293b;margin-bottom:8px">
        ${p.NAME_0 ?? p.NAME_ENGLI ?? ''} — Group ${p.TPP_group ?? ''}
      </div>
      <table style="border-collapse:collapse;width:100%">
        ${p.NAME_1 ? `<tr><td style="color:#64748b;padding:3px 8px 3px 0;white-space:nowrap">Region</td><td>${p.NAME_1}</td></tr>` : ''}
        ${p.NAME_2 ? `<tr><td style="color:#64748b;padding:3px 8px 3px 0;white-space:nowrap">District</td><td>${p.NAME_2}</td></tr>` : ''}
        ${p.ENGTYPE_1 ? `<tr><td style="color:#64748b;padding:3px 8px 3px 0;white-space:nowrap">Type</td><td>${p.ENGTYPE_1}</td></tr>` : ''}
        ${p.ISO ? `<tr><td style="color:#64748b;padding:3px 8px 3px 0;white-space:nowrap">ISO</td><td>${p.ISO}</td></tr>` : ''}
        ${crops !== '—' ? `<tr><td style="color:#64748b;padding:3px 8px 3px 0;white-space:nowrap">Products</td><td style="font-size:12px">${crops}</td></tr>` : ''}
      </table>
    </div>
  `, { maxWidth: 320 })
}

function hexPopup(feature: any, layer: L.Layer) {
  const p = feature.properties ?? {}
  const skip = new Set(['matched', 'count', 'labels'])

  const rows = Object.entries(p)
    .filter(([k, v]) => !skip.has(k) && v != null && v !== '')
    .map(([k, v], i) => `
      <tr style="${i % 2 === 0 ? 'background:#f8fafc' : ''}">
        <td style="color:#64748b;padding:3px 8px 3px 0;white-space:nowrap;font-size:12px">${humanLabel(k)}</td>
        <td style="font-size:12px">${v}</td>
      </tr>`)
    .join('')

  const labelRows = p.labels
    ? p.labels.split(' | ').map((l: string, i: number) => `
        <tr style="${i % 2 === 0 ? 'background:#f0fdf4' : ''}">
          <td colspan="2" style="font-size:11px;color:#16a34a;padding:2px 4px">${l}</td>
        </tr>`).join('')
    : ''

  ;(layer as L.Path).bindPopup(`
    <div style="min-width:230px;max-width:320px;font-family:sans-serif;font-size:13px">
      <div style="font-weight:700;font-size:14px;color:#1e293b;margin-bottom:8px">
        Hex Cell &nbsp;${p.matched ? '<span style="color:#16a34a">✅ Matched</span>' : '<span style="color:#dc2626">❌ Not matched</span>'}
      </div>
      <table style="border-collapse:collapse;width:100%">
        <tr style="background:#f8fafc">
          <td style="color:#64748b;padding:3px 8px 3px 0;white-space:nowrap;font-size:12px">Count</td>
          <td style="font-weight:700">${p.count ?? 0}</td>
        </tr>
        ${rows}
      </table>
      ${labelRows ? `
        <div style="margin-top:8px;font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em">
          Scoring Labels
        </div>
        <table style="border-collapse:collapse;width:100%;margin-top:4px">
          ${labelRows}
        </table>` : ''}
    </div>
  `, { maxWidth: 340 })
}

function hoverHandlers(styleFn: (f: any) => any) {
  return {
    mouseover: (e: any) => e.target.setStyle({ weight: 2, fillOpacity: 0.7 }),
    mouseout:  (e: any) => e.target.setStyle(styleFn(e.target.feature)),
  }
}

// ─── main component ───────────────────────────────────────────────────────────

export default function UkraineLayerMap() {
  const [active, setActive]     = useState<ActiveLayer>('tpp')
  const [tppFeatures, setTpp]   = useState<any[]>([])
  const [hexFeatures, setHex]   = useState<any[]>([])
  const [loading, setLoading]   = useState(false)
  const [mapZoom, setMapZoom]   = useState(ALL_ZOOM)

  // cache per file — switching layers is instant after first load
  const cache = useRef<Partial<Record<string, any[]>>>({})

  const showTpp      = active === 'tpp' || active === 'all'
  const showHex      = active === 'hex' || active === 'all'
  const showPolygons = mapZoom >= CLUSTER_ZOOM_THRESHOLD

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)

    ;(async () => {
      try {
        const get = async (file: string) => {
          if (cache.current[file]) return cache.current[file]!
          const data = await loadFgb(`/fgb/${file}`, ctrl.signal)
          cache.current[file] = data
          return data
        }

        // load all countries in parallel
        const results = await Promise.all(
          ALL_COUNTRIES.map(c => Promise.all([
            showTpp ? get(COUNTRIES[c].tpp) : Promise.resolve([]),
            showHex ? get(COUNTRIES[c].hex) : Promise.resolve([]),
          ]))
        )

        setTpp(results.flatMap(([tpp]) => tpp))
        setHex(results.flatMap(([, hex]) => hex))
      } catch (e: any) {
        if (e.name !== 'AbortError') console.error(e)
      } finally {
        setLoading(false)
      }
    })()

    return () => ctrl.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const zoomFeatures = useMemo(
    () => (active === 'hex' ? hexFeatures : tppFeatures),
    [active, tppFeatures, hexFeatures]
  )

  const totalFeatures = tppFeatures.length + hexFeatures.length

  const tppData = useMemo(() => ({ type: 'FeatureCollection' as const, features: tppFeatures }), [tppFeatures])

  const TABS: { id: ActiveLayer; label: string }[] = [
    { id: 'tpp', label: '🗂 TPP Layer' },
    { id: 'hex', label: '⬡ Hex Grid'  },
    { id: 'all', label: '⊕ All'        },
  ]

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>

      {/* ── Top control bar ── */}
      <div style={{
        position: 'absolute', zIndex: 1000, top: 14, left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex', gap: 3, alignItems: 'center',
        background: '#fff',
        border: '1px solid #e2e8f0',
        borderRadius: 10,
        padding: '4px',
        boxShadow: '0 2px 14px rgba(0,0,0,.13)',
        whiteSpace: 'nowrap',
      }}>
        {/* Country flags — read-only, shows what's loaded */}
        <div style={{ padding: '6px 12px', fontSize: 13, color: '#64748b', display: 'flex', gap: 4 }}>
          {ALL_COUNTRIES.map(c => <span key={c} title={COUNTRIES[c].label}>{COUNTRIES[c].label.split(' ')[0]}</span>)}
        </div>

        <div style={{ width: 1, height: 24, background: '#e2e8f0', margin: '0 2px' }} />

        {/* Layer tabs */}
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setActive(id)}
            style={{
              padding: '7px 18px', borderRadius: 7, border: 'none',
              cursor: 'pointer', fontWeight: active === id ? 700 : 500,
              fontSize: 13,
              background: active === id
                ? id === 'all' ? '#7c3aed' : '#1e293b'
                : 'transparent',
              color: active === id ? '#f8fafc' : '#64748b',
              transition: 'all .15s',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Loading pill ── */}
      {loading && (
        <div style={{
          position: 'absolute', zIndex: 1000, top: 68, left: '50%',
          transform: 'translateX(-50%)',
          background: '#fff', padding: '5px 18px',
          borderRadius: 20, fontSize: 13, color: '#64748b',
          boxShadow: '0 2px 8px rgba(0,0,0,.1)',
        }}>
          Loading…
        </div>
      )}

      {/* ── Zoom indicator (shows when hex is visible) ── */}
      {showHex && hexFeatures.length > 0 && !loading && (
        <div style={{
          position: 'absolute', zIndex: 1000, top: 68, left: '50%',
          transform: 'translateX(-50%)',
          background: showPolygons ? '#f0fdf4' : '#fefce8',
          border: `1px solid ${showPolygons ? '#bbf7d0' : '#fef08a'}`,
          padding: '4px 14px', borderRadius: 20, fontSize: 12,
          color: showPolygons ? '#16a34a' : '#92400e',
          boxShadow: '0 1px 6px rgba(0,0,0,.08)',
        }}>
          {showPolygons
            ? `⬡ Showing ${hexFeatures.length} hex cells`
            : `⊙ Clustered — zoom in past ${CLUSTER_ZOOM_THRESHOLD} for individual cells`}
        </div>
      )}

      {/* ── Legend ── */}
      {!loading && (showTpp || showHex) && (
        <div style={{
          position: 'absolute', zIndex: 1000, bottom: 30, right: 14,
          background: '#fff', border: '1px solid #e2e8f0',
          borderRadius: 10, padding: '12px 16px',
          fontSize: 12, boxShadow: '0 2px 12px rgba(0,0,0,.1)',
          minWidth: 150,
        }}>
          {showTpp && tppFeatures.length > 0 && (
            <>
              <div style={{ fontWeight: 700, marginBottom: 7, color: '#1e293b' }}>
                TPP Groups
                <span style={{ float: 'right', color: '#94a3b8', fontWeight: 400 }}>{tppFeatures.length}</span>
              </div>
              {Object.entries(TPP_COLORS).map(([g, c]) => (
                <div key={g} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                  <span style={{ width: 13, height: 13, borderRadius: 3, background: c, display: 'inline-block', opacity: .75 }} />
                  Group {g}
                </div>
              ))}
            </>
          )}

          {showTpp && showHex && tppFeatures.length > 0 && hexFeatures.length > 0 && (
            <div style={{ borderTop: '1px solid #e2e8f0', margin: '10px 0' }} />
          )}

          {showHex && hexFeatures.length > 0 && (
            <>
              <div style={{ fontWeight: 700, marginBottom: 7, color: '#1e293b' }}>
                Hex Grid
                <span style={{ float: 'right', color: '#94a3b8', fontWeight: 400 }}>{hexFeatures.length}</span>
              </div>
              {showPolygons ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                    <span style={{ width: 13, height: 13, borderRadius: 3, background: '#22c55e', display: 'inline-block', opacity: .65 }} />
                    Matched
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ width: 13, height: 13, borderRadius: 3, background: '#94a3b8', display: 'inline-block', opacity: .6 }} />
                    Not matched
                  </div>
                </>
              ) : (
                <>
                  {[['#22c55e', '>60% matched'], ['#f59e0b', '30–60% matched'], ['#64748b', '<30% matched']].map(([c, l]) => (
                    <div key={l} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4 }}>
                      <span style={{ width: 13, height: 13, borderRadius: '50%', background: c, display: 'inline-block', opacity: .75 }} />
                      {l}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}

      <MapContainer
        center={ALL_CENTER}
        zoom={ALL_ZOOM}
        style={{ width: '100%', height: '100%' }}
      >
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="© OpenStreetMap"
        />

        <PaneSetup />
        <ZoomTracker onZoom={setMapZoom} />
        <ZoomToData features={zoomFeatures} />

        {/* Hex layer — clusters below threshold, polygons above */}
        {showHex && hexFeatures.length > 0 && (
          showPolygons ? (
            <HexPolygonLayer key={`hex-${hexFeatures.length}`} features={hexFeatures} />
          ) : (
            <HexClusterLayer features={hexFeatures} zoom={mapZoom} />
          )
        )}

        {showTpp && tppFeatures.length > 0 && (
          <GeoJSON
            key={`tpp-${tppFeatures.length}`}
            data={tppData as any}
            style={tppStyle}
            onEachFeature={(f, l) => { tppPopup(f, l); (l as any).on(hoverHandlers(tppStyle)) }}
          />
        )}
      </MapContainer>
    </div>
  )
}
