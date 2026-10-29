import { View } from 'react-native';
import { Redirect } from 'expo-router';
import { useAuth } from '@/auth/AuthProvider';
import { takeThemeReturn } from '@/components/ThemeToggle';
import { colors } from '@/theme';

// Signed-in users (a stored backend token) go straight to Home; everyone else sees Welcome.
export default function Index() {
  const { mode } = useAuth();
  if (mode === 'loading') return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  if (mode === 'live' || mode === 'demo') {
    // After a theme switch reload, go back to where the switch was made.
    const back = takeThemeReturn();
    return <Redirect href={(back ?? '/home') as '/home'} />;
  }
  return <Redirect href="/welcome" />;
}
