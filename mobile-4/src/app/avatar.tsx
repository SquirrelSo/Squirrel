import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Character, Portrait, demoLooks } from '@/art/Character';
import { ProductArt } from '@/art/Product';
import { Button, FadeIn, Icon, IconButton, Label, Tagline, tap } from '@/components/ui';
import {
  accessoryStyles,
  avatarCategories,
  bottomStyles,
  emotes,
  hairColors,
  hairStyles,
  outfitColors,
  shoeColors,
  skinTones,
  topStyles,
  type AvatarCategory,
} from '@/data/avatarOptions';
import { useApp } from '@/state/AppState';
import type { AvatarLook, CharacterPose, ProductKind } from '@/types';
import { alpha, colors, fonts, MAX_WIDTH, radius } from '@/theme';

const topProduct: Record<AvatarLook['top'], ProductKind> = { hoodie: 'hoodie', tee: 'tee', crop: 'tank', tank: 'tank', jacket: 'jacket' };
const accProduct: Record<AvatarLook['accessory'], ProductKind | null> = { none: null, shades: 'sunglasses', cap: 'cap', headband: 'headband', headphones: 'earbuds' };

/** MAKE IT YOU — your own avatar look (styles and colours). No shop, coins or unlocks. */
export default function AvatarScreen() {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { look, setLook, toast } = useApp();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const editing = from === 'profile';
  const [cat, setCat] = useState<AvatarCategory>('Outfit');
  const [pose, setPose] = useState<CharacterPose>('stand');
  const set = (patch: Partial<AvatarLook>) => {
    tap();
    setLook({ ...look, ...patch });
  };
  // Stage takes whatever the header, option panel (~150) and CTA (~90) leave.
  const stageH = Math.max(250, Math.min(height - insets.top - insets.bottom - 330, 520));

  const selectedCharIndex = demoLooks.findIndex(
    (l) => l.body === look.body && l.skin === look.skin && l.hair === look.hair && l.top === look.top && l.topColor === look.topColor,
  );

  return (
    <View style={styles.root}>
      <LinearGradient colors={[colors.cardHi, colors.card, colors.bg]} style={StyleSheet.absoluteFill} />
      <View style={[styles.col, { paddingTop: insets.top + 6 }]}>
        <View style={styles.header}>
          <IconButton icon="chevron-left" size={28} onPress={() => (router.canGoBack() ? router.back() : router.replace('/welcome'))} label="Back" />
          <View style={{ alignItems: 'center', flex: 1 }}>
            <Tagline size={34} rotate={-4}>Make it You</Tagline>
            <Text style={styles.sub}>Choose your avatar & style</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {!editing && (
              <Pressable onPress={() => router.replace('/home')} accessibilityLabel="Skip">
                <Text style={styles.skip}>Skip</Text>
              </Pressable>
            )}
            <IconButton
              icon="dice-5-outline"
              label="Randomise"
              onPress={() => {
                const r = <T,>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];
                set({ skin: r(skinTones), hair: r(hairStyles), hairColor: r(hairColors), top: r(topStyles), topColor: r(outfitColors), bottom: r(bottomStyles), shoeColor: r(shoeColors), accessory: r(accessoryStyles) });
              }}
            />
          </View>
        </View>

        {/* Stage */}
        <View style={[styles.stage, { height: stageH }]}>
          <ScrollView style={styles.presetCol} contentContainerStyle={{ gap: 10, paddingVertical: 6 }} showsVerticalScrollIndicator={false}>
            {demoLooks.map((p, i) => {
              const on = i === selectedCharIndex;
              return (
                <Pressable key={i} onPress={() => set(p)} accessibilityLabel={`Starting look ${i + 1}`}>
                  <Portrait look={p} size={50} ring={on ? colors.primary : colors.lineHi} />
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
            <View style={styles.spot} />
            <View style={styles.platform} />
            <FadeIn key={pose} from={6}>
              <Character look={look} pose={pose} height={stageH * 0.92} />
            </FadeIn>
          </View>

          <ScrollView style={styles.railCol} contentContainerStyle={{ gap: 8, paddingVertical: 6 }} showsVerticalScrollIndicator={false}>
            {avatarCategories.map((c) => {
              const on = cat === c.id;
              return (
                <Pressable key={c.id} onPress={() => { tap(); setCat(c.id); }} style={[styles.rail, on && styles.railOn]} accessibilityLabel={c.id}>
                  <Icon name={c.icon} size={21} color={on ? colors.primary : colors.text} />
                  <Text style={[styles.railText, on && { color: colors.primary }]} numberOfLines={1}>{c.id === 'Accessories' ? 'Extras' : c.id}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        {/* Options for the active category */}
        <View style={styles.panel}>
          <Label style={{ marginBottom: 8 }}>{cat}</Label>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: 10, paddingRight: 16, alignItems: 'center' }}>
            {cat === 'Body' && (
              <>
                {(['female', 'male'] as const).map((b) => (
                  <OptionCard key={b} on={look.body === b} onPress={() => set({ body: b })} label={b === 'female' ? 'Body A' : 'Body B'}>
                    <Portrait look={{ ...look, body: b }} size={52} ring={false} />
                  </OptionCard>
                ))}
                {skinTones.map((s) => <Swatch key={s} color={s} on={look.skin === s} onPress={() => set({ skin: s })} />)}
              </>
            )}
            {cat === 'Hair' && (
              <>
                {hairStyles.map((h) => (
                  <OptionCard key={h} on={look.hair === h} onPress={() => set({ hair: h })} label={h}>
                    <Portrait look={{ ...look, hair: h }} size={52} ring={false} />
                  </OptionCard>
                ))}
                {hairColors.map((c) => <Swatch key={c} color={c} on={look.hairColor === c} onPress={() => set({ hairColor: c })} />)}
              </>
            )}
            {cat === 'Outfit' && (
              <>
                {topStyles.map((t) => (
                  <OptionCard key={t} on={look.top === t} onPress={() => set({ top: t })} label={t}>
                    <ProductArt kind={topProduct[t]} color={look.topColor} size={56} />
                  </OptionCard>
                ))}
                {bottomStyles.map((b) => (
                  <OptionCard key={b} on={look.bottom === b} onPress={() => set({ bottom: b })} label={b}>
                    <ProductArt kind={b === 'shorts' ? 'shorts' : 'joggers'} color={look.bottomColor} size={56} />
                  </OptionCard>
                ))}
                {outfitColors.map((c) => <Swatch key={c} color={c} on={look.topColor === c} onPress={() => set({ topColor: c })} />)}
              </>
            )}
            {cat === 'Shoes' && (
              <>
                {shoeColors.map((c) => (
                  <OptionCard key={c} on={look.shoeColor === c} onPress={() => set({ shoeColor: c })} label="Runner">
                    <ProductArt kind="shoes" color={c} size={56} />
                  </OptionCard>
                ))}
              </>
            )}
            {cat === 'Accessories' && (
              <>
                {accessoryStyles.map((a) => (
                  <OptionCard key={a} on={look.accessory === a} onPress={() => set({ accessory: a })} label={a}>
                    {accProduct[a] ? <ProductArt kind={accProduct[a]!} size={56} /> : <Icon name="cancel" size={30} color={colors.dim} />}
                  </OptionCard>
                ))}
              </>
            )}
            {cat === 'Emotes' && emotes.map((e) => (
              <OptionCard key={e.id} on={pose === e.pose} onPress={() => { tap(); setPose(e.pose); }} label={e.label}>
                <Character look={look} pose={e.pose} height={62} />
              </OptionCard>
            ))}
          </ScrollView>
        </View>

        <View style={{ flex: 1 }} />
        <View style={{ paddingHorizontal: 16, paddingBottom: insets.bottom + 14 }}>
          <Button
            label={editing ? 'Save Look' : 'Continue'}
            icon={editing ? 'check' : 'arrow-right'}
            onPress={() => {
              if (editing) {
                toast('Look saved', 'check-circle', colors.green);
                router.back();
              } else router.replace('/home');
            }}
          />
        </View>
      </View>
    </View>
  );
}

function OptionCard({ children, on, onPress, label, locked }: { children: React.ReactNode; on: boolean; onPress: () => void; label: string; locked?: boolean }) {
  return (
    <Pressable onPress={onPress} style={[styles.opt, on && styles.optOn]} accessibilityLabel={label}>
      <View style={{ height: 62, alignItems: 'center', justifyContent: 'center' }}>{children}</View>
      <Text style={[styles.optText, on && { color: colors.primary }]} numberOfLines={1}>{label}</Text>
      {locked && <Icon name="lock" size={12} color={colors.dim} style={{ position: 'absolute', top: 6, right: 6 }} />}
    </Pressable>
  );
}

function Swatch({ color, on, onPress }: { color: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.swatchWrap, on && { borderColor: colors.primary }]} accessibilityLabel={`Colour ${color}`}>
      <View style={[styles.swatch, { backgroundColor: color }]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  col: { flex: 1, width: '100%', maxWidth: MAX_WIDTH, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  sub: { color: colors.sub, fontFamily: fonts.medium, marginTop: 2, fontSize: 13 },
  skip: { color: colors.sub, fontFamily: fonts.semibold, fontSize: 14 },
  stage: { flexDirection: 'row', paddingHorizontal: 12, marginTop: 8 },
  presetCol: { flexGrow: 0, width: 58 },
  railCol: { flexGrow: 0, width: 64 },
  spot: { position: 'absolute', bottom: 10, width: 230, height: 230, borderRadius: 115, backgroundColor: colors.purple, opacity: 0.22 },
  platform: { position: 'absolute', bottom: 0, width: 170, height: 26, borderRadius: 85, backgroundColor: alpha(colors.primary, 0.18), borderWidth: 1.5, borderColor: alpha(colors.primary, 0.5) },
  rail: { width: 62, height: 56, borderRadius: radius.md, backgroundColor: colors.glass, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center', gap: 2 },
  railOn: { borderColor: colors.primary, backgroundColor: alpha(colors.primary, 0.12) },
  railText: { color: colors.sub, fontSize: 10, fontFamily: fonts.semibold },
  panel: { marginTop: 14, paddingBottom: 14, paddingLeft: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.bg2 },
  opt: { width: 84, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.card, alignItems: 'center', paddingVertical: 8 },
  optOn: { borderColor: colors.primary, backgroundColor: alpha(colors.primary, 0.1) },
  optText: { color: colors.sub, fontFamily: fonts.semibold, fontSize: 11, marginTop: 4, textTransform: 'capitalize' },
  swatchWrap: { width: 46, height: 46, borderRadius: 23, borderWidth: 2, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  swatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)' },
});
