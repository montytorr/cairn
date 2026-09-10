import { IBM_Plex_Mono, IBM_Plex_Sans, Instrument_Serif } from 'next/font/google'

/**
 * Self-hosted by next/font, so there is no CDN request and no layout shift.
 *
 * The pairing is deliberate. Instrument Serif is high-contrast and a little
 * odd — it gives the product a voice in the two or three places a voice
 * belongs, and nowhere else. Plex Sans carries every dense surface: it was
 * drawn for technical material and stays legible at 12px, which is most of
 * this interface. Plex Mono ties task refs and figures together so they read
 * as identifiers rather than prose.
 *
 * Explicitly not a system stack, and explicitly not Inter.
 */
export const display = Instrument_Serif({
  weight: '400',
  style: ['normal', 'italic'],
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
})

export const sans = IBM_Plex_Sans({
  weight: ['400', '500', '600'],
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
})

export const mono = IBM_Plex_Mono({
  weight: ['400', '500'],
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
})
