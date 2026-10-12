import { View } from 'react-native';
import Animated, { FadeInDown, LinearTransition } from 'react-native-reanimated';
import { appearance, space } from '@/theme/tokens';
import { BalanceBlock } from './blocks/Balance';
import { CardBlock, CardsBlock } from './blocks/Cards';
import { ChartBlock } from './blocks/Charts';
import { ConfirmationBlock } from './blocks/Confirmation';
import { ContactBlock, ContactsBlock, ProfileBlock } from './blocks/People';
import {
  CatalogBlock, DisputeBlock, DisputesBlock, InvoiceBlock, InvoicesBlock, MerchantOverviewBlock, MerchantSalesBlock, PayPalTransactionsBlock,
} from './blocks/Merchant';
import { RequestsBlock, SchedulesBlock } from './blocks/Lists';
import { PickerBlock } from './blocks/Picker';
import {
  AmountBlock, ButtonBlock, ButtonsBlock, ChipsBlock, DividerBlock, EmptyBlock, ErrorBlock, KeyValuesBlock, NoticeBlock, SectionBlock,
  SpacerBlock, StatGridBlock, TextBlock,
} from './blocks/Primitives';
import { TransactionBlock, TransactionsBlock } from './blocks/Transactions';
import type { Block } from './types';

/** Maps every catalog block to its pre-built, styled component. Unknown types render nothing. */
export function BlockView({ block }: { block: Block }) {
  if ('error' in block && block.error) return <ErrorBlock message={block.error} />;
  switch (block.type) {
    case 'text': return <TextBlock block={block} />;
    case 'amount': return <AmountBlock block={block} />;
    case 'key_values': return <KeyValuesBlock block={block} />;
    case 'button': return <ButtonBlock block={block} />;
    case 'buttons': return <ButtonsBlock block={block} />;
    case 'chips': return <ChipsBlock block={block} />;
    case 'notice': return <NoticeBlock block={block} />;
    case 'stat_grid': return <StatGridBlock block={block} />;
    case 'empty': return <EmptyBlock block={block} />;
    case 'divider': return <DividerBlock />;
    case 'spacer': return <SpacerBlock block={block} />;
    case 'balance': return <BalanceBlock block={block} />;
    case 'transactions': return <TransactionsBlock block={block} />;
    case 'transaction': return <TransactionBlock block={block} />;
    case 'contacts': return <ContactsBlock block={block} />;
    case 'contact': return <ContactBlock block={block} />;
    case 'profile': return <ProfileBlock block={block} />;
    case 'chart': return <ChartBlock block={block} />;
    case 'cards': return <CardsBlock block={block} />;
    case 'card': return <CardBlock block={block} />;
    case 'schedules': return <SchedulesBlock block={block} />;
    case 'requests': return <RequestsBlock block={block} />;
    case 'picker': return <PickerBlock block={block} />;
    case 'confirmation': return <ConfirmationBlock block={block} />;
    case 'merchant_overview': return <MerchantOverviewBlock block={block} />;
    case 'merchant_sales': return <MerchantSalesBlock block={block} />;
    case 'paypal_transactions': return <PayPalTransactionsBlock block={block} />;
    case 'invoices': return <InvoicesBlock block={block} />;
    case 'invoice': return <InvoiceBlock block={block} />;
    case 'disputes': return <DisputesBlock block={block} />;
    case 'dispute': return <DisputeBlock block={block} />;
    case 'catalog': return <CatalogBlock block={block} />;
    case 'section':
      return (
        <SectionBlock block={block}>
          <Blocks blocks={block.children} animate={false} />
        </SectionBlock>
      );
    case 'row':
      return (
        <View style={{ flexDirection: 'row', gap: space.md }}>
          {block.children.map((c, i) => (
            <View key={i} style={{ flex: 1 }}>
              <BlockView block={c} />
            </View>
          ))}
        </View>
      );
    default:
      return null;
  }
}

const keyOf = (b: Block, i: number) =>
  `${b.type}:${'pendingId' in b ? b.pendingId : 'cardId' in b ? b.cardId : 'transactionId' in b ? b.transactionId : 'invoiceId' in b ? b.invoiceId : 'disputeId' in b ? b.disputeId : i}`;

export function Blocks({ blocks, animate = true, gap }: { blocks: Block[]; animate?: boolean; gap?: number }) {
  gap ??= appearance.density === 'compact' ? space.lg : space.xxl;
  if (appearance.motion === 'reduced') animate = false;
  return (
    <View style={{ gap }}>
      {blocks.map((b, i) =>
        animate ? (
          <Animated.View key={keyOf(b, i)} entering={FadeInDown.duration(320).delay(Math.min(i, 6) * 45)} layout={LinearTransition.springify().damping(20)}>
            <BlockView block={b} />
          </Animated.View>
        ) : (
          <BlockView key={keyOf(b, i)} block={b} />
        ),
      )}
    </View>
  );
}
