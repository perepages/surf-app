// Map of the spots (Leaflet + OpenStreetMap tiles). Loaded only when the map view is opened.
// Each spot is a score-coloured marker; tapping it opens the spot. OpenStreetMap's tile servers
// see the visitor's IP (privacy page); tiles are never cached by our service worker.

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'
import { SCORE_WORD } from './ScoreChip'
import { splitName, type RankedSpot } from './HomeScreen'
import { navigate, spotPath } from '../lib/route'

const COLOUR = ['', 'var(--color-s1)', 'var(--color-s2)', 'var(--color-s3)', 'var(--color-s4)', 'var(--color-s5)']
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function markerIcon(s: RankedSpot): L.DivIcon {
  const v = s.score?.value
  const bg = v ? COLOUR[v] : 'var(--color-deep)'
  const fg = v === 5 ? '#fff' : 'var(--color-abyss)'
  const ring = s.favourite ? 'var(--color-sand)' : 'var(--color-abyss)'
  return L.divIcon({
    className: '', // no Leaflet default white box
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    tooltipAnchor: [0, -20],
    html: `<span style="display:grid;place-items:center;width:36px;height:36px;border-radius:12px;background:${bg};color:${fg};border:3px solid ${ring};font:900 20px/1 var(--font-display);box-shadow:0 2px 8px rgba(0,0,0,.45)">${v ?? '–'}</span>`,
  })
}

export default function SpotMap({ spots }: { spots: RankedSpot[] }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const fitted = useRef(false)

  useEffect(() => {
    if (!box.current) return
    const m = L.map(box.current, { zoomControl: true, attributionControl: true })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    }).addTo(m)
    map.current = m
    layer.current = L.layerGroup().addTo(m)
    return () => {
      m.remove()
      map.current = null
      fitted.current = false
    }
  }, [])

  useEffect(() => {
    const m = map.current
    const group = layer.current
    if (!m || !group) return
    group.clearLayers()
    for (const s of spots) {
      const { town } = splitName(s.spot.name)
      const v = s.score?.value
      const word = v ? SCORE_WORD[v].word : 'no data'
      const marker = L.marker([s.spot.lat, s.spot.lon], {
        icon: markerIcon(s),
        title: `${town}: ${v ? `${v} of 5, ${word.toLowerCase()}` : 'no data'}`,
        keyboard: true,
        riseOnHover: true,
        zIndexOffset: (v ?? 0) * 100, // best spots drawn on top when they overlap
      })
      // Name only (the marker already shows the score), so nearby labels overlap less.
      marker.bindTooltip(esc(town), {
        direction: 'top',
        permanent: spots.length <= 8, // few spots: always show names
        className: 'spot-tip',
      })
      marker.on('click keypress', () => navigate(spotPath(s.spot.id)))
      marker.addTo(group)
    }
    if (!fitted.current && spots.length) {
      fitted.current = true
      if (spots.length === 1) m.setView([spots[0].spot.lat, spots[0].spot.lon], 11)
      else m.fitBounds(L.latLngBounds(spots.map((s) => [s.spot.lat, s.spot.lon])), { padding: [48, 48], maxZoom: 12 })
    }
  }, [spots])

  return (
    <div className="mx-4 overflow-hidden rounded-3xl border border-line sm:mx-8">
      <div ref={box} className="h-[62dvh] min-h-80 w-full bg-deep" role="region" aria-label="Map of surf spots. Tap a spot to open it." />
    </div>
  )
}
