import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * API base URL.
 * - EXPO_PUBLIC_API_URL wins (set it for staging/production builds).
 * - In development, reuse the Metro host's LAN IP so a phone running Expo Go reaches the API on :4000.
 */
function resolveApiUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  if (Platform.OS === 'web') return 'http://localhost:4000';
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (host) return `http://${host}:4000`;
  return Platform.OS === 'android' ? 'http://10.191.157.79:4000' : 'http://localhost:4000';
}

export const API_URL = resolveApiUrl();
