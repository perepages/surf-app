// Optional "were you at the beach?" check. Runs entirely on the device: the position is
// compared with the spot here and then thrown away. Only the yes/no answer leaves the phone,
// and only "yes" is stored (near_beach = true). Coordinates are never sent or saved.

import type { Spot } from './spot'

export const NEAR_BEACH_KM = 3
/** A fix vaguer than this can't tell 3 km apart reliably, so it doesn't count as "near". */
const MAX_ACCURACY_M = 1000

export type NearBeachResult = 'near' | 'far' | 'denied' | 'unavailable'

function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180
  const dLat = (lat2 - lat1) * rad
  const dLon = (lon2 - lon1) * rad
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(a))
}

export function checkNearBeach(spot: Spot): Promise<NearBeachResult> {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve('unavailable')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const km = distanceKm(pos.coords.latitude, pos.coords.longitude, spot.lat, spot.lon)
        resolve(km <= NEAR_BEACH_KM && pos.coords.accuracy <= MAX_ACCURACY_M ? 'near' : 'far')
      },
      (err) => resolve(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 10 * 60 * 1000 },
    )
  })
}
