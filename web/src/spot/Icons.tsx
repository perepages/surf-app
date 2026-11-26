// One small icon family, inline SVG, 1.5 px strokes on a 20 px grid (no icon package).

type P = { className?: string; size?: number }
const base = (size = 18) => ({
  width: size,
  height: size,
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
})

export const IconCheck = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M4.5 10.5l3.5 3.5 7.5-8" /></svg>
)
export const IconCross = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" /></svg>
)
export const IconDash = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M5 10h10" /></svg>
)
export const IconBell = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M5 14V9a5 5 0 0 1 10 0v5l1.5 1.5h-13zM8.5 17.5h3" /></svg>
)
export const IconStar = ({ className, size, filled }: P & { filled?: boolean }) => (
  <svg {...base(size)} className={className}>
    <path d="M10 3l2.1 4.4 4.8.6-3.5 3.3.9 4.7L10 13.7 5.7 16l.9-4.7L3.1 8l4.8-.6z" fill={filled ? 'currentColor' : 'none'} />
  </svg>
)
export const IconSliders = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M4 6h7M15 6h1M4 14h1M9 14h7" /><circle cx="13" cy="6" r="2" /><circle cx="7" cy="14" r="2" /></svg>
)
export const IconBack = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M12 4.5 6.5 10l5.5 5.5" /></svg>
)
export const IconWarn = ({ className, size }: P) => (
  <svg {...base(size)} className={className}><path d="M10 3.5 17 16H3zM10 8.5v3.5M10 14.2v.1" /></svg>
)
/** Arrow pointing up; rotate it to point where something travels TO. */
export const IconArrow = ({ className, size, rotate = 0 }: P & { rotate?: number }) => (
  <svg {...base(size)} className={className} style={{ transform: `rotate(${rotate}deg)` }}><path d="M10 16V4M5.5 8.5 10 4l4.5 4.5" /></svg>
)
