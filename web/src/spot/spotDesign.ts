// Presentation settings per spot, in ONE place.
// The forecast and the score still use the Supabase `spots` row (beach_orientation,
// swell_window_min/max). The values below only drive what the new design DRAWS (wind rose,
// hero photo, names). They are copied from the database on 2026-11-26.
//
// `facing` and `swellWindow` match the database values I confirmed on 2026-11-25 (step 32).
// `confirmed: false` shows a "to confirm" note under the wind drawing.
// Photo: web/public/photos/<slug>.jpg, 1600x1200, + thumbs/<slug>.jpg 640x480, no EXIF (made from
// the originals in designs/).
// Use a NEW file name when replacing a photo: phones keep the old one cached otherwise.
// Missing file = flat block with a TODO.

export interface SpotDesign {
  slug: string
  /** Short name for the switcher and the hero. */
  name: string
  municipality: string
  /** Beach name under the title. */
  beach: string
  /** Degrees the beach faces, towards the sea (0 = N, 90 = E). */
  facing: number
  /** Swell window, clockwise, degrees the swell comes FROM. */
  swellWindow: { from: number; to: number }
  /** false = still "to confirm" (shown in the wind rose caption). */
  confirmed: boolean
  /** Path under web/public. null = no photo yet. */
  photo: string | null
  /** 640x480 copy for phones and the home page cards. */
  thumb?: string | null
  /** Where the photo came from (shown nowhere; for you). */
  photoNote?: string
}

export const SPOT_DESIGN: SpotDesign[] = [
  {
    slug: 'vilanova',
    name: 'Vilanova',
    municipality: 'Vilanova i la Geltrú',
    beach: 'Platja de Ribes Roges',
    facing: 165,
    swellWindow: { from: 105, to: 240 },
    confirmed: true,
    photo: '/photos/vilanova.jpg',
    thumb: '/photos/thumbs/vilanova.jpg',
    photoNote: 'designs/vilanovaimg.jpg',
  },
  {
    slug: 'sitges',
    name: 'Sitges',
    municipality: 'Sitges',
    beach: 'Platja de Sitges',
    facing: 170,
    swellWindow: { from: 100, to: 240 },
    confirmed: true,
    photo: '/photos/sitges.jpg',
    thumb: '/photos/thumbs/sitges.jpg',
    photoNote: 'designs/garrafimg.jpg (Garraf village and marina, used for Sitges)',
  },
  {
    slug: 'castelldefels',
    name: 'Castelldefels',
    municipality: 'Castelldefels',
    beach: 'Platja de Castelldefels',
    facing: 180,
    swellWindow: { from: 90, to: 250 },
    confirmed: true,
    photo: '/photos/castelldefels.jpg',
    thumb: '/photos/thumbs/castelldefels.jpg',
    photoNote: 'designs/castelldefels.jpg',
  },
  {
    slug: 'barceloneta',
    name: 'Barceloneta',
    municipality: 'Barcelona',
    beach: 'Platja de la Barceloneta',
    facing: 135,
    swellWindow: { from: 55, to: 190 },
    confirmed: true,
    photo: '/photos/barceloneta.jpg',
    thumb: '/photos/thumbs/barceloneta.jpg',
    photoNote: 'designs/bcnimg.jpg',
  },
  {
    slug: 'bogatell',
    name: 'Bogatell',
    municipality: 'Barcelona',
    beach: 'Platja del Bogatell',
    facing: 135,
    swellWindow: { from: 55, to: 200 },
    confirmed: true,
    photo: '/photos/bogatell.jpg',
    thumb: '/photos/thumbs/bogatell.jpg',
    photoNote: 'designs/bogatellimg.jpg',
  },
]

export const designFor = (slug: string): SpotDesign | undefined => SPOT_DESIGN.find((s) => s.slug === slug)
