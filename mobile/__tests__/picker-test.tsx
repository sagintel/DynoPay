import { fireEvent, render } from '@testing-library/react-native';
import { PickerBlock } from '@/genui/blocks/Picker';
import type { Block } from '@/genui/types';
import { InLanguage } from './test-utils';

const mockDispatch = jest.fn(async () => undefined);
jest.mock('@/genui/canvas', () => ({ useCanvas: () => ({ dispatch: mockDispatch }) }));

type PickerT = Extract<Block, { type: 'picker' }>;
const contacts: PickerT = {
  type: 'picker',
  kind: 'contact',
  action: 'send_money',
  input: { amount: 400 },
  search: 'sara',
  data: {
    action: 'send_money',
    input: { amount: 400 },
    preselect: null,
    searchMiss: false,
    items: [
      { id: 'c1', title: 'Sara Nasser', subtitle: '@saranasser', initials: 'SN', badge: 'DynoPay', patch: { recipient: { contactId: 'c1' } } },
      { id: 'c2', title: 'Sara Okafor', subtitle: 'sara.o@example.com', initials: 'SO', patch: { recipient: { contactId: 'c2' } } },
    ],
  },
};

beforeEach(() => mockDispatch.mockClear());

describe('pick the target, then confirm', () => {
  it('nothing runs until a person is chosen; Continue prepares the action with the chosen one', async () => {
    const screen = await render(<InLanguage><PickerBlock block={contacts} /></InLanguage>);
    expect(screen.getByText('Choose one to continue')).toBeTruthy();
    await fireEvent.press(screen.getByText('Choose one to continue'));
    expect(mockDispatch).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByText('Sara Okafor'));
    await fireEvent.press(screen.getByText('Continue with Sara Okafor'));
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'run', action: 'send_money', input: { amount: 400, recipient: { contactId: 'c2' } } });
  });

  it('the server preselects when it is sure (the user can still change it)', async () => {
    const screen = await render(<InLanguage><PickerBlock block={{ ...contacts, data: { ...contacts.data!, preselect: 'c1' } }} /></InLanguage>);
    expect(screen.getByText('Continue with Sara Nasser')).toBeTruthy();
  });

  it('ineligible items show why and cannot be chosen', async () => {
    const cards: PickerT = {
      type: 'picker',
      kind: 'card',
      action: 'fund_card',
      input: { amount: 300 },
      data: {
        action: 'fund_card',
        input: { amount: 300 },
        preselect: null,
        searchMiss: false,
        items: [
          { id: 'k1', title: 'Everyday ·· 4242', subtitle: '$20.00', badge: 'amber', patch: { cardId: 'k1' } },
          { id: 'k2', title: 'Travel ·· 1881', subtitle: '$0.00 · Frozen', badge: 'ocean', disabled: true, reason: 'Frozen', patch: { cardId: 'k2' } },
        ],
      },
    };
    const screen = await render(<InLanguage><PickerBlock block={cards} /></InLanguage>);
    expect(screen.getByText('Frozen')).toBeTruthy();
    await fireEvent.press(screen.getByText('Travel ·· 1881'));
    // The only eligible card is preselected; the frozen one can't replace it.
    await fireEvent.press(screen.getByText('Continue with Everyday ·· 4242'));
    expect(mockDispatch).toHaveBeenCalledWith({ type: 'run', action: 'fund_card', input: { amount: 300, cardId: 'k1' } });
  });

  it('asks in the user language', async () => {
    const screen = await render(<InLanguage lang="sw"><PickerBlock block={contacts} /></InLanguage>);
    expect(screen.getByText('Ni kwa nani?')).toBeTruthy();
  });
});
