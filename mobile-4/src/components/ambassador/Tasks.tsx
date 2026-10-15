/**
 * Open ambassador tasks (GET /v1/ambassador/tasks) and my submission for each. Evidence is sent
 * once per task (POST …/{id}/submit); the team reviews it and the XP comes from the server.
 */
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { ambassadorApi, submitErrorText, type AmbassadorSubmission, type AmbassadorTask } from '@/api/ambassador';
import { errorCode, errorText } from '@/api/campus';
import { EmptyNote, ErrorState, LoadingRows } from '@/components/campus/States';
import { shortTime } from '@/components/campus/territoryUi';
import { Button, Card, Icon, Tag, tap } from '@/components/ui';
import { invalidateCampus, useCampus } from '@/hooks/useCampus';
import { colors, fonts, radius } from '@/theme';

const MAX_EVIDENCE = 1000;

const SUBMISSION: Record<AmbassadorSubmission['status'], { label: string; icon: React.ComponentProps<typeof Icon>['name']; color: string }> = {
  submitted: { label: 'In review', icon: 'progress-clock', color: colors.violet },
  approved: { label: 'Approved', icon: 'check-decagram', color: colors.primary },
  rejected: { label: 'Not approved', icon: 'close-circle-outline', color: colors.dim },
};

export function AmbassadorTasks({ suspended }: { suspended: boolean }) {
  const r = useCampus<{ items: AmbassadorTask[] }>('ambassador:tasks', () => ambassadorApi.tasks());
  if (r.error && !r.data) return <ErrorState cause={r.cause} onRetry={r.reload} compact feature="Ambassador tasks" />;
  if (!r.data) return <LoadingRows rows={2} height={84} />;
  if (!r.data.items.length) return <EmptyNote icon="clipboard-text-outline" title="No open tasks" body="New tasks land here, and in your notifications." />;
  const landed = (taskId: string, s: AmbassadorSubmission) => r.data && r.mutate({ items: r.data.items.map((t) => (t.id === taskId ? { ...t, submission: s } : t)) });
  return (
    <View style={{ gap: 10 }}>
      {r.data.items.map((t) => (
        <TaskCard key={t.id} task={t} suspended={suspended} onSubmitted={(s) => landed(t.id, s)} onStale={r.reload} />
      ))}
    </View>
  );
}

function TaskCard({ task, suspended, onSubmitted, onStale }: { task: AmbassadorTask; suspended: boolean; onSubmitted: (s: AmbassadorSubmission) => void; onStale: () => void }) {
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sub = task.submission ? SUBMISSION[task.submission.status] : null;

  const submit = async () => {
    if (!evidence.trim() || sending) return;
    tap('impact');
    setSending(true);
    setError(null);
    try {
      const s = await ambassadorApi.submit(task.id, evidence);
      tap('success');
      setOpen(false);
      onSubmitted(s);
    } catch (e) {
      setError(submitErrorText(e) ?? errorText(e));
      // Already in (another device), paused, or closed: the list and status are out of date.
      if (errorCode(e) === 'already_submitted' || errorCode(e) === 'not_found') onStale();
      if (errorCode(e) === 'forbidden') invalidateCampus('ambassador:me');
    } finally {
      setSending(false);
    }
  };

  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.title}>{task.title}</Text>
          {task.ends_at && <Text style={styles.meta}>Closes {shortTime(task.ends_at)}</Text>}
        </View>
        <Tag label={`+${task.xp_reward} XP`} icon="star-four-points" color={colors.gold} />
      </View>
      {!!task.description && <Text style={styles.body}>{task.description}</Text>}
      {sub && task.submission ? (
        <View style={styles.subRow} accessibilityLabel={`Your submission: ${sub.label}`}>
          <Icon name={sub.icon} size={16} color={sub.color} />
          <Text style={[styles.subText, { color: sub.color }]}>{sub.label}</Text>
          <Text style={styles.meta}>· sent {shortTime(task.submission.submitted_at)}</Text>
        </View>
      ) : suspended ? (
        <Text style={styles.meta}>Tasks open again when your role is back.</Text>
      ) : open ? (
        <View style={{ gap: 8 }}>
          <TextInput
            value={evidence}
            onChangeText={setEvidence}
            placeholder="A link, or what you did and where"
            placeholderTextColor={colors.mute}
            maxLength={MAX_EVIDENCE}
            multiline
            style={styles.input}
            accessibilityLabel={`Evidence for ${task.title}`}
          />
          <Text style={styles.count}>{evidence.length}/{MAX_EVIDENCE}</Text>
          {!!error && <Text style={styles.err} accessibilityLiveRegion="polite">{error}</Text>}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Button label={sending ? 'Sending…' : 'Send'} size="md" icon="arrow-right" disabled={sending || !evidence.trim()} onPress={submit} style={{ flex: 1 }} />
            <Button label="Cancel" size="md" variant="ghost" disabled={sending} onPress={() => setOpen(false)} />
          </View>
        </View>
      ) : (
        <Button label="Submit evidence" size="sm" variant="secondary" iconLeft="upload-outline" onPress={() => setOpen(true)} style={{ alignSelf: 'flex-start' }} />
      )}
      {!open && !!error && <Text style={styles.err}>{error}</Text>}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontFamily: fonts.bold, fontSize: 16 },
  meta: { color: colors.dim, fontFamily: fonts.regular, fontSize: 12 },
  body: { color: colors.sub, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  subText: { fontFamily: fonts.label, fontSize: 13, letterSpacing: 0.6, textTransform: 'uppercase' },
  input: { minHeight: 84, textAlignVertical: 'top', color: colors.text, fontFamily: fonts.regular, fontSize: 15, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, paddingHorizontal: 12, paddingVertical: 10 },
  count: { color: colors.mute, fontFamily: fonts.mono, fontSize: 11, alignSelf: 'flex-end' },
  err: { color: colors.coral, fontFamily: fonts.medium, fontSize: 13 },
});
