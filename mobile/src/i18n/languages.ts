/**
 * Languages offered in the pickers (native names). Any other language works too: the assistant
 * detects it from what the user writes, and the app's texts are translated on demand.
 */
export const LANGUAGES: { code: string; name: string; english: string }[] = [
  { code: 'en', name: 'English', english: 'English' },
  { code: 'fr', name: 'Français', english: 'French' },
  { code: 'sw', name: 'Kiswahili', english: 'Swahili' },
  { code: 'es', name: 'Español', english: 'Spanish' },
  { code: 'pt', name: 'Português', english: 'Portuguese' },
  { code: 'de', name: 'Deutsch', english: 'German' },
  { code: 'it', name: 'Italiano', english: 'Italian' },
  { code: 'nl', name: 'Nederlands', english: 'Dutch' },
  { code: 'ar', name: 'العربية', english: 'Arabic' },
  { code: 'zh', name: '中文', english: 'Chinese' },
  { code: 'ja', name: '日本語', english: 'Japanese' },
  { code: 'ko', name: '한국어', english: 'Korean' },
  { code: 'hi', name: 'हिन्दी', english: 'Hindi' },
  { code: 'bn', name: 'বাংলা', english: 'Bengali' },
  { code: 'ur', name: 'اردو', english: 'Urdu' },
  { code: 'fa', name: 'فارسی', english: 'Persian' },
  { code: 'tr', name: 'Türkçe', english: 'Turkish' },
  { code: 'ru', name: 'Русский', english: 'Russian' },
  { code: 'uk', name: 'Українська', english: 'Ukrainian' },
  { code: 'pl', name: 'Polski', english: 'Polish' },
  { code: 'ro', name: 'Română', english: 'Romanian' },
  { code: 'el', name: 'Ελληνικά', english: 'Greek' },
  { code: 'he', name: 'עברית', english: 'Hebrew' },
  { code: 'id', name: 'Bahasa Indonesia', english: 'Indonesian' },
  { code: 'ms', name: 'Bahasa Melayu', english: 'Malay' },
  { code: 'vi', name: 'Tiếng Việt', english: 'Vietnamese' },
  { code: 'th', name: 'ไทย', english: 'Thai' },
  { code: 'tl', name: 'Filipino', english: 'Filipino' },
  { code: 'am', name: 'አማርኛ', english: 'Amharic' },
  { code: 'yo', name: 'Yorùbá', english: 'Yoruba' },
  { code: 'ig', name: 'Igbo', english: 'Igbo' },
  { code: 'ha', name: 'Hausa', english: 'Hausa' },
  { code: 'zu', name: 'isiZulu', english: 'Zulu' },
  { code: 'xh', name: 'isiXhosa', english: 'Xhosa' },
  { code: 'rw', name: 'Kinyarwanda', english: 'Kinyarwanda' },
  { code: 'ln', name: 'Lingála', english: 'Lingala' },
  { code: 'so', name: 'Soomaali', english: 'Somali' },
  { code: 'lg', name: 'Luganda', english: 'Ganda' },
  { code: 'wo', name: 'Wolof', english: 'Wolof' },
  { code: 'sv', name: 'Svenska', english: 'Swedish' },
  { code: 'da', name: 'Dansk', english: 'Danish' },
  { code: 'no', name: 'Norsk', english: 'Norwegian' },
  { code: 'fi', name: 'Suomi', english: 'Finnish' },
  { code: 'cs', name: 'Čeština', english: 'Czech' },
  { code: 'hu', name: 'Magyar', english: 'Hungarian' },
];

export const languageName = (code: string) => LANGUAGES.find((l) => l.code === code)?.name ?? code.toUpperCase();

/** Right-to-left scripts (text alignment follows). */
export const RTL = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'yi', 'dv', 'ckb', 'sd', 'ug']);
