import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCancelled, applyInvited, applyReps, canCancel, clock, inviteRefusal, inviteStatus, livePhase, myCompletedResult, partnerLeftMidRace, pendingInvites, raceResult, screenPhase, secondsUntil, sessionSocketUrl, startSessionLink, POLL_EVERY_MS } from './sharedWorkout.ts';

const T0 = Date.parse('2026-10-05T10:00:00.000Z');
const iso = (ms) => new Date(T0 + ms).toISOString();
const seat = (role, id, over = {}) => ({
  user: { user_id: id, display_name: id === 'u-host' ? 'Asha Rao' : 'Kabir Sen', avatar_url: null, hostel: null },
  role, ready: false, connected: true, reps: 0, seq: 0, finished_at: null, left_at: null, left_reason: null, ...over,
});
const session = (over = {}) => ({
  session_id: 's1', invite_code: 'H4KP9QRT', invite_url: 'https://x/w/H4KP9QRT', exercise: { key: 'pushup', name: 'Push-up' },
  duration_s: 180, phase: 'lobby', you: 'host', host: seat('host', 'u-host'), partner: null,
  created_at: iso(0), expires_at: iso(600_000), starts_at: null, ends_at: null, rep_source: 'hand_tapped', server_time: iso(0),
  ...over,
});
const racing = (over = {}) => session({ phase: 'racing', partner: seat('partner', 'u-p'), starts_at: iso(60_000), ends_at: iso(240_000), ...over });

test('lobby: waiting until someone joins, then ready-up; a host who left hands the lobby over', () => {
  assert.equal(screenPhase(session(), T0), 'waiting');
  assert.equal(screenPhase(session({ partner: seat('partner', 'u-p') }), T0), 'lobby');
  // The host left; the old partner now holds the host seat with nobody else in: invite again.
  const handedOver = session({ you: 'host', host: seat('host', 'u-p'), partner: null });
  assert.equal(screenPhase(handedOver, T0), 'waiting');
  // The one who left gets you: null back.
  assert.equal(screenPhase(session({ you: null }), T0), 'removed');
});

test('the phase ticks over locally at expires_at, starts_at and ends_at', () => {
  assert.equal(livePhase(session(), T0 + 600_000), 'expired');
  const cd = session({ phase: 'countdown', partner: seat('partner', 'u-p'), starts_at: iso(3_000), ends_at: iso(183_000) });
  assert.equal(livePhase(cd, T0 + 2_999), 'countdown');
  assert.equal(livePhase(cd, T0 + 3_000), 'racing');
  assert.equal(livePhase(cd, T0 + 183_000), 'finished');
  assert.equal(screenPhase(cd, T0 + 183_000), 'result');
});

test('during the race: your own finish or leave is yours alone; a partner leaving means keep going', () => {
  assert.equal(screenPhase(racing(), T0 + 100_000), 'racing');
  assert.equal(screenPhase(racing({ host: seat('host', 'u-host', { finished_at: iso(90_000) }) }), T0 + 100_000), 'you_finished');
  assert.equal(screenPhase(racing({ host: seat('host', 'u-host', { left_at: iso(90_000), left_reason: 'left' }) }), T0 + 100_000), 'you_left');
  const partnerGone = racing({ partner: seat('partner', 'u-p', { left_at: iso(90_000), left_reason: 'disconnected' }) });
  assert.equal(screenPhase(partnerGone, T0 + 100_000), 'racing');
  assert.equal(partnerLeftMidRace(partnerGone), true);
  assert.equal(partnerLeftMidRace(session({ partner: seat('partner', 'u-p', { left_at: iso(1) }) })), false);
});

test('finished without ever starting is "closed" (never says why)', () => {
  const closed = session({ phase: 'finished', partner: seat('partner', 'u-p', { left_reason: 'closed', left_at: iso(5) }), host: seat('host', 'u-host', { left_reason: 'closed', left_at: iso(5) }) });
  assert.equal(screenPhase(closed, T0 + 10), 'closed');
});

test('result: more reps wins; your tapped count is never undercut by a lagging server', () => {
  const done = racing({ phase: 'finished', host: seat('host', 'u-host', { reps: 40 }), partner: seat('partner', 'u-p', { reps: 38 }) });
  assert.deepEqual(raceResult(done), { mine: 40, theirs: 38, outcome: 'won' });
  assert.deepEqual(raceResult(done, 37), { mine: 40, theirs: 38, outcome: 'won' });
  assert.equal(raceResult(done, 38).outcome, 'won');
  assert.equal(raceResult({ ...done, you: 'partner' }).outcome, 'lost');
  assert.equal(raceResult(racing({ host: seat('host', 'u-host', { reps: 5 }), partner: seat('partner', 'u-p', { reps: 5 }) })).outcome, 'draw');
  assert.deepEqual(raceResult(session({ host: seat('host', 'u-host', { reps: 3 }) })), { mine: 3, theirs: null, outcome: 'solo' });
});

test('rep events keep only newer seqs, for the right person and session', () => {
  const s = racing({ partner: seat('partner', 'u-p', { reps: 10, seq: 12 }) });
  assert.equal(applyReps(s, { session_id: 's1', user_id: 'u-p', reps: 11, seq: 13, at: iso(1) }).partner.reps, 11);
  assert.equal(applyReps(s, { session_id: 's1', user_id: 'u-p', reps: 9, seq: 11, at: iso(1) }).partner.reps, 10);
  assert.equal(applyReps(s, { session_id: 'other', user_id: 'u-p', reps: 99, seq: 99, at: iso(1) }).partner.reps, 10);
  // Undo: a lower total with a higher seq wins.
  assert.equal(applyReps(s, { session_id: 's1', user_id: 'u-p', reps: 9, seq: 14, at: iso(1) }).partner.reps, 9);
});

const buddy = (id, status = 'invited') => ({ user: { user_id: id, display_name: 'Riya Das', avatar_url: null, hostel: null }, status, invited_at: iso(1) });

test('cancelled before the start is its own state, for the host and the partner alike', () => {
  const cancelled = session({ phase: 'finished', partner: seat('partner', 'u-p', { left_reason: 'cancelled', left_at: iso(5) }), host: seat('host', 'u-host', { left_reason: 'cancelled', left_at: iso(5) }) });
  assert.equal(screenPhase(cancelled, T0 + 10), 'cancelled');
  assert.equal(screenPhase({ ...cancelled, you: 'partner' }, T0 + 10), 'cancelled');
});

test('only the host cancels, and only in the lobby before the countdown', () => {
  assert.equal(canCancel(session(), T0), true);
  assert.equal(canCancel(session({ partner: seat('partner', 'u-p') }), T0), true);
  assert.equal(canCancel(session({ you: 'partner', partner: seat('partner', 'u-p') }), T0), false);
  assert.equal(canCancel(session(), T0 + 600_000), false); // expired
  assert.equal(canCancel(racing({ phase: 'countdown', starts_at: iso(3_000) }), T0), false);
});

test('workout.session.cancelled closes every seat that was still in, "cancelled"', () => {
  const s = session({ partner: seat('partner', 'u-p', { ready: true }) });
  const out = applyCancelled(s, { session_id: 's1', at: iso(9) });
  assert.equal(out.phase, 'finished');
  assert.deepEqual([out.host.left_reason, out.partner.left_reason, out.partner.ready, out.host.left_at], ['cancelled', 'cancelled', false, iso(9)]);
  assert.equal(screenPhase(out, T0 + 10), 'cancelled');
  assert.equal(applyCancelled(s, { session_id: 'other', at: iso(9) }), s);
  const started = racing();
  assert.equal(applyCancelled(started, { session_id: 's1', at: iso(9) }), started); // a race is never cancelled
});

test('invitations: added or updated by workout.session.invited, read per buddy, case-blind', () => {
  const s = session({ invites: [buddy('AAAA-1', 'declined')] });
  assert.equal(inviteStatus(s, 'aaaa-1'), 'declined');
  assert.equal(inviteStatus(s, 'bbbb-2'), null);
  assert.equal(inviteStatus(session(), 'bbbb-2'), null); // older servers send no invites at all
  const more = applyInvited(s, { session_id: 's1', invite: buddy('bbbb-2') });
  assert.equal(inviteStatus(more, 'BBBB-2'), 'invited');
  assert.equal(pendingInvites(more), 1);
  assert.equal(applyInvited(more, { session_id: 's1', invite: buddy('bbbb-2') }).invites.length, 2);
  assert.equal(applyInvited(s, { session_id: 'other', invite: buddy('cccc-3') }), s);
});

test('each invite refusal says what happened; anything else is the server\'s message', () => {
  assert.match(inviteRefusal('not_a_buddy', 'x'), /Partner Hunt connections/);
  assert.match(inviteRefusal('too_many_invites', 'x'), /Up to 3/);
  assert.equal(inviteRefusal('session_full', 'x'), 'Someone has already joined.');
  assert.equal(inviteRefusal('blocks_unreachable', 'Try again in a moment.'), 'Try again in a moment.');
});

test('the settled race: your own line, matched by your Social profile id; nothing when it isn\'t this race', () => {
  const done = racing({ phase: 'finished', you: 'partner' });
  const c = { session_id: 's1', completed_at: iso(240_000), results: [
    { user: done.host.user, reps: 12, finished: true, rewarded: true },
    { user: done.partner.user, reps: 0, finished: true, rewarded: false },
  ] };
  assert.equal(myCompletedResult(done, c).rewarded, false);
  assert.equal(myCompletedResult({ ...done, you: 'host' }, c).rewarded, true);
  assert.equal(myCompletedResult(done, { ...c, session_id: 'other' }), null);
  assert.equal(myCompletedResult(done, null), null);
});

test('timers and the socket address', () => {
  assert.equal(secondsUntil(iso(2_100), T0), 3);
  assert.equal(secondsUntil(iso(0), T0 + 5), 0);
  assert.equal(secondsUntil(null, T0), null);
  assert.equal(clock(125), '2:05');
  assert.equal(sessionSocketUrl('https://ex.example/', 's 1', 'a.b+c'), 'wss://ex.example/ws/workout-sessions/s%201?token=a.b%2Bc');
  assert.equal(sessionSocketUrl('http://localhost:8000', 's1', 't'), 'ws://localhost:8000/ws/workout-sessions/s1?token=t');
});

// ---- the live link: socket first, polling while it's down

function harness({ token = 'tok', refresh = async () => 'tok2', poll = async () => session() } = {}) {
  const timers = new Map();
  let nextId = 1;
  const sockets = [];
  const updates = [];
  const states = [];
  let currentToken = token;
  const deps = {
    openSocket: (url) => {
      const ws = { url, sent: [], onopen: null, onmessage: null, onclose: null, onerror: null, closed: false, send(d) { this.sent.push(d); }, close() { this.closed = true; } };
      sockets.push(ws);
      return ws;
    },
    socketUrl: (t) => `wss://x/ws/workout-sessions/s1?token=${t}`,
    getToken: () => currentToken,
    refreshToken: async () => { currentToken = await refresh(); return currentToken; },
    poll,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  };
  const fire = async (ms) => {
    for (const [id, t] of [...timers]) if (t.ms === ms) { timers.delete(id); await t.fn(); }
    await new Promise((r) => setImmediate(r));
  };
  const stop = startSessionLink(deps, (u) => updates.push(u), (s) => states.push(s));
  return { sockets, updates, states, timers, fire, stop };
}

test('socket up: messages flow, pings every 10 s, no polling', async () => {
  const h = harness();
  const ws = h.sockets[0];
  assert.match(ws.url, /token=tok$/);
  ws.onopen();
  assert.equal(h.states.at(-1), 'live');
  ws.onmessage({ data: JSON.stringify({ type: 'workout.session.updated', data: session({ phase: 'countdown' }) }) });
  ws.onmessage({ data: JSON.stringify({ type: 'workout.reps.updated', data: { session_id: 's1', user_id: 'u-p', reps: 3, seq: 4, at: iso(1) } }) });
  ws.onmessage({ data: JSON.stringify({ type: 'workout.session.invited', data: { session_id: 's1', invite: buddy('aaaa-1') } }) });
  ws.onmessage({ data: JSON.stringify({ type: 'workout.session.cancelled', data: { session_id: 's1', at: iso(1) } }) });
  ws.onmessage({ data: JSON.stringify({ type: 'workout.session.completed', data: { session_id: 's1', completed_at: iso(1), results: [] } }) });
  ws.onmessage({ data: JSON.stringify({ type: 'pong', data: { server_time: iso(1) } }) });
  ws.onmessage({ data: 'not json' });
  assert.deepEqual(h.updates.map((u) => u.kind), ['session', 'reps', 'invited', 'cancelled', 'completed']);
  await h.fire(10_000);
  assert.deepEqual(ws.sent, ['{"type":"ping"}']);
  assert.ok(![...h.timers.values()].some((t) => t.ms === POLL_EVERY_MS));
  h.stop();
  assert.equal(ws.closed, true);
});

test('socket drops: polls every 2 s and retries the socket; polling stops once it reconnects', async () => {
  let polls = 0;
  const h = harness({ poll: async () => { polls += 1; return session(); } });
  h.sockets[0].onopen();
  h.sockets[0].onclose({ code: 1006 });
  assert.equal(h.states.at(-1), 'trouble');
  await h.fire(POLL_EVERY_MS);
  assert.equal(polls, 1);
  assert.equal(h.states.at(-1), 'live');
  await h.fire(2_000); // poll again + the first socket retry
  assert.equal(h.sockets.length, 2);
  h.sockets[1].onopen();
  const before = polls;
  await h.fire(POLL_EVERY_MS);
  assert.equal(polls, before, 'no polling while the socket is up');
  h.stop();
});

test('4401: refresh the token once and reconnect with the new one; 1000 and 4404 stop for good', async () => {
  const h = harness();
  h.sockets[0].onclose({ code: 4401 });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.sockets.length, 2);
  assert.match(h.sockets[1].url, /token=tok2$/);
  h.sockets[1].onopen();
  h.sockets[1].onclose({ code: 1000 });
  assert.equal(h.states.at(-1), 'gone');
  assert.equal(h.timers.size, 0, 'nothing left running');

  const g = harness();
  g.sockets[0].onclose({ code: 4404 });
  assert.equal(g.states.at(-1), 'gone');
  assert.equal(g.timers.size, 0);
});

test('no token yet: poll (the API refreshes on 401) and try the socket later', async () => {
  let polls = 0;
  const h = harness({ token: null, poll: async () => { polls += 1; return session(); } });
  assert.equal(h.sockets.length, 0);
  await h.fire(POLL_EVERY_MS);
  assert.equal(polls, 1);
  h.stop();
  assert.equal(h.timers.size, 0);
});
