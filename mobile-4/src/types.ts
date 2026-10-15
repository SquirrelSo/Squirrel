/** Domain types shared by data, state, art and screens. Shaped so a real API can drop in later. */

export type HairStyle = 'bun' | 'long' | 'ponytail' | 'short' | 'curly' | 'buzz' | 'afro' | 'bob';
export type TopStyle = 'hoodie' | 'tee' | 'crop' | 'tank' | 'jacket';
export type BottomStyle = 'joggers' | 'shorts' | 'leggings';
export type AccessoryStyle = 'none' | 'shades' | 'cap' | 'headphones' | 'headband';
export type BodyType = 'female' | 'male';

export type AvatarLook = {
  body: BodyType;
  skin: string;
  hair: HairStyle;
  hairColor: string;
  top: TopStyle;
  topColor: string;
  bottom: BottomStyle;
  bottomColor: string;
  shoeColor: string;
  accessory: AccessoryStyle;
};

export type CharacterPose = 'stand' | 'run' | 'wave' | 'lift' | 'yoga' | 'flex';

export type MascotPose = 'idle' | 'run' | 'celebrate' | 'drink' | 'lift' | 'sit' | 'cheer' | 'sleep' | 'wave';
export type MascotAccessory = 'none' | 'sunglasses' | 'crown' | 'headband' | 'headphones';

export type SceneKind =
  | 'city-sunset'
  | 'city-night'
  | 'city-dawn'
  | 'run'
  | 'yoga'
  | 'cafe'
  | 'brunch'
  | 'crew'
  | 'hiit'
  | 'cycling'
  | 'lake'
  | 'rooftop'
  | 'stadium';

export type ProductKind =
  | 'hoodie'
  | 'tee'
  | 'tank'
  | 'jacket'
  | 'joggers'
  | 'shorts'
  | 'shoes'
  | 'hightops'
  | 'cap'
  | 'beanie'
  | 'headband'
  | 'bag'
  | 'backpack'
  | 'bottle'
  | 'sunglasses'
  | 'watch'
  | 'earbuds'
  | 'socks'
  | 'gloves'
  | 'mat'
  // Gear (avatar customization — dumbbell, kettlebell, jump rope, ball sports, racket)
  | 'dumbbell'
  | 'kettlebell'
  | 'jumprope'
  | 'resistanceband'
  | 'basketball'
  | 'football'
  | 'tennisracket'
  // Extra jewelry-style accessories
  | 'chain'
  | 'wristband';

export type BadgeKind =
  | 'city'
  | 'streak'
  | 'early-bird'
  | 'steps-10k'
  | 'crew'
  | 'first-run'
  | 'hydration'
  | 'yoga'
  | 'lifter'
  | 'explorer'
  | 'social'
  | 'half-marathon'
  | 'night-owl'
  | 'park-regular'
  | 'founding-squirrel';

export type StickerKind = 'no-days-off' | 'squirrel-flex' | 'neon-heart' | 'crown' | 'fire' | 'good-vibes' | 'one-more-km' | 'hydrate';

