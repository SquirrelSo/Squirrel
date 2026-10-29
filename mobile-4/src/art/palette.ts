/**
 * Shared illustration palette. Every piece of art in src/art uses these so the
 * whole app reads as one visual universe: neon nightlife over a sunset city.
 */
export const art = {
  // night sky -> sunset
  night0: '#07050D',
  night1: '#10091A',
  night2: '#1C0C2E',
  dusk: '#3A0F4F',
  magenta: '#7A1466',
  coral: '#E8466E',
  orange: '#FF7A45',
  amber: '#FFB547',
  sunTop: '#FFE08A',
  sunBottom: '#FF4DC4',

  // neon
  pink: '#FF2D9B',
  lime: '#D7FF1F',
  pinkHi: '#FF7FD6',
  purple: '#8A3FFC',
  violet: '#B57BFF',
  cyan: '#35DFFF',
  yellow: '#FFD43B',
  green: '#3DF0A0',

  // buildings / silhouettes
  building0: '#12081E',
  building1: '#1A0C2A',
  building2: '#241238',
  silhouette: '#0A0512',

  // squirrel mascot
  fur: '#D9783A',
  furDark: '#A9521F',
  furLight: '#F2A15E',
  belly: '#FBE2BF',
  nose: '#3A1A12',

  // neutrals
  ink: '#0B0710',
  white: '#FFFFFF',
  cloud: '#F4ECF8',
  steel: '#8C8398',
};

export const skinTones = ['#F6D3B8', '#E8B48F', '#C98A5E', '#A0643A', '#6E4127', '#4A2A1A'] as const;
export const hairColors = ['#1A1116', '#3B2218', '#6B3A1F', '#B7773A', '#E5C07B', '#FF4DC4', '#8A3FFC'] as const;
