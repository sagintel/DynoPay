import { tr } from '@/i18n/context';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Linking from 'expo-linking';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { Avatar } from '@/components/Avatar';
import { Button, HoldButton, type HoldState } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { haptic, Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { api, ApiError } from '@/lib/api';
import { colors, space } from '@/theme/tokens';
import { useCanvas } from '../canvas';
import * as Clipboard from 'expo-clipboard';
import type { Block, DraftView, PendingView } from '../types';
import { BigAmount, KeyValueRow, NoticeBlock } from './Primitives';

const DONE_LABEL: Record<string, string> = {
  send_money: 'Sent', pay_request: 'Paid', fund_card: 'Moved', withdraw_from_card: 'Moved', create_card: 'Card created',
  close_card: 'Card closed', unfreeze_card: 'Unfrozen', delete_contact: 'Deleted', schedule_payment: 'Scheduled',
  cancel_schedule: 'Stopped', request_money: 'Requested', top_up: 'Opening PayPal',
};

/** Biometric step-up before money moves. Web/devices without enrolled biometrics rely on the hold gesture. */
async function verifyUser(reason: string): Promise<boolean> {
  if (Platform.OS === 'web') return true;
  const [hardware, enrolled] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()]);
  if (!hardware || !enrolled) return true;
  const res = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: 'Cancel', disableDeviceFallback: false });
  return res.success;
}

/**
 * The human-in-the-loop moment. Everything here was prepared by the agent;
 * nothing has happened until the user holds (or taps) the button.
 */
export function ConfirmationBlock({ block }: { block: Extract<Block, { type: 'confirmation' }> }) {
  const { onExecuted, dispatch } = useCanvas();
  const [pending, setPending] = useState<PendingView | DraftView | undefined>(block.data);
  const [state, setState] = useState<HoldState>(block.data?.status === 'executed' ? 'done' : 'idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPending(block.data);
    setState(block.data?.status === 'executed' ? 'done' : 'idle');
    setError(null);
  }, [block.data]);

  if (!pending) return null;
  const s = pending.summary;
  const closed = ['cancelled', 'expired'].includes(pending.status);
  const isDraft = pending.status === 'draft';
  const link = typeof pending.result?.approveUrl === 'string' && pending.action !== 'top_up' ? (pending.result.approveUrl as string) : null;

  const confirm = async () => {
    setError(null);
    setState('working');
    try {
      if (s.biometric && !(await verifyUser(s.title))) {
        setState('idle');
        setError(tr('Verification cancelled. Nothing was sent.'));
        return;
      }
      // A draft (shown while typing) is first prepared for real; the server re-validates everything here.
      let id = pending.id;
      if (pending.status === 'draft') {
        const prepared = await api.perform(pending.action, pending.input);
        if (prepared.status !== 'needs_confirmation') throw new ApiError(400, 'unexpected', 'This action could not be prepared');
        id = prepared.pending.id;
      }
      const result = await api.confirm(id, pending.action === 'top_up' ? Linking.createURL('topup') : undefined);
      setPending(result);
      if (result.status === 'executed') {
        setState('done');
        haptic('success');
        await onExecuted(result);
      } else {
        setState('error');
        setError(result.error ?? tr('This action is {x}.', { x: tr(result.status) }));
        haptic('error');
      }
    } catch (e) {
      setState('error');
      setError(e instanceof ApiError ? e.message : tr('Could not confirm. Nothing was sent.'));
      haptic('error');
    }
  };

  /** "Tap a line to edit": re-propose with a changed amount or note. */
  const edit = (field: 'amount' | 'note') => {
    if (state !== 'idle' || !['send_money', 'fund_card', 'top_up', 'request_money', 'schedule_payment', 'refund_payment', 'merchant_payout'].includes(pending.action)) return;
    void dispatch({
      type: 'dialog',
      dialog: {
        title: field === 'amount' ? 'Change amount' : 'Change note',
        fields: [{ name: 'value', label: field === 'amount' ? 'Amount' : 'Note', kind: field === 'amount' ? 'amount' : 'text', value: (pending.input[field] as string | number | undefined) ?? '' }],
        buttons: [
          {
            label: 'Update',
            variant: 'primary',
            action: { type: 'run', action: pending.action, input: { ...pending.input, [field]: '$field.value' } },
          },
        ],
      },
    });
    if (!isDraft) void api.cancel(pending.id).catch(() => undefined);
  };

  return (
    <Animated.View entering={FadeIn.duration(250)} style={{ gap: space.lg }}>
      {s.amount !== undefined ? (
        <Tap onPress={() => edit('amount')} scaleTo={0.99} haptics={false}>
          <BigAmount value={s.amount} currency={s.currency} size="xl" />
        </Tap>
      ) : (
        <Text variant="title">{s.title}</Text>
      )}

      {s.recipient ? (
        <View style={styles.recipient}>
          <Avatar initials={s.recipient.initials} size={40} solid />
          <View style={{ flex: 1 }}>
            <Text variant="bodyStrong">{s.recipient.name}</Text>
            <Text variant="caption" color={colors.textMuted} numberOfLines={1}>{s.recipient.subtitle}</Text>
          </View>
          {s.recipient.verified ? (
            <View style={styles.verified}>
              <Icon name="shield" size={13} color={colors.accent} />
              <Text variant="label" color={colors.accent}>Verified</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline }}>
        {s.lines.map((l, i) => (
          <KeyValueRow key={i} label={l.label} value={l.value} last={i === s.lines.length - 1} onPress={l.label === 'Note' ? () => edit('note') : undefined} />
        ))}
      </View>

      {closed ? (
        <NoticeBlock block={{ type: 'notice', tone: 'warning', text: pending.status === 'expired' ? 'This expired. Ask again to prepare it.' : 'Cancelled. Nothing happened.' }} />
      ) : s.style === 'hold' ? (
        <HoldButton label={s.confirmLabel} doneLabel={DONE_LABEL[pending.action] ?? 'Done'} state={state} danger={s.tone === 'danger'} onConfirm={() => void confirm()} />
      ) : (
        <Button
          label={state === 'done' ? DONE_LABEL[pending.action] ?? 'Done' : s.confirmLabel}
          icon={state === 'done' ? 'check' : pending.action === 'top_up' ? 'paypal' : undefined}
          variant={s.tone === 'danger' ? 'danger' : state === 'done' ? 'primary' : 'ivory'}
          loading={state === 'working'}
          disabled={state === 'done'}
          onPress={() => void confirm()}
        />
      )}

      {link ? (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <View style={{ flex: 1 }}>
            <Button label="Copy link" icon="receipt" variant="secondary" onPress={() => void Clipboard.setStringAsync(link).then(() => haptic('success'))} />
          </View>
          <View style={{ flex: 1 }}>
            <Button label="Open" icon="paypal" variant="secondary" onPress={() => void dispatch({ type: 'open_url', url: link })} />
          </View>
        </View>
      ) : null}

      {error ? (
        <Animated.View entering={FadeIn}>
          <Text variant="caption" color={colors.negative} style={{ textAlign: 'center' }}>{error}</Text>
        </Animated.View>
      ) : (
        <Text variant="caption" color={colors.textFaint} style={{ textAlign: 'center' }}>
          {state === 'done' ? (link ? 'Share this link with your customer.' : 'Done. It is in your activity.') : isDraft ? 'Nothing happens until you confirm.' : 'Understood from your sentence. Tap a line to edit.'}
        </Text>
      )}
      {state === 'error' && pending.status === 'failed' ? (
        <Button label="Try again" variant="ghost" icon="repeat" onPress={() => void dispatch({ type: 'run', action: pending.action, input: pending.input })} />
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  recipient: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  verified: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
