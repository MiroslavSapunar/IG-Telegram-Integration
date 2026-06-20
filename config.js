// shared configuration: env vars + tuning constants
export const PORT = process.env.PORT || 3000;
export const { VERIFY_TOKEN, META_APP_SECRET, IG_ACCESS_TOKEN, IG_ACCOUNT_ID, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
export const SELFTEST = process.argv.includes('--selftest');

export const WINDOW_MS = 24 * 60 * 60 * 1000, WARN_MS = 6 * 60 * 60 * 1000; // IG 24h reply window; warn under 6h left
export const OPEN_BADGE = '❗';   // name prefix on open/pending topics; removed when /read closes them
