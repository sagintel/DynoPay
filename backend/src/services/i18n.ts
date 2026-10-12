import crypto from 'node:crypto';
import { Translation } from '../db/index.js';
import { logger } from '../lib/logger.js';

/**
 * Language support.
 *  - detectLanguage(): which language a sentence is written in (script + stop-word scoring).
 *  - toEnglishForRules(): rewrites core banking sentences (fr/sw/es/pt) so the on-device rules
 *    understand them; the LLM understands every language natively.
 *  - translateTexts(): server-made texts (confirmations, titles, rejections…) in the user's language:
 *    built-in packs for fr/sw/es, otherwise the LLM, cached per language.
 */

export const BUILT_IN = ['en', 'fr', 'sw', 'es'] as const;
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', fr: 'Français', sw: 'Kiswahili', es: 'Español', pt: 'Português', de: 'Deutsch', it: 'Italiano',
  ar: 'العربية', zh: '中文', ja: '日本語', ko: '한국어', ru: 'Русский', hi: 'हिन्दी', tr: 'Türkçe', nl: 'Nederlands', yo: 'Yorùbá', ha: 'Hausa', am: 'አማርኛ',
};

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'to', 'my', 'and', 'for', 'show', 'send', 'what', 'how', 'much', 'with', 'from', 'card', 'pay', 'is', 'me', 'please'],
  fr: ['le', 'la', 'les', 'des', 'du', 'mon', 'ma', 'mes', 'pour', 'à', 'et', 'envoie', 'envoyer', 'montre', 'carte', 'solde', 'combien', 'avec', 'je', 'veux', 'payer', 'dépenses', 'moi', 'stp', 'mois'],
  sw: ['tuma', 'kwa', 'ya', 'wa', 'na', 'kadi', 'salio', 'nionyeshe', 'onyesha', 'lipa', 'pesa', 'yangu', 'wangu', 'matumizi', 'mwezi', 'huu', 'shilingi', 'tafadhali', 'nataka', 'kutoka', 'ajili', 'mpya', 'zuia', 'futa', 'ngapi', 'kiasi', 'wiki'],
  es: ['el', 'la', 'los', 'las', 'mi', 'mis', 'para', 'y', 'envía', 'enviar', 'envia', 'muestra', 'muéstrame', 'tarjeta', 'saldo', 'cuánto', 'con', 'quiero', 'pagar', 'gastos', 'este', 'mes', 'por', 'favor'],
  pt: ['o', 'os', 'as', 'meu', 'minha', 'para', 'e', 'envie', 'enviar', 'mostre', 'cartão', 'saldo', 'quanto', 'com', 'quero', 'pagar', 'gastos', 'este', 'mês', 'por', 'favor', 'transferir'],
  de: ['der', 'die', 'das', 'mein', 'meine', 'für', 'und', 'sende', 'senden', 'zeige', 'karte', 'kontostand', 'wie', 'viel', 'mit', 'ich', 'möchte', 'bezahlen', 'ausgaben', 'diesen', 'monat', 'an'],
  it: ['il', 'lo', 'gli', 'mio', 'mia', 'per', 'e', 'invia', 'inviare', 'mostra', 'carta', 'saldo', 'quanto', 'con', 'voglio', 'pagare', 'spese', 'questo', 'mese'],
  tr: ['ve', 'bir', 'gönder', 'göster', 'kart', 'bakiye', 'ne', 'kadar', 'ile', 'için', 'harcama', 'bu', 'ay', 'öde'],
  nl: ['de', 'het', 'mijn', 'voor', 'en', 'stuur', 'toon', 'kaart', 'saldo', 'hoeveel', 'met', 'ik', 'wil', 'betalen', 'uitgaven', 'deze', 'maand'],
};

/** ISO 639-3 individual languages whose 2-letter code belongs to their macrolanguage. */
const MACRO: Record<string, string> = {
  swh: 'sw', cmn: 'zh', yue: 'zh', arb: 'ar', ary: 'ar', arz: 'ar', apc: 'ar', zsm: 'ms', ind: 'id', pes: 'fa', prs: 'fa',
  ekk: 'et', lvs: 'lv', plt: 'mg', npi: 'ne', ory: 'or', uzn: 'uz', azj: 'az', khk: 'mn', gaz: 'om', quy: 'qu', ydd: 'yi', nob: 'no', nno: 'no',
};
let iso1: Map<string, string> | null = null;

async function toCode(code3: string): Promise<string> {
  if (MACRO[code3]) return MACRO[code3]!;
  iso1 ??= new Map((await import('iso-639-3')).iso6393.filter((l) => l.iso6391).map((l) => [l.iso6393, l.iso6391!]));
  return iso1.get(code3) ?? code3;
}

/**
 * Any language: script ranges and a precise stop-word scorer first, then franc (400+ languages,
 * offline) for everything else. Returns null when unsure so short inputs never flip the UI.
 */
export async function detectAnyLanguage(text: string): Promise<string | null> {
  const quick = detectLanguage(text);
  if (quick) return quick;
  const t = text.trim();
  if (t.length < 16) return null;
  const { franc } = await import('franc');
  const code3 = franc(t, { minLength: 16 });
  return code3 === 'und' ? null : toCode(code3);
}

/** Returns a language code when reasonably sure, otherwise null (keep the current language). */
export function detectLanguage(text: string): string | null {
  const t = text.trim();
  if (t.length < 4) return null;
  if (/[א-ת]/.test(t)) return 'he';
  // Arabic script: Urdu and Persian have their own letters.
  if (/[ٹڈڑںےھ]/.test(t)) return 'ur';
  if (/[پچژگکی]/.test(t)) return 'fa';
  if (/[؀-ۿ]/.test(t)) return 'ar';
  if (/[Ͱ-Ͽ]/.test(t)) return 'el';
  if (/[฀-๿]/.test(t)) return 'th';
  if (/[Ѐ-ӿ]/.test(t)) return 'ru';
  if (/[ऀ-ॿ]/.test(t)) return 'hi';
  if (/[぀-ヿ]/.test(t)) return 'ja';
  if (/[가-힯]/.test(t)) return 'ko';
  if (/[一-鿿]/.test(t)) return 'zh';
  if (/[ሀ-፿]/.test(t)) return 'am';
  const words = t.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 2) return null;
  let best: string | null = null;
  let bestScore = 0;
  let second = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const score = words.filter((w) => set.has(w)).length;
    if (score > bestScore) {
      second = bestScore;
      bestScore = score;
      best = lang;
    } else if (score > second) second = score;
  }
  // Needs evidence and a margin, so "send 50 to Sara" never flips the UI language.
  return bestScore >= 2 && bestScore > second ? best : bestScore >= 1 && second === 0 && words.length <= 4 ? best : null;
}

// ─── Rule-engine normalisation (fr / sw / es / pt → English keywords) ──────

const PHRASES_TO_EN: Record<string, [RegExp, string][]> = {
  fr: [
    [/\b(envoie|envoies|envoyez|envoyer|vire|virer|transfère|transférer)\b/g, 'send'], [/\b(paie|paye|payer|payez)\b/g, 'pay'],
    [/\bà\b/g, 'to'], [/\bpour\b/g, 'for'], [/\b(mon|ma|mes)\b/g, 'my'], [/\bsolde\b/g, 'balance'], [/\bdépenses?\b/g, 'spending'],
    [/\bcartes?\b/g, 'card'], [/\bnouvelle\b/g, 'new'], [/\b(crée|créer)\b/g, 'create'], [/\b(gèle|geler|bloque|bloquer)\b/g, 'freeze'],
    [/\b(dégèle|dégeler|débloque|débloquer)\b/g, 'unfreeze'], [/\b(supprime|supprimer|efface)\b/g, 'delete'], [/\b(montre|montre-moi|affiche)\b/g, 'show'],
    [/\btransactions?\b/g, 'transactions'], [/\bce mois\b/g, 'this month'], [/\bcette semaine\b/g, 'this week'], [/\b(recharge|recharger)\b/g, 'top up'],
    [/\b(dépose|déposer|ajoute|ajouter)\b/g, 'add'], [/\bsur\b/g, 'on'], [/\bcontacts?\b/g, 'contacts'], [/\bdemande\b/g, 'request'], [/\bde\b/g, 'from'],
  ],
  sw: [
    [/\b(tuma|tumia pesa|hamisha)\b/g, 'send'], [/\blipa\b/g, 'pay'], [/\bkwa ajili ya\b/g, 'for'], [/\bkwa\b/g, 'to'],
    [/\b(yangu|wangu|zangu)\b/g, 'my'], [/\bsalio\b/g, 'balance'], [/\bmatumizi\b/g, 'spending'], [/\bkadi\b/g, 'card'], [/\bmpya\b/g, 'new'],
    [/\b(tengeneza|unda)\b/g, 'create'], [/\b(zuia|funga)\b/g, 'freeze'], [/\bfungua\b/g, 'unfreeze'], [/\bfuta\b/g, 'delete'],
    [/\b(nionyeshe|onyesha)\b/g, 'show'], [/\bmiamala\b/g, 'transactions'], [/\bmwezi huu\b/g, 'this month'], [/\bwiki hii\b/g, 'this week'],
    [/\b(ongeza pesa|weka pesa)\b/g, 'add'], [/\bweka\b/g, 'add'], [/\bkwenye\b/g, 'to'], [/\bomba\b/g, 'request'], [/\bkutoka\b/g, 'from'], [/\bwatu\b/g, 'contacts'],
  ],
  es: [
    [/\b(envía|envia|enviar|manda|mandar|transfiere|transferir)\b/g, 'send'], [/\b(paga|pagar)\b/g, 'pay'], [/\bpara\b/g, 'for'], [/\ba\b/g, 'to'],
    [/\b(mi|mis)\b/g, 'my'], [/\bsaldo\b/g, 'balance'], [/\bgastos\b/g, 'spending'], [/\btarjetas?\b/g, 'card'], [/\bnueva\b/g, 'new'],
    [/\b(crea|crear)\b/g, 'create'], [/\b(congela|congelar|bloquea|bloquear)\b/g, 'freeze'], [/\b(descongela|desbloquea)\b/g, 'unfreeze'],
    [/\b(borra|borrar|elimina|eliminar)\b/g, 'delete'], [/\b(muestra|muéstrame|enseña)\b/g, 'show'], [/\btransacciones\b/g, 'transactions'],
    [/\beste mes\b/g, 'this month'], [/\besta semana\b/g, 'this week'], [/\b(recarga|recargar)\b/g, 'top up'], [/\b(deposita|depositar|añade)\b/g, 'add'],
    [/\ben\b/g, 'on'], [/\bpide\b/g, 'request'], [/\bde\b/g, 'from'],
  ],
  ar: [
    [/\b(أرسل|ارسل|إرسال|ابعث|حوّل|حول)\b/g, 'send'], [/\b(ادفع|إدفع)\b/g, 'pay'], [/\b(إلى|الى)\b/g, 'to'], [/\b(من أجل|مقابل|لأجل)\b/g, 'for'],
    [/\b(رصيدي|رصيد|الرصيد)\b/g, 'balance'], [/\b(بطاقتي|بطاقة|البطاقة|بطاقاتي)\b/g, 'card'], [/\b(جمّد|جمد|أوقف)\b/g, 'freeze'],
    [/\b(اعرض|أظهر|أرني|ارني)\b/g, 'show'], [/\b(معاملاتي|المعاملات|معاملات)\b/g, 'transactions'], [/\b(إنفاقي|مصاريفي|الإنفاق)\b/g, 'spending'],
    [/\b(اشحن|اشحن رصيدي)\b/g, 'top up'], [/\b(أضف|ضع)\b/g, 'add'], [/\b(احذف|امسح)\b/g, 'delete'], [/\b(اطلب)\b/g, 'request'],
    [/\b(الثانية|الثاني)\b/g, 'second'], [/\b(الأولى|الأول)\b/g, 'first'], [/\b(على)\b/g, 'on'], [/\b(من)\b/g, 'from'], [/\b(جديدة|جديد)\b/g, 'new'],
  ],
  he: [
    [/\b(שלח|תשלח|העבר)\b/g, 'send'], [/\b(שלם|תשלם)\b/g, 'pay'], [/\b(עבור)\b/g, 'for'], [/\b(יתרה|היתרה)\b/g, 'balance'],
    [/\b(כרטיס|הכרטיס)\b/g, 'card'], [/\b(הקפא)\b/g, 'freeze'], [/\b(הראה|תראה)\b/g, 'show'],
  ],
  pt: [
    [/\b(envie|enviar|manda|mandar|transfira|transferir)\b/g, 'send'], [/\b(pague|pagar)\b/g, 'pay'], [/\bpara\b/g, 'to'], [/\b(meu|minha|meus|minhas)\b/g, 'my'],
    [/\bsaldo\b/g, 'balance'], [/\bgastos\b/g, 'spending'], [/\bcartão\b/g, 'card'], [/\b(mostre|mostra)\b/g, 'show'], [/\beste mês\b/g, 'this month'],
  ],
};

/** `\b` ignores accented letters (é, à…), so word boundaries are rebuilt with Unicode lookarounds. */
const unicodeWord = (re: RegExp) =>
  new RegExp(`(?<![\\p{L}\\d])(?:${re.source.replace(/^\\b/, '').replace(/\\b$/, '')})(?![\\p{L}\\d])`, 'gu');
const COMPILED = Object.fromEntries(Object.entries(PHRASES_TO_EN).map(([lang, rules]) => [lang, rules.map(([re, en]) => [unicodeWord(re), en] as const)]));

/** Arabic-Indic and Persian digits → 0-9 (amounts are read the same in every script). */
const toAsciiDigits = (t: string) => t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0)).replace(/٫/g, '.');

export function toEnglishForRules(text: string, lang: string | null): string {
  const rules = lang ? COMPILED[lang] : undefined;
  if (!rules) return toAsciiDigits(text);
  let out = ` ${toAsciiDigits(text).toLowerCase()} `;
  // Arabic and Hebrew attach "to" (ل / ל) to the name: "لسارة" → "to سارة".
  if (lang === 'ar') out = out.replace(/(\s)ل(?=\p{L}{2})/gu, '$1to ');
  if (lang === 'he') out = out.replace(/(\s)ל(?=\p{L}{2})/gu, '$1to ');
  for (const [re, en] of rules) out = out.replace(re, en);
  return out.replace(/\s+/g, ' ').trim();
}

// ─── Server-text packs ─────────────────────────────────────────────────────

/** [English, French, Swahili, Spanish]. `{x}` is a placeholder kept as-is (names, amounts). */
const PACK: [string, string, string, string][] = [
  ['From', 'Depuis', 'Kutoka', 'Desde'],
  ['Main account · {x}', 'Compte principal · {x}', 'Akaunti kuu · {x}', 'Cuenta principal · {x}'],
  ['Arrives', 'Arrivée', 'Inafika', 'Llega'],
  ['In seconds', 'En quelques secondes', 'Kwa sekunde chache', 'En segundos'],
  ['Minutes, via PayPal', 'Quelques minutes, via PayPal', 'Dakika chache, kupitia PayPal', 'Minutos, vía PayPal'],
  ['Fee', 'Frais', 'Ada', 'Comisión'],
  ['None', 'Aucun', 'Hakuna', 'Ninguno'],
  ['Note', 'Note', 'Maelezo', 'Nota'],
  ['Hold to send', 'Maintenir pour envoyer', 'Bonyeza kwa muda kutuma', 'Mantén para enviar'],
  ['Send to {x}', 'Envoyer à {x}', 'Tuma kwa {x}', 'Enviar a {x}'],
  ['Top up from PayPal', 'Recharger depuis PayPal', 'Ongeza pesa kutoka PayPal', 'Recargar desde PayPal'],
  ['To', 'Vers', 'Kwenda', 'A'],
  ['Paid with', 'Payé avec', 'Imelipwa kwa', 'Pagado con'],
  ['Your PayPal account', 'Votre compte PayPal', 'Akaunti yako ya PayPal', 'Tu cuenta PayPal'],
  ['Continue to PayPal', 'Continuer vers PayPal', 'Endelea kwenda PayPal', 'Continuar a PayPal'],
  ['Main account', 'Compte principal', 'Akaunti kuu', 'Cuenta principal'],
  ['New virtual card', 'Nouvelle carte virtuelle', 'Kadi mpya ya mtandaoni', 'Nueva tarjeta virtual'],
  ['Name', 'Nom', 'Jina', 'Nombre'],
  ['Color', 'Couleur', 'Rangi', 'Color'],
  ['Monthly limit', 'Plafond mensuel', 'Kikomo cha mwezi', 'Límite mensual'],
  ['Price', 'Prix', 'Bei', 'Precio'],
  ['Free', 'Gratuit', 'Bure', 'Gratis'],
  ['Create card', 'Créer la carte', 'Tengeneza kadi', 'Crear tarjeta'],
  ['Add to {x}', 'Ajouter à {x}', 'Ongeza kwenye {x}', 'Añadir a {x}'],
  ['Card balance after', 'Solde de la carte après', 'Salio la kadi baadaye', 'Saldo de la tarjeta después'],
  ['Hold to move', 'Maintenir pour transférer', 'Bonyeza kwa muda kuhamisha', 'Mantén para mover'],
  ['Move from {x}', 'Retirer de {x}', 'Hamisha kutoka {x}', 'Mover desde {x}'],
  ['Move money', 'Transférer', 'Hamisha pesa', 'Mover dinero'],
  ['Unfreeze {x}', 'Dégeler {x}', 'Fungua {x}', 'Descongelar {x}'],
  ['Card', 'Carte', 'Kadi', 'Tarjeta'],
  ['Status after', 'Statut après', 'Hali baadaye', 'Estado después'],
  ['Active', 'Active', 'Inatumika', 'Activa'],
  ['Unfreeze', 'Dégeler', 'Fungua', 'Descongelar'],
  ['Close {x}?', 'Fermer {x} ?', 'Funga {x}?', '¿Cerrar {x}?'],
  ['Returned to main account', 'Rendu au compte principal', 'Inarudishwa kwenye akaunti kuu', 'Devuelto a la cuenta principal'],
  ['This cannot be undone', 'Action irréversible', 'Hii haiwezi kutenduliwa', 'No se puede deshacer'],
  ['Close card', 'Fermer la carte', 'Funga kadi', 'Cerrar tarjeta'],
  ['Delete {x}?', 'Supprimer {x} ?', 'Futa {x}?', '¿Eliminar {x}?'],
  ['Past transactions', 'Transactions passées', 'Miamala ya zamani', 'Transacciones pasadas'],
  ['Kept', 'Conservées', 'Zinabaki', 'Se conservan'],
  ['Delete', 'Supprimer', 'Futa', 'Eliminar'],
  ['Every week to {x}', 'Chaque semaine à {x}', 'Kila wiki kwa {x}', 'Cada semana a {x}'],
  ['Every month to {x}', 'Chaque mois à {x}', 'Kila mwezi kwa {x}', 'Cada mes a {x}'],
  ['First payment', 'Premier paiement', 'Malipo ya kwanza', 'Primer pago'],
  ['Tomorrow', 'Demain', 'Kesho', 'Mañana'],
  ['Repeats', 'Répétition', 'Inarudiwa', 'Se repite'],
  ['Weekly', 'Chaque semaine', 'Kila wiki', 'Semanal'],
  ['Monthly', 'Chaque mois', 'Kila mwezi', 'Mensual'],
  ['Hold to schedule', 'Maintenir pour programmer', 'Bonyeza kwa muda kupanga', 'Mantén para programar'],
  ['Amount', 'Montant', 'Kiasi', 'Importe'],
  ['Next run', 'Prochain paiement', 'Malipo yajayo', 'Próximo pago'],
  ['Stop payments', 'Arrêter les paiements', 'Simamisha malipo', 'Detener pagos'],
  ['Split the bill', "Partager l'addition", 'Gawanya bili', 'Dividir la cuenta'],
  ['Request money', "Demander de l'argent", 'Omba pesa', 'Pedir dinero'],
  ['For', 'Pour', 'Kwa ajili ya', 'Para'],
  ['Send request', 'Envoyer la demande', 'Tuma ombi', 'Enviar solicitud'],
  ['Pay {x}', 'Payer {x}', 'Lipa {x}', 'Pagar {x}'],
  ['Hold to pay', 'Maintenir pour payer', 'Bonyeza kwa muda kulipa', 'Mantén para pagar'],
  ['Freeze {x}?', 'Geler {x} ?', 'Zuia {x}?', '¿Congelar {x}?'],
  ['Payments', 'Paiements', 'Malipo', 'Pagos'],
  ['Blocked until you unfreeze', "Bloqués jusqu'au dégel", 'Imezuiwa hadi uifungue', 'Bloqueados hasta descongelar'],
  ['Freeze card', 'Geler la carte', 'Zuia kadi', 'Congelar tarjeta'],
  ['Update {x}', 'Modifier {x}', 'Badilisha {x}', 'Actualizar {x}'],
  ['Save changes', 'Enregistrer', 'Hifadhi mabadiliko', 'Guardar cambios'],
  ['Add {x}', 'Ajouter {x}', 'Ongeza {x}', 'Añadir {x}'],
  ['Email', 'E-mail', 'Barua pepe', 'Correo'],
  ['Handle', 'Identifiant', 'Jina la mtumiaji', 'Usuario'],
  ['Add contact', 'Ajouter le contact', 'Ongeza mwasiliani', 'Añadir contacto'],
  ['Save', 'Enregistrer', 'Hifadhi', 'Guardar'],
  ['Favorite', 'Favori', 'Pendwa', 'Favorito'],
  ['Yes', 'Oui', 'Ndiyo', 'Sí'],
  ['No', 'Non', 'Hapana', 'No'],
  ['Update your settings', 'Modifier vos réglages', 'Badilisha mipangilio yako', 'Actualizar tus ajustes'],
  ['Save settings', 'Enregistrer les réglages', 'Hifadhi mipangilio', 'Guardar ajustes'],
  ['Decline this request?', 'Refuser cette demande ?', 'Kataa ombi hili?', '¿Rechazar esta solicitud?'],
  ['The requester is notified', 'Le demandeur est prévenu', 'Muombaji anajulishwa', 'Se avisa al solicitante'],
  ['Decline', 'Refuser', 'Kataa', 'Rechazar'],
  ['Cancel your request?', 'Annuler votre demande ?', 'Ghairi ombi lako?', '¿Cancelar tu solicitud?'],
  ['Cancel request', 'Annuler la demande', 'Ghairi ombi', 'Cancelar solicitud'],
  ['Apply layout', 'Appliquer la mise en page', 'Tumia mpangilio', 'Aplicar diseño'],
  ['Restore the original layout?', "Restaurer la mise en page d'origine ?", 'Rudisha mpangilio wa awali?', '¿Restaurar el diseño original?'],
  ['Restore', 'Restaurer', 'Rudisha', 'Restaurar'],
  ['By category', 'Par catégorie', 'Kwa kundi', 'Por categoría'],
  ['Day by day', 'Jour par jour', 'Siku kwa siku', 'Día a día'],
  ['Spending', 'Dépenses', 'Matumizi', 'Gastos'],
  ['Income', 'Revenus', 'Mapato', 'Ingresos'],
  ['Money in vs out', 'Entrées et sorties', 'Pesa iliyoingia na kutoka', 'Entradas y salidas'],
  ['In vs out', 'Entrées / sorties', 'Ndani / nje', 'Entradas / salidas'],
  ['Daily intensity', 'Intensité par jour', 'Ukubwa kwa siku', 'Intensidad diaria'],
  ['Trend', 'Tendance', 'Mwenendo', 'Tendencia'],
  ['Over time', 'Dans le temps', 'Kwa muda', 'En el tiempo'],
  ['Share', 'Répartition', 'Mgawanyo', 'Reparto'],
  ['Breakdown', 'Détail', 'Mchanganuo', 'Desglose'],
  ['Top categories', 'Catégories principales', 'Makundi makuu', 'Categorías principales'],
  ['Top people', 'Personnes principales', 'Watu wakuu', 'Personas principales'],
  ['By person', 'Par personne', 'Kwa mtu', 'Por persona'],
  ['{x} vs budget', '{x} vs budget', '{x} dhidi ya bajeti', '{x} vs presupuesto'],
  ['Activity', 'Activité', 'Shughuli', 'Actividad'],
  ['With {x}', 'Avec {x}', 'Na {x}', 'Con {x}'],
  ['People', 'Personnes', 'Watu', 'Personas'],
  ['Card activity', 'Activité de la carte', 'Shughuli za kadi', 'Actividad de la tarjeta'],
  ['No card payments yet', 'Aucun paiement par carte', 'Bado hakuna malipo ya kadi', 'Aún no hay pagos con tarjeta'],
  ['Nothing found', 'Aucun résultat', 'Hakuna kilichopatikana', 'Sin resultados'],
  ['Recent', 'Récents', 'Hivi karibuni', 'Recientes'],
  ['Your people', 'Vos contacts', 'Watu wako', 'Tus contactos'],
  ["I'm not sure what you meant yet.", "Je n'ai pas encore compris.", 'Bado sijaelewa ulichomaanisha.', 'Aún no entiendo lo que quieres.'],
  ['Try “Send 50 to Sara for dinner”, “Show my spending this month”, or “Create a travel card”.', 'Essayez « Envoie 50 à Sara pour le dîner », « Montre mes dépenses ce mois » ou « Crée une carte voyage ».', 'Jaribu “Tuma 50 kwa Sara kwa ajili ya chakula”, “Nionyeshe matumizi mwezi huu” au “Tengeneza kadi ya safari”.', 'Prueba «Envía 50 a Sara para la cena», «Muestra mis gastos este mes» o «Crea una tarjeta de viaje».'],
  ['Send', 'Envoyer', 'Tuma', 'Enviar'],
  ['Top up', 'Recharger', 'Ongeza pesa', 'Recargar'],
  ['Insights', 'Analyses', 'Takwimu', 'Análisis'],
  ['Split', 'Partager', 'Gawanya', 'Dividir'],
  ['Cards', 'Cartes', 'Kadi', 'Tarjetas'],
  ['New card', 'Nouvelle carte', 'Kadi mpya', 'Nueva tarjeta'],
  ['Card spending', 'Dépenses carte', 'Matumizi ya kadi', 'Gastos con tarjeta'],
  ['All cards', 'Toutes les cartes', 'Kadi zote', 'Todas las tarjetas'],
  ['No cards yet', 'Pas encore de carte', 'Bado huna kadi', 'Aún no hay tarjetas'],
  ['Create one with “Create a card”.', 'Créez-en une avec « Crée une carte ».', 'Tengeneza moja kwa “Tengeneza kadi”.', 'Crea una con «Crea una tarjeta».'],
  ['Ready to schedule. Hold to confirm.', 'Prêt à programmer. Maintenez pour confirmer.', 'Tayari kupanga. Bonyeza kwa muda kuthibitisha.', 'Listo para programar. Mantén para confirmar.'],
  ['You will approve it in PayPal.', 'Vous validerez dans PayPal.', 'Utaidhinisha kwenye PayPal.', 'Lo aprobarás en PayPal.'],
  ['Who should receive it?', 'Qui doit le recevoir ?', 'Nani apokee?', '¿Quién debe recibirlo?'],
  ['Who should receive {x}?', 'Qui doit recevoir {x} ?', 'Nani apokee {x}?', '¿Quién debe recibir {x}?'],
  ['Which card?', 'Quelle carte ?', 'Kadi ipi?', '¿Qué tarjeta?'],
  ['Choose the card to fund', 'Choisissez la carte à alimenter', 'Chagua kadi ya kuongezea pesa', 'Elige la tarjeta a recargar'],
  ['Choose what to delete', 'Choisissez quoi supprimer', 'Chagua cha kufuta', 'Elige qué eliminar'],
  ['Choose the payment to stop', 'Choisissez le paiement à arrêter', 'Chagua malipo ya kusimamisha', 'Elige el pago a detener'],
  ['Continue', 'Continuer', 'Endelea', 'Continuar'],
  ['Frozen', 'Gelée', 'Imezuiwa', 'Congelada'],
  ['Already frozen', 'Déjà gelée', 'Tayari imezuiwa', 'Ya congelada'],
  ['Not frozen', 'Pas gelée', 'Haijazuiwa', 'No congelada'],
  ['Only {x} on this card', 'Seulement {x} sur cette carte', '{x} pekee kwenye kadi hii', 'Solo {x} en esta tarjeta'],
  ['New PayPal recipient', 'Nouveau destinataire PayPal', 'Mpokeaji mpya wa PayPal', 'Nuevo destinatario PayPal'],
  ['DynoPay account', 'Compte DynoPay', 'Akaunti ya DynoPay', 'Cuenta DynoPay'],
];

const placeholderRe = (en: string) => new RegExp(`^${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{x\\}', '(.+)')}$`);
const INDEX: Record<string, number> = { fr: 1, sw: 2, es: 3 };
const EXACT = new Map(PACK.filter(([en]) => !en.includes('{x}')).map((row) => [row[0], row]));
const PATTERNS = PACK.filter(([en]) => en.includes('{x}')).map((row) => ({ re: placeholderRe(row[0]), row }));

/** Built-in translation (exact phrase or placeholder pattern); null when unknown. */
function packTranslate(text: string, lang: string): string | null {
  const i = INDEX[lang];
  if (!i) return null;
  const exact = EXACT.get(text);
  if (exact) return exact[i]!;
  for (const { re, row } of PATTERNS) {
    const m = text.match(re);
    if (m) return row[i]!.replace('{x}', m[1]!);
  }
  return null;
}

export type Translator = (texts: string[], lang: string) => Promise<Record<string, string>>;

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 40);

/**
 * Translates English texts into `lang`: built-in pack → DB cache → `llm` (optional) → unchanged.
 * Never throws; a translation failure just leaves English.
 */
export async function translateTexts(texts: string[], lang: string, llm?: Translator): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!lang || lang === 'en') return out;
  const unique = [...new Set(texts.filter((t) => t && /\p{L}/u.test(t)))];
  const missing: string[] = [];
  for (const t of unique) {
    const p = packTranslate(t, lang);
    if (p) out.set(t, p);
    else missing.push(t);
  }
  if (!missing.length) return out;
  try {
    const cached = await Translation.findAll({ where: { lang, sourceHash: missing.map(hash) } });
    const byHash = new Map(cached.map((c) => [c.sourceHash, c.text]));
    const stillMissing: string[] = [];
    for (const t of missing) {
      const c = byHash.get(hash(t));
      if (c) out.set(t, c);
      else stillMissing.push(t);
    }
    if (stillMissing.length && llm) {
      const fresh = await llm(stillMissing.slice(0, 200), lang);
      const rows = Object.entries(fresh).filter(([src, tr]) => stillMissing.includes(src) && typeof tr === 'string' && tr.trim());
      for (const [src, tr] of rows) out.set(src, tr);
      if (rows.length) {
        await Translation.bulkCreate(rows.map(([src, tr]) => ({ lang, sourceHash: hash(src), source: src.slice(0, 1000), text: tr.slice(0, 2000) })), { ignoreDuplicates: true });
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, lang }, 'translation failed; keeping English');
  }
  return out;
}
