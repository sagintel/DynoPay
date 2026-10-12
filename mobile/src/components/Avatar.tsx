import { View } from 'react-native';
import { colors, fonts } from '@/theme/tokens';
import { Text } from './Text';

export function Avatar({ initials, size = 44, ring = false, solid = false }: { initials: string; size?: number; ring?: boolean; solid?: boolean }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: solid ? colors.ivory : colors.surface,
        borderWidth: ring ? 1.5 : 1,
        borderColor: ring ? colors.accent : colors.border,
      }}
    >
      <Text style={{ fontFamily: fonts.semibold, fontSize: size * 0.3, letterSpacing: 0.3 }} color={solid ? colors.onIvory : colors.text}>
        {initials}
      </Text>
    </View>
  );
}
