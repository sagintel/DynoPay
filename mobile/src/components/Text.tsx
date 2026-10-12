import { Children } from 'react';
import { Text as RNText, StyleSheet, type TextProps } from 'react-native';
import { useI18n } from '@/i18n/context';
import { colors, type } from '@/theme/tokens';

type Variant = keyof typeof type;

/**
 * The app's text. String children that are app strings are shown in the user's language
 * (exact matches only: names, notes and amounts from data are never changed).
 */
export function Text({ variant = 'body', color = colors.text, style, children, ...rest }: TextProps & { variant?: Variant; color?: string }) {
  const { lookup, rtl } = useI18n();
  const translated =
    typeof children === 'string'
      ? lookup(children)
      : Array.isArray(children)
        ? Children.map(children, (c) => (typeof c === 'string' && /[A-Za-z]{2}/.test(c) ? lookup(c) : c))
        : children;
  let align = null;
  if (rtl) {
    const a = StyleSheet.flatten(style)?.textAlign;
    align = { writingDirection: 'rtl' as const, textAlign: a === 'left' || !a ? ('right' as const) : a === 'right' ? ('left' as const) : a };
  }
  return (
    <RNText {...rest} style={[type[variant], { color }, style, align]}>
      {translated}
    </RNText>
  );
}
