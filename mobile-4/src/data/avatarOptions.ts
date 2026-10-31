import type { AccessoryStyle, AvatarLook, BottomStyle, HairStyle, TopStyle } from '@/types';
import { hairColors, skinTones } from '@/art/palette';
import type { IconName } from '@/data/icons';

/**
 * The avatar look editor's options: styles and colours for your own illustrated avatar. These are
 * editor choices, not content. There's no shop, currency or unlockable items (no backend for them).
 */
export type AvatarCategory = 'Body' | 'Hair' | 'Outfit' | 'Shoes' | 'Accessories' | 'Emotes';

export const avatarCategories: { id: AvatarCategory; icon: IconName }[] = [
  { id: 'Body', icon: 'face-woman-shimmer' },
  { id: 'Hair', icon: 'hair-dryer' },
  { id: 'Outfit', icon: 'tshirt-crew' },
  { id: 'Shoes', icon: 'shoe-sneaker' },
  { id: 'Accessories', icon: 'sunglasses' },
  { id: 'Emotes', icon: 'emoticon-happy' },
];

export const hairStyles: HairStyle[] = ['bun', 'ponytail', 'long', 'bob', 'curly', 'afro', 'short', 'buzz'];
export const topStyles: TopStyle[] = ['crop', 'hoodie', 'tee', 'tank', 'jacket'];
export const bottomStyles: BottomStyle[] = ['joggers', 'leggings', 'shorts'];
export const accessoryStyles: AccessoryStyle[] = ['none', 'shades', 'cap', 'headband', 'headphones'];
export const outfitColors = ['#16101E', '#D7FF1F', '#A855F7', '#FFFFFF', '#5FB8FF', '#FF2D9B', '#3DF0A0', '#FFD21F'];
export const shoeColors = ['#FFFFFF', '#D7FF1F', '#FFFFFF', '#16101E', '#FFD21F', '#A855F7'];
export { hairColors, skinTones };

export const emotes: { id: string; label: string; pose: 'wave' | 'flex' | 'run' | 'yoga' | 'lift' | 'stand' }[] = [
  { id: 'e-wave', label: 'Wave', pose: 'wave' },
  { id: 'e-flex', label: 'Flex', pose: 'flex' },
  { id: 'e-run', label: 'Sprint', pose: 'run' },
  { id: 'e-yoga', label: 'Tree', pose: 'yoga' },
  { id: 'e-lift', label: 'Lift', pose: 'lift' },
  { id: 'e-stand', label: 'Chill', pose: 'stand' },
];

/** Starter presets shown as the thumbnail row. */
export const presetLooks: AvatarLook[] = [
  { body: 'female', skin: skinTones[2], hair: 'bun', hairColor: hairColors[0], top: 'crop', topColor: '#16101E', bottom: 'joggers', bottomColor: '#1B1524', shoeColor: '#FFFFFF', accessory: 'none' },
  { body: 'female', skin: skinTones[0], hair: 'ponytail', hairColor: hairColors[3], top: 'tank', topColor: '#D7FF1F', bottom: 'leggings', bottomColor: '#16101E', shoeColor: '#FFFFFF', accessory: 'headband' },
  { body: 'female', skin: skinTones[4], hair: 'afro', hairColor: hairColors[0], top: 'hoodie', topColor: '#A855F7', bottom: 'shorts', bottomColor: '#16101E', shoeColor: '#FFFFFF', accessory: 'none' },
  { body: 'male', skin: skinTones[3], hair: 'short', hairColor: hairColors[0], top: 'tee', topColor: '#FFFFFF', bottom: 'shorts', bottomColor: '#16101E', shoeColor: '#FFFFFF', accessory: 'none' },
  { body: 'male', skin: skinTones[1], hair: 'curly', hairColor: hairColors[1], top: 'jacket', topColor: '#FF2D9B', bottom: 'joggers', bottomColor: '#1B1524', shoeColor: '#D7FF1F', accessory: 'shades' },
  { body: 'male', skin: skinTones[5], hair: 'buzz', hairColor: hairColors[0], top: 'hoodie', topColor: '#D7FF1F', bottom: 'joggers', bottomColor: '#16101E', shoeColor: '#FFFFFF', accessory: 'headphones' },
];

