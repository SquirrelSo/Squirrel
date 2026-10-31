/** Date formatting shared by the campus screens (events, meetups, invites). */
export const formatEventDate = (iso: string) => {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
};
