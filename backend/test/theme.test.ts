import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { auditTheme, buildTheme, contrast, readThemeRequest } from '../src/services/theme.js';
import { setup } from './helpers.js';

let ctx: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  ctx = await setup();
});

const PROMPTS = [
  'dark forest green with gold accents',
  'light pastel pink',
  'white background with white text',
  'black text on a black background',
  'thème clair bleu océan',
  'giza na rangi ya dhahabu',
  'tema oscuro violeta',
  'yellow',
  '#FFFFFF background and #FFFFFF accent',
  'neon #00FF00 on dark',
  'calm and minimal',
];

describe('theme generator', () => {
  it.each(PROMPTS)('"%s" is always readable', (prompt) => {
    const t = buildTheme(readThemeRequest(prompt), prompt);
    const a = auditTheme(t);
    expect(a.text).toBeGreaterThanOrEqual(7);
    expect(a.textMuted).toBeGreaterThanOrEqual(4.5);
    expect(a.textFaint).toBeGreaterThanOrEqual(3);
    expect(a.accent).toBeGreaterThanOrEqual(3);
    expect(a.onAccent).toBeGreaterThanOrEqual(4.5);
    expect(a.onInverse).toBeGreaterThanOrEqual(4.5);
  });

  it('reads mode and colours in several languages', () => {
    expect(readThemeRequest('thème clair bleu').mode).toBe('light');
    expect(readThemeRequest('tema oscuro').mode).toBe('dark');
    const gold = readThemeRequest('dark green with gold accents');
    expect(gold.accentHue).toBeGreaterThan(60);
    expect(gold.accentHue).toBeLessThan(90);
    expect(gold.baseHue).toBe(150);
  });

  it('keeps an explicit accent colour when it is readable', () => {
    const t = buildTheme(readThemeRequest('dark with #5AA9E6'), 'dark with #5AA9E6');
    expect(t.colors.accent).toBe('#5AA9E6');
    expect(contrast(t.colors.accent, t.colors.bg)).toBeGreaterThan(3);
  });

  it('previews, then applies to the user settings', async () => {
    const preview = await request(ctx.app).post('/v1/theme/generate').set(ctx.auth).send({ prompt: 'light ocean blue' });
    expect(preview.status).toBe(200);
    expect(preview.body.theme.mode).toBe('light');
    expect(preview.body.applied).toBe(false);
    expect((await request(ctx.app).get('/v1/me').set(ctx.auth)).body.settings.design.theme).toBeNull();

    await request(ctx.app).post('/v1/theme/generate').set(ctx.auth).send({ prompt: 'light ocean blue', apply: true });
    const me = await request(ctx.app).get('/v1/me').set(ctx.auth);
    expect(me.body.settings.design.theme.colors.bg).toBe(preview.body.theme.colors.bg);

    // Back to the default look.
    await request(ctx.app).patch('/v1/me').set(ctx.auth).send({ settings: { design: { theme: null } } });
    expect((await request(ctx.app).get('/v1/me').set(ctx.auth)).body.settings.design.theme).toBeNull();
  });

  it('translates UI strings (built-in packs work without an AI)', async () => {
    const res = await request(ctx.app).post('/v1/i18n/translate').set(ctx.auth).send({ lang: 'fr', strings: ['From', 'Something unknown'] });
    expect(res.body.translations).toEqual({ From: 'Depuis', 'Something unknown': 'Something unknown' });
  });
});
