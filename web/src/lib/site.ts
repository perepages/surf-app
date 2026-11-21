// The app's public address. Used at build time for the link-preview tags in index.html and by
// scripts/share-kit.mjs for the QR code. Change it here if the domain changes, then run
// `npm run share-kit` again and reprint the poster.
export const SITE_URL = 'https://surfwithai.vercel.app'

/** Short link on posters and in shared messages: opens the app with the rating form up. */
export const RATE_URL = `${SITE_URL}/rate`

// Shown when a link to the app is shared (WhatsApp, Instagram, Telegram, X, iMessage...).
export const SHARE_TITLE = 'Vilanova Surf: is it worth paddling out?'
export const SHARE_DESCRIPTION =
  'Surf forecast for Platja de Vilanova i la Geltrú: a 1-5 score for every hour. Rate the waves after you surf and help train a better forecast.'
