import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { Text } from '@/components/Text';
import { fill, tr, setCurrentDict } from '@/i18n/context';
import { BUILT_IN } from '@/i18n/locales';
import { UI_STRINGS } from '@/i18n/strings.gen';
import { InLanguage } from './test-utils';

// Names, brands and sample data are never translated.
const KEEP = new Set(['Acme Studio', 'Sara Malik', 'Cloudflare', 'Gemini', 'Dyno', 'Client ID', 'English', 'Sandbox']);

describe('dictionaries', () => {
  it.each(['fr', 'sw', 'es', 'ar'])('%s translates every UI string of the app', (lang) => {
    const missing = UI_STRINGS.filter((s) => !KEEP.has(s) && !(s in BUILT_IN[lang]!));
    expect(missing).toEqual([]);
  });

  it.each(['fr', 'sw', 'es', 'ar'])('%s keeps every {placeholder}', (lang) => {
    for (const [en, translated] of Object.entries(BUILT_IN[lang]!)) {
      const holes = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect([en, holes(translated)]).toEqual([en, holes(en)]);
    }
  });

  it('fills placeholders and translates outside components', () => {
    expect(fill('Pay {x} ', { x: 'Sara' })).toBe('Pay Sara ');
    setCurrentDict(BUILT_IN.sw!);
    expect(tr('Keep as {x}', { x: tr('Home') })).toBe('Hifadhi kama Mwanzo');
    setCurrentDict({});
  });
});

describe('<Text>', () => {
  it('shows app strings in the user language but never changes data', async () => {
    const screen = await render(
      <InLanguage lang="fr">
        <Text>Hold to send</Text>
        <Text>Sara Nasser</Text>
      </InLanguage>,
    );
    expect(screen.getByText('Maintenir pour envoyer')).toBeTruthy();
    expect(screen.getByText('Sara Nasser')).toBeTruthy();
  });

  it('right-to-left languages read and align from the right', async () => {
    const screen = await render(
      <InLanguage lang="ar">
        <Text>Balance</Text>
        <Text style={{ textAlign: 'right' }}>$12.00</Text>
        <Text style={{ textAlign: 'center' }}>Home</Text>
      </InLanguage>,
    );
    const style = (text: string) => StyleSheet.flatten(screen.getByText(text).props.style);
    expect(style('الرصيد')).toMatchObject({ writingDirection: 'rtl', textAlign: 'right' });
    expect(style('$12.00')).toMatchObject({ textAlign: 'left' });
    expect(style('الرئيسية')).toMatchObject({ textAlign: 'center' });
  });
});
