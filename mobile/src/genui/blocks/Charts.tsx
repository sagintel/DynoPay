import { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient, Line as SvgLine, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { Icon } from '@/components/Icon';
import { Tap } from '@/components/Pressable';
import { Text } from '@/components/Text';
import { currencySymbol, localDate, money } from '@/lib/format';
import { tr } from '@/i18n/context';
import { appearance, colors, fonts, radius, space } from '@/theme/tokens';
import type { Block, ChartBucket, ChartData, ChartKind } from '../types';
import { BigAmount, EmptyBlock } from './Primitives';

/**
 * Chart palette — validated with the dataviz validator against the dark surface (#1C1C1E):
 * adjacent CVD ΔE ≥ 8.6, normal-vision ΔE ≥ 19.7, all ≥ 3:1 contrast. Order is the safety
 * mechanism: assign in this order, never cycle. Rings (pie/donut) wrap around, so 3 slices use
 * slots 1/2/4 and >7 slices fold into a neutral "Other".
 */
const SERIES_DARK = ['#c98500', '#3987e5', '#d95926', '#199e70', '#9085e9', '#d55181', '#008300', '#e66767'] as const;
/** Same hues, darkened to keep ≥3:1 against light surfaces (used by light custom themes). */
const SERIES_LIGHT = ['#9a6500', '#2a6fc2', '#b8481a', '#11775a', '#6a58cc', '#b63a6c', '#006600', '#c0474a'] as const;
// Evaluated after boot applied the saved theme (a theme change reloads the app).
export const SERIES: readonly string[] = appearance.mode === 'light' ? SERIES_LIGHT : SERIES_DARK;
const OTHER = appearance.mode === 'light' ? '#8a8a90' : '#6b6b70';
/** Sequential (one hue, dark → light) for heatmaps; zero cells use the surface. */
const RAMP: readonly string[] = appearance.mode === 'light' ? ['#f6e3bd', '#ecc679', '#d9961f', '#a86f00', '#6e4c0c'] : ['#6e4c0c', '#8f630f', '#b27b12', '#d9961f', '#f5c46b'];
const GAP = 2;
const END_RADIUS = 4;

type Selected = number | null;
const fmt = (v: number, currency: string) => money(v, currency);
const short = (v: number, currency: string) => {
  const sym = currencySymbol(currency).trim();
  const a = Math.abs(v);
  return `${v < 0 ? '−' : ''}${sym}${a >= 1000 ? `${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : Math.round(a)}`;
};

function axisLabel(key: string, groupBy: string) {
  if (groupBy === 'day') return String(new Date(`${key}T00:00:00`).getDate());
  if (groupBy === 'week') return localDate(new Date(`${key}T00:00:00`), { month: 'short', day: 'numeric' });
  if (groupBy === 'month') return localDate(new Date(`${key}-01T00:00:00`), { month: 'short' });
  return key.length > 9 ? `${key.slice(0, 8)}…` : key;
}
function longLabel(b: ChartBucket, groupBy: string) {
  if (groupBy === 'day') return localDate(new Date(`${b.key}T00:00:00`), { weekday: 'short', month: 'short', day: 'numeric' });
  if (groupBy === 'week') return tr('Week of {x}', { x: localDate(new Date(`${b.key}T00:00:00`), { month: 'short', day: 'numeric' }) });
  if (groupBy === 'month') return localDate(new Date(`${b.key}-01T00:00:00`), { month: 'long', year: 'numeric' });
  return b.label;
}

/** Bar with rounded data-end, square at the baseline. */
function vBar(x: number, base: number, w: number, h: number) {
  const r = Math.min(END_RADIUS, w / 2, h);
  const top = base - h;
  return `M${x},${base} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + w - r},${top} Q${x + w},${top} ${x + w},${top + r} L${x + w},${base} Z`;
}
function hBar(x: number, y: number, w: number, h: number) {
  const r = Math.min(END_RADIUS, h / 2, w);
  return `M${x},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x},${y + h} Z`;
}

/** Ring colors following the wrap-around rule. */
function ringItems(buckets: ChartBucket[]) {
  const items = buckets.filter((b) => b.amount > 0);
  if (items.length > 7) {
    const head = items.slice(0, 6);
    const rest = items.slice(6).reduce((s, b) => s + b.amount, 0);
    return [...head.map((b, i) => ({ ...b, color: SERIES[i]! })), { key: 'other', label: 'Other', amount: rest, share: 0, color: OTHER }];
  }
  const order = items.length === 3 ? [0, 1, 3] : items.map((_, i) => i);
  return items.map((b, i) => ({ ...b, color: SERIES[order[i]!]! }));
}

/** Converts a tap's x position to a bucket index (line/area/bar); null when the position is unknown. */
const indexAt = (x: number, width: number, n: number): number | null =>
  Number.isFinite(x) && n > 0 ? Math.max(0, Math.min(n - 1, Math.floor((x / width) * n))) : null;

/**
 * Tap x relative to the chart. Native press events carry locationX; on web the event is a DOM
 * mouse event, so measure against the element's box instead.
 */
function useTapX() {
  const ref = useRef<View>(null);
  const xOf = (e: GestureResponderEvent) => {
    const ne = e.nativeEvent as GestureResponderEvent['nativeEvent'] & { clientX?: number };
    if (Number.isFinite(ne.locationX)) return ne.locationX;
    const node = ref.current as unknown as { getBoundingClientRect?: () => { left: number } } | null;
    const left = node?.getBoundingClientRect?.().left;
    return left !== undefined && Number.isFinite(ne.clientX) ? ne.clientX! - left : NaN;
  };
  return { ref, xOf };
}

// ─── Forms ─────────────────────────────────────────────────────────────────

function Bars({ data, width, selected, onSelect }: FormProps) {
  const tap = useTapX();
  const h = 150;
  const items = data.buckets;
  const max = Math.max(...items.map((b) => b.amount), 1);
  const bw = Math.max(2, (width - GAP * (items.length - 1)) / items.length);
  const top = items.reduce((best, b, i) => (b.amount > items[best]!.amount ? i : best), 0);
  const every = Math.ceil(items.length / 7);
  const focus = selected ?? top;
  return (
    <Pressable ref={tap.ref} onPress={(e) => onSelect(indexAt(tap.xOf(e), width, items.length))}>
      <Svg width={width} height={h + 18}>
        <SvgLine x1={0} x2={width} y1={h} y2={h} stroke={colors.hairline} strokeWidth={1} />
        <SvgLine x1={0} x2={width} y1={18} y2={18} stroke={colors.hairline} strokeWidth={1} strokeDasharray="2 4" />
        {items.map((b, i) => {
          const bh = b.amount > 0 ? Math.max(2, (b.amount / max) * (h - 18)) : 0;
          const x = i * (bw + GAP);
          return (
            <G key={b.key}>
              {bh > 0 ? <Path d={vBar(x, h, bw, bh)} fill={colors.accent} opacity={selected === null || selected === i ? 1 : 0.45} /> : null}
              {i % every === 0 ? (
                <SvgText x={x + bw / 2} y={h + 13} fontSize={9.5} fontFamily={fonts.medium} fill={colors.textFaint} textAnchor="middle">
                  {axisLabel(b.key, data.groupBy)}
                </SvgText>
              ) : null}
            </G>
          );
        })}
        {items[focus] && items[focus]!.amount > 0 ? (
          <SvgText
            x={Math.min(width - 16, Math.max(16, focus * (bw + GAP) + bw / 2))}
            y={h - (items[focus]!.amount / max) * (h - 18) - 6}
            fontSize={10}
            fontFamily={fonts.semibold}
            fill={colors.text}
            textAnchor="middle"
          >
            {short(items[focus]!.amount, data.currency)}
          </SvgText>
        ) : null}
      </Svg>
    </Pressable>
  );
}

function HBars({ data, width, selected, onSelect }: FormProps) {
  const items = data.buckets.filter((b) => b.amount > 0).slice(0, 8);
  const max = Math.max(...items.map((b) => b.amount), 1);
  const labelW = Math.min(110, width * 0.34);
  const valueW = 64;
  const barMax = Math.max(10, width - labelW - valueW - 8);
  return (
    <View style={{ gap: 10 }}>
      {items.map((b, i) => (
        <Tap key={b.key} onPress={() => onSelect(i)} haptics={false} scaleTo={0.99} style={{ flexDirection: 'row', alignItems: 'center', opacity: selected === null || selected === i ? 1 : 0.5 }}>
          <Text variant="caption" numberOfLines={1} style={{ width: labelW }}>{b.label}</Text>
          <Svg width={barMax} height={14}>
            <Path d={hBar(0, 1, Math.max(2, (b.amount / max) * barMax), 12)} fill={colors.accent} />
          </Svg>
          <Text variant="caption" color={colors.textMuted} style={{ width: valueW, textAlign: 'right' }}>{short(b.amount, data.currency)}</Text>
        </Tap>
      ))}
    </View>
  );
}

function Lines({ data, width, selected, onSelect, kind }: FormProps & { kind: 'line' | 'area' | 'sparkline' }) {
  const tap = useTapX();
  const spark = kind === 'sparkline';
  const h = spark ? 48 : 150;
  const series = data.series?.length ? data.series.map((s, i) => ({ name: s.name, buckets: s.buckets, color: SERIES[i]! })) : [{ name: 'Total', buckets: data.buckets, color: colors.accent }];
  const n = series[0]!.buckets.length;
  const max = Math.max(1, ...series.flatMap((s) => s.buckets.map((b) => b.amount)));
  const x = (i: number) => (n <= 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (v: number) => h - 6 - (v / max) * (h - (spark ? 12 : 26));
  const path = (b: ChartBucket[]) =>
    b.reduce((acc, p, i) => {
      if (i === 0) return `M ${x(0)} ${y(p.amount)}`;
      const cx = (x(i - 1) + x(i)) / 2;
      return `${acc} C ${cx} ${y(b[i - 1]!.amount)}, ${cx} ${y(p.amount)}, ${x(i)} ${y(p.amount)}`;
    }, '');
  const focus = selected ?? n - 1;
  return (
    <Pressable ref={tap.ref} onPress={(e) => onSelect(indexAt(tap.xOf(e), width, n))}>
      <Svg width={width} height={h + (spark ? 0 : 18)}>
        <Defs>
          <LinearGradient id="area" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={series[0]!.color} stopOpacity="0.32" />
            <Stop offset="1" stopColor={series[0]!.color} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        {!spark ? <SvgLine x1={0} x2={width} y1={h} y2={h} stroke={colors.hairline} strokeWidth={1} /> : null}
        {kind === 'area' && series.length === 1 ? <Path d={`${path(series[0]!.buckets)} L ${x(n - 1)} ${h} L ${x(0)} ${h} Z`} fill="url(#area)" /> : null}
        {series.map((s) => (
          <Path key={s.name} d={path(s.buckets)} stroke={s.color} strokeWidth={spark ? 1.6 : 2} fill="none" strokeLinecap="round" />
        ))}
        {!spark ? <SvgLine x1={x(focus)} x2={x(focus)} y1={10} y2={h} stroke={colors.border} strokeWidth={1} strokeDasharray="3 3" /> : null}
        {series.map((s) => (
          <Circle key={`p${s.name}`} cx={x(focus)} cy={y(s.buckets[focus]?.amount ?? 0)} r={4} fill={s.color} stroke={colors.surface} strokeWidth={2} />
        ))}
        {!spark && n > 0 ? (
          <>
            <SvgText x={0} y={h + 13} fontSize={9.5} fontFamily={fonts.medium} fill={colors.textFaint}>{axisLabel(series[0]!.buckets[0]!.key, data.groupBy)}</SvgText>
            <SvgText x={width} y={h + 13} fontSize={9.5} fontFamily={fonts.medium} fill={colors.textFaint} textAnchor="end">{axisLabel(series[0]!.buckets[n - 1]!.key, data.groupBy)}</SvgText>
          </>
        ) : null}
      </Svg>
    </Pressable>
  );
}

function Ring({ data, width, selected, onSelect, kind }: FormProps & { kind: 'donut' | 'pie' }) {
  const size = Math.min(150, width * 0.45);
  const cx = size / 2;
  const items = ringItems(data.buckets);
  const total = items.reduce((s, b) => s + b.amount, 0) || 1;
  const outer = size / 2 - 1;
  const inner = kind === 'donut' ? outer - 18 : 0;
  let angle = -Math.PI / 2;
  const arcs = items.map((b) => {
    const sweep = (b.amount / total) * Math.PI * 2;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const p = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cx + r * Math.sin(a)}`;
    const large = sweep > Math.PI ? 1 : 0;
    const d = items.length === 1
      ? `M ${cx - outer} ${cx} A ${outer} ${outer} 0 1 1 ${cx + outer} ${cx} A ${outer} ${outer} 0 1 1 ${cx - outer} ${cx} Z`
      : inner > 0
        ? `M ${p(outer, a0)} A ${outer} ${outer} 0 ${large} 1 ${p(outer, a1)} L ${p(inner, a1)} A ${inner} ${inner} 0 ${large} 0 ${p(inner, a0)} Z`
        : `M ${cx} ${cx} L ${p(outer, a0)} A ${outer} ${outer} 0 ${large} 1 ${p(outer, a1)} Z`;
    return { ...b, d };
  });
  const focus = selected !== null ? items[selected] : null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
      <Svg width={size} height={size}>
        {arcs.map((a, i) => (
          // 2px surface stroke = the gap between adjacent fills.
          <Path key={a.key} d={a.d} fill={a.color} stroke={colors.surface} strokeWidth={GAP} opacity={selected === null || selected === i ? 1 : 0.45} onPress={() => onSelect(i)} />
        ))}
        {kind === 'donut' ? (
          <>
            <SvgText x={cx} y={cx - 3} fontSize={10.5} fontFamily={fonts.medium} fill={colors.textMuted} textAnchor="middle">{focus ? focus.label.slice(0, 12) : 'Total'}</SvgText>
            <SvgText x={cx} y={cx + 14} fontSize={14} fontFamily={fonts.bold} fill={colors.text} textAnchor="middle">{short(focus ? focus.amount : total, data.currency)}</SvgText>
          </>
        ) : null}
      </Svg>
      <View style={{ flex: 1, gap: 8 }}>
        {items.map((b, i) => (
          <Tap key={b.key} onPress={() => onSelect(i)} haptics={false} scaleTo={0.99} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ width: 9, height: 9, borderRadius: 2, backgroundColor: b.color }} />
            <Text variant="caption" style={{ flex: 1 }} numberOfLines={1}>{b.label}</Text>
            <Text variant="caption" color={colors.textMuted}>{Math.round((b.amount / total) * 100)}%</Text>
          </Tap>
        ))}
      </View>
    </View>
  );
}

function Progress({ data, selected, onSelect }: FormProps) {
  const items = data.buckets.filter((b) => b.amount > 0).slice(0, 8);
  const max = Math.max(...items.map((b) => b.amount), 1);
  return (
    <View style={{ gap: 12 }}>
      {items.map((b, i) => (
        <Tap key={b.key} onPress={() => onSelect(i)} haptics={false} scaleTo={0.99} style={{ gap: 6, opacity: selected === null || selected === i ? 1 : 0.5 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text variant="label">{b.label}</Text>
            <Text variant="label" color={colors.textMuted}>{fmt(b.amount, data.currency)}</Text>
          </View>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${(b.amount / max) * 100}%`, backgroundColor: colors.accent }]} />
          </View>
        </Tap>
      ))}
    </View>
  );
}

function Gauge({ data, width }: FormProps) {
  const target = data.target ?? 0;
  const size = Math.min(width, 260);
  const r = size / 2 - 12;
  const cx = size / 2;
  const cy = size / 2 + 4;
  const ratio = target > 0 ? data.total / target : 0;
  const over = ratio > 1;
  const sweep = Math.min(1, ratio) * Math.PI;
  const end = { x: cx - r * Math.cos(sweep), y: cy - r * Math.sin(sweep) };
  const statusColor = over ? colors.negative : ratio > 0.85 ? colors.warning : colors.accent;
  return (
    <View style={{ alignItems: 'center', gap: 6 }}>
      <Svg width={size} height={size / 2 + 16}>
        <Path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} stroke={colors.surfaceHigh} strokeWidth={14} fill="none" strokeLinecap="round" />
        {ratio > 0 ? <Path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${end.x} ${end.y}`} stroke={statusColor} strokeWidth={14} fill="none" strokeLinecap="round" /> : null}
        <SvgText x={cx} y={cy - 22} fontSize={22} fontFamily={fonts.bold} fill={colors.text} textAnchor="middle">{`${Math.round(ratio * 100)}%`}</SvgText>
        <SvgText x={cx} y={cy - 4} fontSize={11} fontFamily={fonts.medium} fill={colors.textMuted} textAnchor="middle">{`of ${fmt(target, data.currency)}`}</SvgText>
      </Svg>
      {/* Status is never color alone: icon + words. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name={over ? 'warning' : 'check'} size={14} color={statusColor} />
        <Text variant="label" color={colors.textMuted}>
          {target <= 0 ? 'No budget set' : over ? `${fmt(data.total - target, data.currency)} over budget` : `${fmt(target - data.total, data.currency)} left`}
        </Text>
      </View>
    </View>
  );
}

function Heatmap({ data, width, selected, onSelect }: FormProps) {
  const items = data.buckets;
  const cols = 7;
  const cell = Math.floor((width - GAP * (cols - 1)) / cols);
  const max = Math.max(...items.map((b) => b.amount), 1);
  const offset = items.length ? (new Date(`${items[0]!.key}T00:00:00`).getDay() + 6) % 7 : 0; // Monday-first calendar
  const shade = (v: number) => (v <= 0 ? colors.surfaceHigh : RAMP[Math.min(RAMP.length - 1, Math.floor((v / max) * (RAMP.length - 0.001)))]!);
  const rows = Math.ceil((items.length + offset) / cols);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: 'row', gap: GAP }}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <Text key={i} variant="tiny" color={colors.textFaint} style={{ width: cell, textAlign: 'center' }}>{d}</Text>
        ))}
      </View>
      <Svg width={width} height={rows * (Math.min(cell, 34) + GAP)}>
        {items.map((b, i) => {
          const pos = i + offset;
          const h = Math.min(cell, 34);
          return (
            <Rect
              key={b.key}
              x={(pos % cols) * (cell + GAP)}
              y={Math.floor(pos / cols) * (h + GAP)}
              width={cell}
              height={h}
              rx={4}
              fill={shade(b.amount)}
              stroke={selected === i ? colors.text : 'none'}
              strokeWidth={selected === i ? 1.5 : 0}
              onPress={() => onSelect(i)}
            />
          );
        })}
      </Svg>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-end' }}>
        <Text variant="tiny" color={colors.textFaint}>Less</Text>
        {[colors.surfaceHigh, ...RAMP].map((c) => (
          <View key={c} style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: c }} />
        ))}
        <Text variant="tiny" color={colors.textFaint}>More</Text>
      </View>
    </View>
  );
}

function Compare({ data, width, selected, onSelect, kind }: FormProps & { kind: 'stacked' | 'grouped' }) {
  const tap = useTapX();
  const series = (data.series ?? []).slice(0, 2);
  if (series.length < 2) return <Bars data={data} width={width} selected={selected} onSelect={onSelect} />;
  const h = 150;
  const n = series[0]!.buckets.length;
  const groupW = (width - GAP * 3 * (n - 1)) / n;
  const totals = series[0]!.buckets.map((_, i) => series.reduce((s, x) => s + (x.buckets[i]?.amount ?? 0), 0));
  const max = Math.max(1, ...(kind === 'stacked' ? totals : series.flatMap((s) => s.buckets.map((b) => b.amount))));
  const scale = (v: number) => (v / max) * (h - 14);
  const every = Math.ceil(n / 6);
  return (
    <Pressable ref={tap.ref} onPress={(e) => onSelect(indexAt(tap.xOf(e), width, n))}>
      <Svg width={width} height={h + 18}>
        <SvgLine x1={0} x2={width} y1={h} y2={h} stroke={colors.hairline} strokeWidth={1} />
        {series[0]!.buckets.map((b, i) => {
          const gx = i * (groupW + GAP * 3);
          const dim = selected === null || selected === i ? 1 : 0.45;
          if (kind === 'stacked') {
            let base = h;
            return (
              <G key={b.key} opacity={dim}>
                {series.map((s, si) => {
                  const v = s.buckets[i]?.amount ?? 0;
                  const bh = v > 0 ? Math.max(2, scale(v)) : 0;
                  if (!bh) return null;
                  const isTop = si === series.length - 1 || !series.slice(si + 1).some((x) => (x.buckets[i]?.amount ?? 0) > 0);
                  const y0 = base;
                  base -= bh + (isTop ? 0 : GAP);
                  return isTop ? <Path key={s.key} d={vBar(gx, y0, groupW, bh)} fill={SERIES[si]} /> : <Rect key={s.key} x={gx} y={y0 - bh} width={groupW} height={bh} fill={SERIES[si]} />;
                })}
                {i % every === 0 ? <SvgText x={gx + groupW / 2} y={h + 13} fontSize={9.5} fontFamily={fonts.medium} fill={colors.textFaint} textAnchor="middle">{axisLabel(b.key, data.groupBy)}</SvgText> : null}
              </G>
            );
          }
          const bw = (groupW - GAP) / 2;
          return (
            <G key={b.key} opacity={dim}>
              {series.map((s, si) => {
                const v = s.buckets[i]?.amount ?? 0;
                return v > 0 ? <Path key={s.key} d={vBar(gx + si * (bw + GAP), h, bw, Math.max(2, scale(v)))} fill={SERIES[si]} /> : null;
              })}
              {i % every === 0 ? <SvgText x={gx + groupW / 2} y={h + 13} fontSize={9.5} fontFamily={fonts.medium} fill={colors.textFaint} textAnchor="middle">{axisLabel(b.key, data.groupBy)}</SvgText> : null}
            </G>
          );
        })}
      </Svg>
    </Pressable>
  );
}

type FormProps = { data: ChartData; width: number; selected: Selected; onSelect: (i: number | null) => void };

/** Renders any chart form; used by the chart block and merchant sales. */
export function ChartBody({ kind, data, width, selected, onSelect }: FormProps & { kind: ChartKind }) {
  const p = { data, width, selected, onSelect };
  switch (kind) {
    case 'hbar': return <HBars {...p} />;
    case 'line':
    case 'area':
    case 'sparkline': return <Lines {...p} kind={kind} />;
    case 'donut':
    case 'pie': return <Ring {...p} kind={kind} />;
    case 'progress': return <Progress {...p} />;
    case 'gauge': return <Gauge {...p} />;
    case 'heatmap': return <Heatmap {...p} />;
    case 'stacked':
    case 'grouped': return <Compare {...p} kind={kind} />;
    default: return <Bars {...p} />;
  }
}

/** Legend whenever there are ≥ 2 series (identity is never color alone). */
function Legend({ data }: { data: ChartData }) {
  if (!data.series || data.series.length < 2) return null;
  return (
    <View style={{ flexDirection: 'row', gap: 14 }}>
      {data.series.map((s, i) => (
        <View key={s.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: SERIES[i] }} />
          <Text variant="caption" color={colors.textMuted}>{s.name} · {fmt(s.total, data.currency)}</Text>
        </View>
      ))}
    </View>
  );
}

/** The tapped bucket's exact values (the mobile equivalent of a hover tooltip). */
function Readout({ data, index }: { data: ChartData; index: number }) {
  const b = data.buckets[index];
  if (!b) return null;
  return (
    <View style={styles.readout}>
      <Text variant="caption" color={colors.textMuted}>{longLabel(b, data.groupBy)}</Text>
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {(data.series?.length ? data.series : [{ key: 'v', name: '', total: 0, buckets: data.buckets }]).map((s, i) => (
          <Text key={s.key} variant="label" style={{ fontFamily: fonts.semibold }}>
            {s.name ? `${s.name} ` : ''}{fmt(s.buckets[index]?.amount ?? 0, data.currency)}
            {i === 0 && b.share && !data.series ? ` · ${b.share}%` : ''}
          </Text>
        ))}
      </View>
    </View>
  );
}

function Table({ data }: { data: ChartData }) {
  const rows = data.buckets.filter((b) => b.amount > 0 || data.series);
  return (
    <View style={{ gap: 4 }}>
      {rows.slice(0, 40).map((b) => (
        <View key={b.key} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline }}>
          <Text variant="caption">{longLabel(b, data.groupBy)}</Text>
          <Text variant="caption" color={colors.textMuted}>
            {data.series ? data.series.map((s) => `${s.name} ${fmt(s.buckets[data.buckets.indexOf(b)]?.amount ?? 0, data.currency)}`).join(' · ') : fmt(b.amount, data.currency)}
          </Text>
        </View>
      ))}
      {!rows.length ? <Text variant="caption" color={colors.textMuted}>No data</Text> : null}
      {rows.length > 40 ? <Text variant="tiny" color={colors.textFaint}>{tr('{x} more…', { x: rows.length - 40 })}</Text> : null}
      {data.target ? <Text variant="caption" color={colors.textMuted}>{tr('Budget {x}', { x: fmt(data.target, data.currency) })}</Text> : null}
    </View>
  );
}

const PERIOD: Record<string, string> = { week: 'This week', month: 'This month', '30d': 'Last 30 days', '90d': 'Last 90 days', year: 'This year' };

/** Shared chrome: title, headline number, form, readout, legend and a table view. */
export function ChartFrame({ title, data, kind, headline, footer }: { title: string; data: ChartData; kind: ChartKind; headline?: React.ReactNode; footer?: React.ReactNode }) {
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<Selected>(null);
  const [table, setTable] = useState(false);
  const summary = useMemo(() => {
    const topBucket = [...data.buckets].sort((a, b) => b.amount - a.amount)[0];
    return `${title}: ${tr('total {x}', { x: fmt(data.total, data.currency) })}${topBucket ? `, ${tr('highest {x}', { x: `${topBucket.label} ${fmt(topBucket.amount, data.currency)}` })}` : ''}`;
  }, [title, data]);
  return (
    <View style={styles.card} onLayout={(e) => setWidth(e.nativeEvent.layout.width - 2 * space.lg)} accessible accessibilityLabel={summary}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ gap: 2, flex: 1 }}>
          <Text variant="label" color={colors.textMuted}>{title}</Text>
          {headline ?? <BigAmount value={data.total} currency={data.currency} size="md" />}
        </View>
        <Tap onPress={() => setTable((t) => !t)} hitSlop={10} accessibilityLabel={table ? 'Show chart' : 'Show table'}>
          <Text variant="tiny" color={colors.accent}>{table ? 'Chart' : 'Table'}</Text>
        </Tap>
      </View>
      {table ? (
        <Table data={data} />
      ) : width > 0 ? (
        <>
          <ChartBody kind={kind} data={data} width={width} selected={selected} onSelect={(i) => setSelected((s) => (i === null || s === i ? null : i))} />
          {selected !== null && !['donut', 'pie', 'gauge', 'hbar', 'progress'].includes(kind) ? <Readout data={data} index={selected} /> : null}
        </>
      ) : null}
      <Legend data={data} />
      {footer}
    </View>
  );
}

export function ChartBlock({ block }: { block: Extract<Block, { type: 'chart' }> }) {
  const data = block.data;
  if (!data) return null;
  const kind = block.kind ?? 'bar';
  const hasData = data.buckets.some((b) => b.amount > 0) || data.series?.some((s) => s.buckets.some((b) => b.amount > 0)) || kind === 'gauge';
  if (!hasData) {
    return <EmptyBlock block={{ type: 'empty', title: 'Nothing to chart yet', text: tr(data.direction === 'in' ? 'No income yet for this period.' : 'No spending yet for this period.'), icon: 'chart' }} />;
  }
  const what = data.direction === 'in' ? 'Money in' : data.direction === 'both' ? 'Money in vs out' : 'Spending';
  return <ChartFrame title={block.title ?? `${tr(what)} · ${tr(PERIOD[data.period] ?? data.period)}`} data={data} kind={kind} />;
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: space.lg, gap: space.lg, borderWidth: 1, borderColor: colors.hairline },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.surfaceHigh, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  readout: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8, borderRadius: radius.sm, backgroundColor: colors.surfaceHigh },
});
