import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Defs, Ellipse, LinearGradient, Path, RadialGradient, Stop, Text as SvgText } from 'react-native-svg';
import { Text } from '@/components/Text';
import { colors, fonts } from '@/theme/tokens';
import type { BalanceData, Block } from '../types';
import { BigAmount } from './Primitives';

type BalanceBlockT = Extract<Block, { type: 'balance' }>;

/** Positions along the arc: 7 days spread from the left (≈165°) to the right (≈15°). */
function arcPoint(cx: number, cy: number, r: number, i: number, n: number) {
  const start = 168;
  const end = 12;
  const deg = start - ((start - end) * i) / Math.max(1, n - 1);
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad), deg };
}

function SunArc({ width, data }: { width: number; data: BalanceData }) {
  const height = Math.round(width * 0.5);
  const cx = width / 2;
  const cy = height + 26;
  const r = width * 0.4;
  const days = data.week?.days ?? [];
  const todayIndex = Math.max(0, days.findIndex((d) => d.isToday));
  const points = days.map((_, i) => arcPoint(cx, cy, r, i, days.length));
  const sun = points[todayIndex] ?? arcPoint(cx, cy, r, 2, 7);
  const start = arcPoint(cx, cy, r, -0.4, 7);
  const end = arcPoint(cx, cy, r, 6.4, 7);
  const eventsByDay = new Map<string, { name: string }[]>();
  for (const e of data.week?.events ?? []) eventsByDay.set(e.date, [...(eventsByDay.get(e.date) ?? []), e]);

  return (
    <Svg width={width} height={height} style={{ position: 'absolute', top: 0, left: 0 }}>
      <Defs>
        <LinearGradient id="arc" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor={colors.textFaint} stopOpacity="0.35" />
          <Stop offset={String(Math.max(0.05, sun.x / width - 0.05))} stopColor={colors.accent} stopOpacity="0.9" />
          <Stop offset="0.75" stopColor={colors.accentDeep} stopOpacity="0.55" />
          <Stop offset="1" stopColor={colors.textFaint} stopOpacity="0.25" />
        </LinearGradient>
        <RadialGradient id="haze" cx="50%" cy="100%" rx="55%" ry="85%">
          <Stop offset="0" stopColor={colors.accent} stopOpacity="0.16" />
          <Stop offset="0.6" stopColor={colors.accent} stopOpacity="0.05" />
          <Stop offset="1" stopColor={colors.accent} stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="sun" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor="#FFE2A8" stopOpacity="1" />
          <Stop offset="0.35" stopColor={colors.accent} stopOpacity="0.85" />
          <Stop offset="1" stopColor={colors.accent} stopOpacity="0" />
        </RadialGradient>
      </Defs>

      <Ellipse cx={cx} cy={cy} rx={r} ry={r} fill="url(#haze)" />
      <Path d={`M ${start.x} ${start.y} A ${r} ${r} 0 0 1 ${end.x} ${end.y}`} stroke="url(#arc)" strokeWidth={1.4} fill="none" />

      {days.map((d, i) => {
        const p = points[i]!;
        const events = eventsByDay.get(d.date);
        const labelR = r + 13;
        const lp = arcPoint(cx, cy, labelR, i, days.length);
        const anchor = p.deg > 100 ? 'end' : p.deg < 80 ? 'start' : 'middle';
        const label = events?.length && !d.isToday ? events[0]!.name : d.label;
        return (
          <SvgText
            key={d.date}
            x={lp.x}
            y={lp.y + 3}
            fontSize={d.isToday ? 10.5 : 10}
            fontFamily={d.isToday || events?.length ? fonts.semibold : fonts.medium}
            fill={d.isToday ? colors.accent : events?.length ? colors.text : colors.textFaint}
            textAnchor={anchor}
          >
            {label}
          </SvgText>
        );
      })}

      {days.map((d, i) => {
        const p = points[i]!;
        const hasEvent = eventsByDay.has(d.date);
        if (d.isToday) return null;
        return hasEvent ? (
          <Circle key={`e${d.date}`} cx={p.x} cy={p.y} r={4.2} fill={colors.accent} stroke={colors.bg} strokeWidth={1.5} />
        ) : (
          <Circle key={`d${d.date}`} cx={p.x} cy={p.y} r={1.6} fill={colors.textFaint} />
        );
      })}

      <Circle cx={sun.x} cy={sun.y} r={24} fill="url(#sun)" />
      <Circle cx={sun.x} cy={sun.y} r={7.5} fill="#FFD48A" />
    </Svg>
  );
}

export function BalanceBlock({ block }: { block: BalanceBlockT }) {
  const [width, setWidth] = useState(0);
  const data = block.data;
  if (!data) return null;
  const variant = block.variant ?? 'arc';

  if (variant === 'minimal') return <BigAmount value={data.balance} currency={data.currency} size="lg" />;

  if (variant === 'compact') {
    return (
      <View style={{ gap: 4 }}>
        <Text variant="label" color={colors.textMuted}>Main balance</Text>
        <BigAmount value={data.balance} currency={data.currency} size="lg" />
        <Text variant="caption" color={colors.textMuted}>{data.caption}</Text>
      </View>
    );
  }

  const arcHeight = Math.round(width * 0.5);
  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <View style={{ height: Math.max(arcHeight, 190), justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 6 }}>
        {width > 0 && data.week ? <SunArc width={width} data={data} /> : null}
        <Text variant="caption" color={colors.textMuted} style={{ marginBottom: 2 }}>{data.greeting}</Text>
        <BigAmount value={data.balance} currency={data.currency} size="xl" />
        <Text variant="caption" color={colors.textMuted} numberOfLines={1}>{data.caption}</Text>
      </View>
      {data.week ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 18 }}>
          <Text variant="label" color={colors.textMuted}>Ahead this week</Text>
          <Text variant="label" style={{ fontFamily: fonts.semibold }}>Planned {data.week.formattedPlanned}</Text>
        </View>
      ) : null}
    </View>
  );
}
