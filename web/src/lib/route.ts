// Two screens, no router library: "/" = all spots, "/spot/<id>" = one spot.
// Vercel rewrites /spot/* to index.html (vercel.json) and the service worker serves the app
// shell for any page, so both also open offline.

import { useEffect, useState } from 'react'

export type Route = { name: 'home' } | { name: 'spot'; spotId: string }

export function parseRoute(pathname: string): Route {
  const m = pathname.match(/^\/spot\/([a-z0-9-]+)\/?$/)
  return m ? { name: 'spot', spotId: m[1] } : { name: 'home' }
}

export const spotPath = (id: string) => `/spot/${id}`

const listeners = new Set<() => void>()

/** Go to a screen inside the app (no page load). */
export function navigate(path: string) {
  if (path === window.location.pathname && !window.location.hash) return
  window.history.pushState(null, '', path)
  listeners.forEach((l) => l())
  window.scrollTo(0, 0)
}

/** For <a href> links: plain clicks stay in the app; ctrl/cmd-click etc. open a new tab as usual. */
export function linkClick(e: React.MouseEvent<HTMLAnchorElement>) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  navigate(e.currentTarget.getAttribute('href') ?? '/')
}

export function useRoute(): Route {
  const [path, setPath] = useState(() => window.location.pathname)
  useEffect(() => {
    const update = () => setPath(window.location.pathname)
    listeners.add(update)
    window.addEventListener('popstate', update)
    return () => {
      listeners.delete(update)
      window.removeEventListener('popstate', update)
    }
  }, [])
  return parseRoute(path)
}
