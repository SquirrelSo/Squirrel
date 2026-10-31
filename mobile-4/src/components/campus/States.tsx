import { ActivityIndicator, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { Mascot } from '@/art/Mascot';
import { CAMPUS_SOURCE, CAPABILITY_LABEL, errorKind, errorText, featureUnavailable, isEndpointUnavailable } from '@/api/campus';
import { Button, Card, Display, Icon } from '@/components/ui';
import { alpha, colors, fonts, radius } from '@/theme';

/** Skeleton rows while a list loads (keeps layout stable, no spinner jump). */
export function LoadingRows({ rows = 3, height = 64, style }: { rows?: number; height?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ gap: 10 }, style]} accessibilityLabel="Loading" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} style={[styles.skeleton, { height, opacity: 1 - i * 0.18 }]} />
      ))}
    </View>
  );
}

export function LoadingInline({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.inline}>
      <ActivityIndicator color={colors.primary} />
      <Text style={styles.inlineText}>{label}</Text>
    </View>
  );
}

/**
 * The right error UI for the failure: offline → retry, 401 → sign in, not live yet →
 * launch message, anything else → message + retry. Never swallows the error silently.
 */
/**
 * `feature`: names the feature for the per-endpoint "Not live yet" state — an endpoint whose
 * backend isn't built (EndpointUnavailableError) or isn't deployed (404 no_route / 501). Only that
 * feature is affected; there's no retry, because retrying can't make it exist.
 */
export function ErrorState({ cause, onRetry, compact, title, feature }: { cause: unknown; onRetry?: () => void; compact?: boolean; title?: string; feature?: string }) {
  const kind = errorKind(cause);
  const text = errorText(cause);
  if (isEndpointUnavailable(cause) || (kind !== 'not_live' && featureUnavailable(cause))) {
    const name = feature ?? (isEndpointUnavailable(cause) ? CAPABILITY_LABEL[cause.capability] : null);
    return <NotLiveYet name={name} compact={compact} />;
  }
  if (kind === 'not_live') {
    return (
      <Card style={[styles.box, compact && { paddingVertical: 14 }]}>
        {!compact && <Mascot pose="sleep" size={110} />}
        <Display size={compact ? 18 : 22} style={{ textAlign: 'center', marginTop: compact ? 0 : 6 }}>Not live yet</Display>
        <Text style={styles.body}>This part of Squirrel Social switches on when the campus backend goes live.</Text>
      </Card>
    );
  }
  const icon = kind === 'offline' ? 'wifi-off' : kind === 'unauthorized' ? 'account-lock-outline' : kind === 'forbidden' ? 'lock-outline' : 'alert-circle-outline';
  return (
    <Card style={[styles.box, compact && { paddingVertical: 14 }]}>
      <Icon name={icon} size={compact ? 22 : 30} color={kind === 'offline' ? colors.gold : colors.coral} />
      <Text style={styles.title}>{title ?? (kind === 'offline' ? 'No connection' : kind === 'unauthorized' ? 'Signed out' : kind === 'not_found' ? 'Not found' : 'Couldn’t load this')}</Text>
      <Text style={styles.body}>{text}</Text>
      {kind === 'unauthorized' ? (
        <Button label="Sign in" size="sm" onPress={() => router.push('/sign-in')} style={styles.btn} />
      ) : onRetry && kind !== 'forbidden' && kind !== 'not_found' ? (
        <Button label="Try again" size="sm" variant="secondary" iconLeft="refresh" onPress={onRetry} style={styles.btn} />
      ) : null}
    </Card>
  );
}

/** "<Feature> · Not live yet" — the unavailable state. Not an error, not empty, not fake data. */
export function NotLiveYet({ name, compact, body }: { name?: string | null; compact?: boolean; body?: string }) {
  return (
    <Card style={[styles.box, compact && { paddingVertical: 14 }]}>
      <Icon name="progress-wrench" size={compact ? 22 : 28} color={colors.violet} />
      {name ? <Text style={styles.soonName}>{name}</Text> : null}
      <Text style={styles.soon}>Not live yet</Text>
      <Text style={styles.body}>{body ?? 'Coming soon — this lights up as soon as its backend is ready. Everything else works as normal.'}</Text>
    </Card>
  );
}

export function NotConnected({ name, reason, body, compact }: { name: string; reason: 'not_configured' | 'signed_out'; body?: string; compact?: boolean }) {
  const signedOut = reason === 'signed_out';
  return (
    <Card style={[styles.box, compact && { paddingVertical: 14 }]}>
      <Icon name={signedOut ? 'account-lock-outline' : 'lan-disconnect'} size={compact ? 22 : 28} color={colors.blue} />
      <Text style={styles.soonName}>{name}</Text>
      <Text style={[styles.soon, { color: colors.blue, borderColor: alpha(colors.blue, 0.5) }]}>{signedOut ? 'Sign in to see this' : 'Not connected'}</Text>
      <Text style={styles.body}>{body ?? (signedOut ? 'This comes from your account. Sign in and it shows up here.' : 'This build isn’t connected to the server that provides it yet.')}</Text>
      {signedOut && <Button label="Sign in" size="sm" onPress={() => router.push('/sign-in')} style={styles.btn} />}
    </Card>
  );
}

/** For screens that need an account: explains and links to sign-in. */
export function SignedOutState({ what }: { what: string }) {
  return (
    <Card style={styles.box}>
      <Mascot pose="wave" size={100} />
      <Text style={styles.title}>Sign in to see {what}</Text>
      <Text style={styles.body}>Use your .ac.in email — Squirrel Social is campus-only.</Text>
      <Button label="Sign in" size="sm" onPress={() => router.push('/sign-in')} style={styles.btn} />
    </Card>
  );
}

export function EmptyNote({ icon = 'emoticon-cool-outline', title, body, action, onAction }: { icon?: React.ComponentProps<typeof Icon>['name']; title: string; body?: string; action?: string; onAction?: () => void }) {
  return (
    <Card style={styles.box}>
      <Icon name={icon} size={28} color={colors.dim} />
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {action && onAction ? <Button label={action} size="sm" variant="secondary" onPress={onAction} style={styles.btn} /> : null}
    </Card>
  );
}

/** Marked screens backed by the (now removed) development mock. Renders nothing: kept so the 20 screens using it needn't change. */
export function SourceBadge({ style }: { style?: StyleProp<ViewStyle> }) {
  if (CAMPUS_SOURCE !== 'mock') return null;
  return (
    <View style={[styles.dev, style]} accessibilityLabel="Development data">
      <Icon name="flask-outline" size={11} color={colors.gold} />
      <Text style={styles.devText}>Dev data</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  skeleton: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 14, justifyContent: 'center' },
  inlineText: { color: colors.dim, fontFamily: fonts.mono, fontSize: 12 },
  box: { alignItems: 'center', gap: 6, paddingVertical: 22 },
  title: { color: colors.text, fontFamily: fonts.label, fontSize: 17, letterSpacing: 0.8, textTransform: 'uppercase', textAlign: 'center' },
  body: { color: colors.dim, fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, textAlign: 'center', maxWidth: 320 },
  soonName: { color: colors.text, fontFamily: fonts.label, fontSize: 17, letterSpacing: 0.8, textTransform: 'uppercase', textAlign: 'center' },
  soon: { color: colors.violet, fontFamily: fonts.labelBold, fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase', borderWidth: 1, borderColor: alpha(colors.violet, 0.5), borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 2, overflow: 'hidden' },
  btn: { marginTop: 8, alignSelf: 'center', minWidth: 150 },
  dev: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', borderWidth: 1, borderColor: alpha(colors.gold, 0.5), borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  devText: { color: colors.gold, fontFamily: fonts.label, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' },
});
