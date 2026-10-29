/** Short web invite link (/w/{code}) → the in-app join screen. */
import { Redirect, useLocalSearchParams } from 'expo-router';

export default function ShortInvite() {
  const { code } = useLocalSearchParams<{ code: string }>();
  return <Redirect href={{ pathname: '/workout/join/[code]', params: { code } }} />;
}
