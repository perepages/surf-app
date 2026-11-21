// Framer Motion's animation features, loaded right after the first screen instead of with it
// (LazyMotion in App.tsx). domMax because the hour strip uses shared layout animations (layoutId).
export { domMax as default } from 'framer-motion'
