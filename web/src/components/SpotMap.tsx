// Map of the spots (Leaflet + OpenStreetMap tiles). Loaded only when the map view is opened.
// Each spot is a score-coloured marker; tapping it opens the spot. OpenStreetMap's tile servers
// see the visitor's IP (privacy page); tiles are never cached by our service worker.

import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'
import { SCORE_WORD } from './ScoreChip'
import type { RankedSpot } from '../spot/HomePage'
import { splitName } from '../spot/ui'
import { designFor } from '../spot/spotDesign'
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
    html: `<span style="display:grid;place-items:center;width:36px;height:36px;border-radius:8px;background:${bg};color:${fg};border:3px solid ${ring};font:900 20px/1 var(--font-display);box-shadow:0 1px 3px rgba(0,0,0,.35)">${v ?? '–'}</span>`,
  })
}

export default function SpotMap({ spots, label = 'Map of surf spots. Tap a spot to open it.' }: { spots: RankedSpot[]; label?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const fitted = useRef(false)
  /** Puts every spot in view (set once the spots are known). */
  const fitAll = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!box.current) return
    // No wheel zoom: scrolling the page past the map must not zoom it (buttons and pinch still do).
    const m = L.map(box.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: false })
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    }).addTo(m)
    map.current = m
    layer.current = L.layerGroup().addTo(m)
    // Leaflet measures its box once; re-measure when the layout settles or the window changes,
    // and re-fit the spots while the page is still settling (not after the user has moved).
    const born = Date.now()
    const ro = new ResizeObserver(() => {
      m.invalidateSize()
      if (Date.now() - born < 2000) fitAll.current?.()
    })
    ro.observe(box.current)
    return () => {
      ro.disconnect()
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
      const town = designFor(s.spot.id)?.name ?? splitName(s.spot.name).town
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
      marker.on('click', () => navigate(spotPath(s.spot.id))) // Leaflet turns Enter on a focused marker into a click
      marker.addTo(group)
    }
    if (!fitted.current && spots.length) {
      fitted.current = true
      const fit = () => {
        m.invalidateSize()
        if (spots.length === 1) m.setView([spots[0].spot.lat, spots[0].spot.lon], 11, { animate: false })
        else m.fitBounds(L.latLngBounds(spots.map((s) => [s.spot.lat, s.spot.lon])), { padding: [48, 48], maxZoom: 12, animate: false })
      }
      fitAll.current = fit
      fit()
    }
  }, [spots])

  return (
    <div className="overflow-hidden rounded-[10px] border border-line">
      <div ref={box} className="h-[62dvh] min-h-80 w-full bg-deep" role="region" aria-label={label} />
    </div>
  )
}
