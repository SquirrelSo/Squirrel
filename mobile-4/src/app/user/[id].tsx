import { useLocalSearchParams } from 'expo-router';
import { CampusProfileView } from '@/components/campus/CampusProfile';
import { useMe } from '@/hooks/useCampus';

/** Someone's profile, from the campus backend (or its "Not live yet" / sign-in state). */
export default function UserProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const campusMe = useMe();
  return <CampusProfileView userId={id} isMe={id === 'me' || id === campusMe.data?.user_id} />;
}
