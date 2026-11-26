// Logo: mark + wordmark in one SVG. Replace this file to swap the logo.
// Mark = a bearing: the shoreline (long hairline), the sea below (short hairline) and one
// line cutting across at the angle a swell arrives, ending in the accent dot.

export function Logo({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 168 28" className={className} role="img" aria-label="Is it worth surf">
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <rect x="1" y="1" width="26" height="26" rx="6" strokeOpacity=".45" />
        <path d="M6 12h16" />
        <path d="M10 18h8" strokeOpacity=".6" />
        <path d="M9 23 19 6" />
      </g>
      <circle cx="19" cy="6" r="2.4" fill="var(--accent)" />
      <text x="36" y="19" fill="currentColor" style={{ font: '600 14px var(--font-ui)', letterSpacing: '-0.01em' }}>
        is it worth
      </text>
      <text x="112" y="20" fill="currentColor" style={{ font: '800 22px var(--font-display)', letterSpacing: '0.02em' }}>
        surf
      </text>
    </svg>
  )
}
