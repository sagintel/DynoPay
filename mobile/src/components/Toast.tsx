import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInUp, FadeOutUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, shadow } from '@/theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

type Toast = { id: number; text: string; tone: 'success' | 'error' | 'info' };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useSafeAreaInsets();
  const show = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ id: Date.now(), text, tone });
    timer.current = setTimeout(() => setToast(null), 3200);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast ? (
        <Animated.View key={toast.id} entering={FadeInUp.springify().damping(18)} exiting={FadeOutUp} pointerEvents="none" style={[styles.wrap, { top: insets.top + 8 }]}>
          <View style={[styles.toast, shadow]}>
            <Icon name={toast.tone === 'success' ? 'check' : toast.tone === 'error' ? 'warning' : 'info'} size={16} color={toast.tone === 'error' ? colors.negative : colors.accent} />
            <Text variant="label" style={{ flexShrink: 1 }}>
              {toast.text}
            </Text>
          </View>
        </Animated.View>
      ) : null}
    </ToastCtx.Provider>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 16, right: 16, alignItems: 'center' },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.surfaceHigh,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: 16,
    paddingVertical: 10,
    maxWidth: 480,
  },
});
