import { CampusProfileView } from '@/components/campus/CampusProfile';

/**
 * Your profile: the campus profile from the backend. Without one it says so ("Not live yet" /
 * sign in) and keeps your settings (theme, avatar, coach profile, sign in/out) below.
 */
export default function Profile() {
  return <CampusProfileView isMe />;
}
