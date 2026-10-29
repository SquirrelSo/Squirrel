# Assets

All artwork is original and made for Squirrel Social: neon nightlife over a sunset city.

**The app renders its art from code**, in the vector components in `src/art/` (react-native-svg). They stay crisp at any size, can be animated (mascot idle bob, route drawing), and take props: every avatar is built from an `AvatarLook`, and products take colours.

The PNGs here are **exports of those same components**, for the app icon and splash, store listings, marketing and a future backend or web CMS.

| Path | Contents |
|---|---|
| `brand/app-icon-source.png` | **The official app logo & icon** (peeking squirrel in the lime frame), 1254², as supplied. Every icon below is generated from it |
| `brand/logo.png` | In-app logo (Wordmark on the title and sign-in screens), 512² |
| `icon.png` | App icon, 1024² (the official logo, full frame) |
| `adaptive-icon.png` | Android adaptive-icon foreground, 1024²: the art inside the frame, scaled to the circular safe zone; background `#0C0C0C` in app.json |
| `splash-icon.png` | Splash: the official logo, 1024², on `#0C0C0C` (matches the logo's background) |
| `favicon.png` | Web favicon, 48² (the official logo) |
| `illustrations/mascot/` | Squirrel mascot poses: idle, run, celebrate, drink, lift, sit, cheer, sleep, wave; plus idle with crown, headband, headphones and no accessory |
| `illustrations/characters/` | Female and male fitness avatars in 6 poses (stand, run, wave, lift, yoga, flex) |
| `illustrations/avatars/` | Portraits of every demo user |
| `illustrations/scenes/` | 13 scenes: city sunset, night and dawn; run, yoga, cafe, brunch, crew, hiit, cycling, lake, rooftop, stadium |
| `illustrations/products/` | 20 shop items (hoodie, tee, tank, jacket, joggers, shorts, shoes, hightops, cap, beanie, headband, bag, backpack, bottle, sunglasses, watch, earbuds, socks, gloves, mat) |
| `illustrations/badges/` | 12 achievement badges |
| `illustrations/stickers/` | 8 die-cut stickers |
| `illustrations/rewards/` | Level-up reward art: outfit, badge, sticker pack, neon trail, coins, chest |
| `illustrations/map/` | Stylised city map with a run route |

Scenes and illustrations are exported at 2× (e.g. mascot 800², scenes 800×1000).

To regenerate them after changing the art, render the components on a temporary web route and screenshot each one with Playwright (`omitBackground: true`).
