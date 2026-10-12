import { fireEvent, render } from '@testing-library/react-native';
import { IntentStrip } from '@/components/IntentStrip';
import { PromptBar } from '@/components/PromptBar';
import type { Intent } from '@/genui/types';
import { InLanguage } from './test-utils';

const sendToSara: Intent = {
  complete: true,
  parts: [
    { kind: 'action', label: 'Send', text: 'send' },
    { kind: 'amount', label: '$500.00', value: 500, text: '500' },
    { kind: 'person', label: 'Sara Nasser', subtitle: '@saranasser', initials: 'SN', status: 'matched', text: 'sara' },
    { kind: 'purpose', label: 'Dinner', text: 'dinner' },
  ],
};

describe('what the app understood', () => {
  it('shows the main elements of “send 500 to sara for dinner”', async () => {
    const screen = await render(<InLanguage><IntentStrip intent={sendToSara} /></InLanguage>);
    for (const text of ['Send', '$500.00', 'Sara Nasser', '@saranasser', 'Dinner', 'SN']) expect(screen.getByText(text)).toBeTruthy();
  });

  it('an email recipient and what is still missing', async () => {
    const screen = await render(
      <InLanguage>
        <IntentStrip intent={{ complete: false, parts: [{ kind: 'action', label: 'Send' }, { kind: 'missing', label: 'How much?' }, { kind: 'person', label: 'john@gmail.com', subtitle: 'PayPal', status: 'email' }] }} />
      </InLanguage>,
    );
    expect(screen.getByText('How much?')).toBeTruthy();
    expect(screen.getByText('john@gmail.com')).toBeTruthy();
  });

  it('an ambiguous name asks to pick', async () => {
    const screen = await render(
      <InLanguage>
        <IntentStrip intent={{ complete: false, parts: [{ kind: 'person', label: 'Sa', status: 'ambiguous', candidates: 3 }] }} />
      </InLanguage>,
    );
    expect(screen.getByText('3 matches · pick below')).toBeTruthy();
  });

  it('speaks the user language (Swahili)', async () => {
    const screen = await render(<InLanguage lang="sw"><IntentStrip intent={sendToSara} /></InLanguage>);
    expect(screen.getByText('Tuma')).toBeTruthy();
    expect(screen.getByText('kwa')).toBeTruthy();
  });

  it('renders nothing before anything is understood', async () => {
    const screen = await render(<InLanguage><IntentStrip intent={null} /></InLanguage>);
    expect(screen.toJSON()).toBeNull();
  });
});

describe('<PromptBar>', () => {
  it('sends the sentence and reports every change (live agent)', async () => {
    const onSubmit = jest.fn();
    const onChangeText = jest.fn();
    const screen = await render(<InLanguage><PromptBar onSubmit={onSubmit} onChangeText={onChangeText} /></InLanguage>);
    const input = screen.getByLabelText('Tell DynoPay what to do');
    await fireEvent.changeText(input, 'send 500 to sara');
    expect(onChangeText).toHaveBeenLastCalledWith('send 500 to sara');
    await fireEvent(input, 'submitEditing');
    expect(onSubmit).toHaveBeenCalledWith('send 500 to sara');
  });

  it('a request that cannot be fulfilled shows its reason under the bar', async () => {
    const screen = await render(
      <InLanguage><PromptBar onSubmit={jest.fn()} rejection="“6789” isn't a contact, @handle or email address." /></InLanguage>,
    );
    expect(screen.getByText("“6789” isn't a contact, @handle or email address.")).toBeTruthy();
  });

  it('highlights the understood words inside the sentence, exactly as typed', async () => {
    const screen = await render(<InLanguage><PromptBar onSubmit={jest.fn()} understood={sendToSara} /></InLanguage>);
    await fireEvent.changeText(screen.getByLabelText('Tell DynoPay what to do'), 'Send 500 to Sara for dinner');
    expect(screen.getByText('500')).toBeTruthy();
    expect(screen.getByText('Sara')).toBeTruthy();
    expect(screen.getByText('dinner')).toBeTruthy();
  });

  it('the placeholder follows the language', async () => {
    const screen = await render(<InLanguage lang="ar"><PromptBar onSubmit={jest.fn()} /></InLanguage>);
    expect(screen.getByPlaceholderText('اكتب ما سيحدث تاليًا')).toBeTruthy();
  });
});
