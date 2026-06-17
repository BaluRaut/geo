import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN as string
import { useCallback, useEffect, useRef, useState } from 'react'
import { geojson as fgb } from 'flatgeobuf'

// ─── config ──────────────────────────────────────────────────────────────────

const ZOOM_THRESHOLD = 5  // cluster → polygon crossover
const CDN = '/fgb'

const COUNTRIES = {
  ukraine: { tpp: 'ukraine_tpp.fgb',      hex: 'ukraine_hex_grid.fgb', tpr: 'ukraine_tpr.fgb' },
  hungary: { tpp: 'hungary_tpp.fgb',      hex: 'hungary_hexgrid.fgb',  tpr: 'hungary_tpr.fgb' },
  romania: { tpp: 'romania_tpp.fgb',      hex: 'romania_hexgrid.fgb',  tpr: 'romania_tpr.fgb' },
} as const

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] }

const TPP_GROUPS: Record<string, { color: string; label: string }> = {
  B: { color: '#e63946', label: 'Group B' },
  C: { color: '#2a9d8f', label: 'Group C' },
  D: { color: '#e9c46a', label: 'Group D' },
  E: { color: '#f4a261', label: 'Group E' },
  F: { color: '#457b9d', label: 'Group F' },
}

// Mapbox match expression — colour line by TPP_group value
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TPP_COLOR_EXPR: any = [
  'match', ['get', 'TPP_group'],
  ...Object.entries(TPP_GROUPS).flatMap(([k, { color }]) => [k, color]),
  '#888888',
]

// ─── FGB loaders ─────────────────────────────────────────────────────────────

async function loadAll(file: string, signal: AbortSignal): Promise<GeoJSON.Feature[]> {
  const res = await fetch(`${CDN}/${file}`, { signal })
  const out: GeoJSON.Feature[] = []
  for await (const f of fgb.deserialize(res.body!)) {
    if (signal.aborted) break
    out.push(f as GeoJSON.Feature)
  }
  return out
}

// Uses FlatGeobuf HTTP range requests — only fetches cells inside the bbox
async function loadBbox(file: string, bounds: mapboxgl.LngLatBounds): Promise<GeoJSON.Feature[]> {
  const rect = {
    minX: bounds.getWest(), minY: bounds.getSouth(),
    maxX: bounds.getEast(), maxY: bounds.getNorth(),
  }
  const out: GeoJSON.Feature[] = []
  for await (const f of fgb.deserialize(`${CDN}/${file}`, rect)) out.push(f as GeoJSON.Feature)
  return out
}

// ─── utils ───────────────────────────────────────────────────────────────────


function humanLabel(key: string) {
  return key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')       // camelCase: "cropName" → "crop Name"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')   // acronym: "TPPGroup" → "TPP Group"
    .split(/[_\s]+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .trim()
}

// alias.json: { "k0": "GrainCorn tpr - BALANCED", … }
let aliasLookup: Record<string, string> = {}
// hex-meta.json: per-country averaged vertex offsets from centroid
// { ukraine_hex_grid: { offsets: [[dx,dy], …] }, … }
let hexMeta: Record<string, { offsets: [number, number][] }> = {}

async function loadAlias() {
  const [alias, meta] = await Promise.allSettled([
    fetch('/fgb/alias.json').then(r => r.json()),
    fetch('/fgb/hex-meta.json').then(r => r.json()),
  ])
  if (alias.status === 'fulfilled') aliasLookup = alias.value
  if (meta.status  === 'fulfilled') hexMeta     = meta.value
}

// Reconstruct polygon from centroid Point + country template offsets
function reconstructCell(f: GeoJSON.Feature, templateKey: string): GeoJSON.Feature {
  const [cx, cy] = (f.geometry as GeoJSON.Point).coordinates
  const offsets = hexMeta[templateKey]?.offsets
  if (!offsets?.length) return f
  const coords = offsets.map(([dx, dy]) => [cx + dx, cy + dy] as [number, number])
  coords.push(coords[0])
  return { ...f, geometry: { type: 'Polygon', coordinates: [coords] } }
}

function resolveKey(k: string): string {
  const full = aliasLookup[k] ?? k   // decode alias, or use key as-is
  return humanLabel(full)
}

function propsHtml(props: Record<string, unknown>) {
  const rows = Object.entries(props)
    .filter(([k, v]) => !k.startsWith('_') && v !== null && v !== '' && v !== undefined)
    .map(([k, v]) =>
      `<tr>
        <td style="padding:3px 10px 3px 0;color:#94a3b8;white-space:nowrap;font-size:11px">${resolveKey(k)}</td>
        <td style="padding:3px 0;font-size:12px">${v}</td>
      </tr>`
    ).join('')
  return `<div style="font-family:system-ui,sans-serif;max-height:260px;overflow-y:auto">
    <table style="border-collapse:collapse">${rows}</table>
  </div>`
}

function setData(map: mapboxgl.Map, id: string, features: GeoJSON.Feature[]) {
  const src = map.getSource(id) as mapboxgl.GeoJSONSource | undefined
  src?.setData({ type: 'FeatureCollection', features })
}

// ─── component ───────────────────────────────────────────────────────────────

type LayerToggle = 'tpp' | 'hex' | 'tpr'

export default function MapboxMap() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef       = useRef<mapboxgl.Map | null>(null)
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tprAbortRef  = useRef<AbortController | null>(null)

  const [loading, setLoading]         = useState(true)
  const [zoom, setZoom]               = useState(5)
  const [visible, setVisible]         = useState<Record<LayerToggle, boolean>>({
    tpp: true, hex: true, tpr: true,
  })

  // apply layer visibility to the map after toggle
  const applyVisibility = useCallback((
    map: mapboxgl.Map,
    vis: Record<LayerToggle, boolean>,
    currentZoom: number,
  ) => {
    const hi = currentZoom >= ZOOM_THRESHOLD

    const show = (id: string, on: boolean) =>
      map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')

    show('tpp-stroke', vis.tpp)

    // Hex: clusters at low zoom, polygons at high zoom
    show('hex-clusters',       vis.hex && !hi)
    show('hex-cluster-count',  vis.hex && !hi)
    show('hex-unclustered',    vis.hex && !hi)
    show('hex-fill',           vis.hex && hi)
    show('hex-stroke',         vis.hex && hi)

    // TPR only at high zoom
    show('tpr-fill',   vis.tpr && hi)
    show('tpr-stroke', vis.tpr && hi)
  }, [])

  // viewport TPR load, called on moveend when zoom >= threshold
  const loadTpr = useCallback(async () => {
    const map = mapRef.current
    if (!map || map.getZoom() < ZOOM_THRESHOLD) return

    tprAbortRef.current?.abort()
    tprAbortRef.current = new AbortController()

    const bounds = map.getBounds()
    const results = await Promise.allSettled(
      Object.values(COUNTRIES).map(c => loadBbox(c.tpr, bounds))
    )
    const features = results
      .filter((r): r is PromiseFulfilledResult<GeoJSON.Feature[]> => r.status === 'fulfilled')
      .flatMap(r => r.value)

    if (mapRef.current) setData(map, 'tpr', features)
  }, [])

  useEffect(() => {
    if (!containerRef.current) return

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: 'mapbox://styles/mapbox/satellite-streets-v12',
      center: [26, 48],
      zoom: 5,
    })

    mapRef.current = map
    map.addControl(new mapboxgl.NavigationControl(), 'top-right')
    map.addControl(new mapboxgl.ScaleControl(), 'bottom-left')

    map.on('load', async () => {
      await loadAlias()

      // ── sources ────────────────────────────────────────────────────────────
      map.addSource('tpp', { type: 'geojson', data: EMPTY })
      map.addSource('hex-points', {
        type: 'geojson', data: EMPTY,
        cluster: true,
        clusterMaxZoom: ZOOM_THRESHOLD - 1,
        clusterRadius: 40,
      })
      map.addSource('hex-polygons', { type: 'geojson', data: EMPTY, generateId: true })
      map.addSource('tpr',          { type: 'geojson', data: EMPTY, generateId: true })

      // ── TPP — dashed border only, coloured by TPP_group ───────────────────
      map.addLayer({
        id: 'tpp-stroke', type: 'line', source: 'tpp',
        paint: {
          'line-color':     TPP_COLOR_EXPR,
          'line-width':     2.5,
          'line-opacity':   0.9,
        },
      })

      // ── hex clusters (zoom < 10) ───────────────────────────────────────────
      map.addLayer({
        id: 'hex-clusters', type: 'circle', source: 'hex-points',
        filter: ['has', 'point_count'],
        paint: {
          'circle-color': '#f59e0b',
          'circle-opacity': 0.9,
          'circle-radius': ['step', ['get', 'point_count'], 12, 20, 17, 100, 23],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#92400e',
        },
      })
      map.addLayer({
        id: 'hex-cluster-count', type: 'symbol', source: 'hex-points',
        filter: ['has', 'point_count'],
        layout: {
          'text-field': '{point_count_abbreviated}',
          'text-font': ['DIN Offc Pro Medium', 'Arial Unicode MS Regular'],
          'text-size': 11,
        },
        paint: { 'text-color': '#fff' },
      })
      map.addLayer({
        id: 'hex-unclustered', type: 'circle', source: 'hex-points',
        filter: ['!', ['has', 'point_count']],
        paint: { 'circle-color': '#f59e0b', 'circle-radius': 5, 'circle-opacity': 0.9 },
      })

      // ── hex polygons (zoom >= 10) — hidden until zoom threshold ───────────
      map.addLayer({
        id: 'hex-fill', type: 'fill', source: 'hex-polygons',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.12 },
      })
      map.addLayer({
        id: 'hex-stroke', type: 'line', source: 'hex-polygons',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#ffffff', 'line-width': 0.8, 'line-opacity': 0.65 },
      })

      // ── TPR (zoom >= 10, viewport bbox only) ───────────────────────────────
      map.addLayer({
        id: 'tpr-fill', type: 'fill', source: 'tpr',
        layout: { visibility: 'none' },
        paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.3 },
      })
      map.addLayer({
        id: 'tpr-stroke', type: 'line', source: 'tpr',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#1d4ed8', 'line-width': 0.4 },
      })

      // ── popup — single handler with explicit priority ──────────────────────
      // At zoom >= 10: hex > tpr > tpp. Below 10: tpp only.
      map.on('click', e => {
        const z = map.getZoom()
        const hi = z >= ZOOM_THRESHOLD

        const layers = hi
          ? ['hex-fill', 'tpr-fill', 'tpp-stroke']
          : ['tpp-stroke']

        for (const layerId of layers) {
          const hits = map.queryRenderedFeatures(e.point, { layers: [layerId] })
          if (hits.length > 0) {
            const props = hits[0].properties
            if (!props) continue
            new mapboxgl.Popup({ maxWidth: '340px' })
              .setLngLat(e.lngLat)
              .setHTML(propsHtml(props))
              .addTo(map)
            break  // first match wins — hex beats tpr beats tpp
          }
        }
      })

      // ── cursor ─────────────────────────────────────────────────────────────
      map.on('mousemove', e => {
        const z = map.getZoom()
        const hi = z >= ZOOM_THRESHOLD
        const layers = hi
          ? ['hex-fill', 'tpr-fill', 'tpp-stroke', 'hex-unclustered', 'hex-clusters']
          : ['tpp-stroke', 'hex-clusters']
        const hit = map.queryRenderedFeatures(e.point, { layers }).length > 0
        map.getCanvas().style.cursor = hit ? 'pointer' : ''
      })

      // ── zoom-aware layer visibility ────────────────────────────────────────
      const onZoom = () => {
        const z = map.getZoom()
        setZoom(z)
        setVisible(v => {
          applyVisibility(map, v, z)
          return v
        })
      }
      map.on('zoomend', onZoom)
      onZoom()  // apply immediately based on initial zoom

      // ── data load (after handlers are wired up) ────────────────────────────
      const ctrl = new AbortController()
      setLoading(true)
      try {
        const tppResults = await Promise.allSettled(
          Object.values(COUNTRIES).map(c => loadAll(c.tpp, ctrl.signal))
        )
        const tppFeatures = tppResults
          .filter((r): r is PromiseFulfilledResult<GeoJSON.Feature[]> => r.status === 'fulfilled')
          .flatMap(r => r.value)
        setData(map, 'tpp', tppFeatures)

        const hexResults = await Promise.allSettled(
          Object.values(COUNTRIES).map(c => loadAll(c.hex, ctrl.signal))
        )
        // FGB stores centroid Points — use directly for clustering,
        // reconstruct polygons per-country using the averaged shape template
        const hexByCountry = hexResults.map((r, i) => ({
          points:   r.status === 'fulfilled' ? r.value : [] as GeoJSON.Feature[],
          template: Object.values(COUNTRIES)[i].hex.replace('.fgb', ''),
        }))

        const hexPoints   = hexByCountry.flatMap(c => c.points)
        const hexPolygons = hexByCountry.flatMap(c =>
          c.points.map(f => reconstructCell(f, c.template))
        )

        setData(map, 'hex-points',   hexPoints)
        setData(map, 'hex-polygons', hexPolygons)
      } finally {
        setLoading(false)
      }
    })

    // ── TPR viewport load on pan/zoom ──────────────────────────────────────
    map.on('moveend', () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(loadTpr, 350)
    })

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      tprAbortRef.current?.abort()
      map.remove()
    }
  }, [loadTpr, applyVisibility])

  // keep MapLibre in sync when user clicks toggle buttons
  const toggle = (layer: LayerToggle) => {
    setVisible(prev => {
      const next = { ...prev, [layer]: !prev[layer] }
      if (mapRef.current) applyVisibility(mapRef.current, next, zoom)
      return next
    })
  }

  const btnStyle = (on: boolean, color: string): React.CSSProperties => ({
    padding: '5px 12px',
    border: `1.5px solid ${on ? color : '#374151'}`,
    background: on ? `${color}22` : 'rgba(0,0,0,0.6)',
    color: on ? color : '#6b7280',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    fontFamily: 'system-ui,sans-serif',
    transition: 'all .15s',
  })

  const isDetail = zoom >= ZOOM_THRESHOLD

  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* layer toggles */}
      <div style={{
        position: 'absolute', top: 12, left: 12,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={btnStyle(visible.tpp, '#e63946')} onClick={() => toggle('tpp')}>
            TPP
          </button>
          <button style={btnStyle(visible.hex, '#f59e0b')} onClick={() => toggle('hex')}>
            HEX
          </button>
          <button
            style={btnStyle(visible.tpr && isDetail, '#3b82f6')}
            onClick={() => toggle('tpr')}
            title={!isDetail ? 'Zoom in past 10 to see TPR' : undefined}
          >
            TPR {!isDetail && '(zoom ≥10)'}
          </button>
        </div>

        <div style={{
          background: 'rgba(0,0,0,0.65)', color: '#6b7280',
          padding: '3px 8px', borderRadius: 5, fontSize: 11,
          fontFamily: 'system-ui,sans-serif',
        }}>
          {isDetail
            ? `zoom ${zoom.toFixed(1)} — polygons + TPR viewport`
            : `zoom ${zoom.toFixed(1)} — clustered`}
        </div>
      </div>

      {/* TPP legend — bottom right */}
      {visible.tpp && (
        <div style={{
          position: 'absolute', bottom: 32, right: 12,
          background: 'rgba(0,0,0,0.72)', borderRadius: 8,
          padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 2 }}>TPP Group</div>
          {Object.entries(TPP_GROUPS).map(([key, { color, label }]) => (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="28" height="10">
                <line x1="0" y1="5" x2="28" y2="5"
                  stroke={color} strokeWidth="2.5" />
              </svg>
              <span style={{ fontSize: 12, color: '#e2e8f0', fontFamily: 'system-ui,sans-serif' }}>{label}</span>
            </div>
          ))}
        </div>
      )}

      {loading && (
        <div style={{
          position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(0,0,0,0.75)', color: '#d1d5db',
          padding: '6px 18px', borderRadius: 20, fontSize: 12,
          fontFamily: 'system-ui,sans-serif', pointerEvents: 'none',
        }}>
          Loading layers…
        </div>
      )}
    </div>
  )
}
