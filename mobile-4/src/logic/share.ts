import { Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { colors } from '@/theme';

export type ShareOrCopyOptions = {
  title?: string;
  message: string;
  url?: string | null;
  toast: (message: string, icon?: any, color?: string) => void;
  copyLabel?: string;
};

/**
 * Universal share or copy helper:
 * - On web: uses navigator.share if supported (e.g. mobile browsers, Safari). If unsupported,
 *   cancelled, or rejected, falls back to copying the URL/message to clipboard and showing a toast.
 * - On mobile: opens native Share sheet, with clipboard fallback.
 */
export async function shareOrCopy({
  title,
  message,
  url,
  toast,
  copyLabel = 'Invite link',
}: ShareOrCopyOptions): Promise<boolean> {
  const textToCopy = url || message;

  if (Platform.OS === 'web') {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({
          title,
          text: message,
          url: url || undefined,
        });
        return true;
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === 'AbortError') {
          // User closed the share sheet without picking a target
          return false;
        }
        // Other failures fall through to clipboard copy
      }
    }

    // Web fallback: clipboard copy
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(textToCopy);
      } else {
        await Clipboard.setStringAsync(textToCopy);
      }
      toast(`${copyLabel} copied`, 'content-copy', colors.primary);
      return true;
    } catch {
      toast('Couldn’t copy — try selecting the link', 'alert-circle-outline', colors.coral);
      return false;
    }
  }

  // Native mobile
  try {
    const payload = Platform.OS === 'ios' && url ? { message, url, title } : { message, title };
    await Share.share(payload);
    return true;
  } catch {
    try {
      await Clipboard.setStringAsync(textToCopy);
      toast(`${copyLabel} copied`, 'content-copy', colors.primary);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Direct clipboard copy helper with toast feedback for both web and mobile.
 */
export async function copyToClipboard(
  text: string,
  label: string,
  toast: (message: string, icon?: any, color?: string) => void,
): Promise<boolean> {
  try {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      await Clipboard.setStringAsync(text);
    }
    toast(`${label} copied`, 'content-copy', colors.primary);
    return true;
  } catch {
    toast('Couldn’t copy — try selecting the text', 'alert-circle-outline', colors.coral);
    return false;
  }
}
