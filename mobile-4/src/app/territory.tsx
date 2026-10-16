import { Redirect } from 'expo-router';

/** Territory lives on the campus map (Map tab); old links land there. */
export default function Territory() {
  return <Redirect href="/explore" />;
}
