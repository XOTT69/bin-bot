require('dotenv').config();
const { Telegraf } = require('telegraf');
const http = require('http');

// Перевірка наявності токена
if (!process.env.BOT_TOKEN) {
  console.error('Помилка: Не знайдено BOT_TOKEN.');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000; // Кешування результатів на 1 день

// --- Словники для перекладу ---
const tr = {
  types: {
    debit: 'Дебетова',
    credit: 'Кредитна',
    charge: 'Charge',
    prepaid: 'Передплачена'
  },
  schemes: {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'American Express',
    discover: 'Discover',
    jcb: 'JCB',
    unionpay: 'UnionPay'
  },
  yesNo: {
    true: 'Так',
    false: 'Ні'
  }
};

// Функція перекладу країн (UA -> Україна)
const getCountryName = (code) => {
  if (!code) return '—';
  try {
    return new Intl.DisplayNames(['uk'], { type: 'region' }).of(code);
  } catch (e) {
    return code; 
  }
};

// --- Основна логіка витягування BIN ---
function extractBin(text) {
  if (!text) return null;
  // Видаляємо команду /bin якщо вона є
  const raw = text.replace(/^\/bin(?:@\w+)?\s*/i, '');
  // Залишаємо тільки цифри
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6) return null;
  return digits.slice(0, 8); // Беремо максимум перші 8 цифр
}

// --- Запит до API ---
async function lookupBin(bin) {
  const now = Date.now();
  const hit = cache.get(bin);
  if (hit && now - hit.ts < CACHE_TTL) return hit.data;

  const res = await fetch(`https://lookup.binlist.net/${bin}`, {
    headers: { 'Accept-Version': '3' }
  });
  
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
  
  const data = await res.json();
  cache.set(bin, { ts: now, data }); // Зберігаємо в пам'ять
  return data;
}

// --- Форматування відповіді (українською) ---
function format(bin, d) {
  // Конвертуємо код країни у емодзі прапора
  const flag = d?.country?.alpha2
    ? String.fromCodePoint(...[...d.country.alpha2.toUpperCase()].map(c => 0x1F1E0 - 65 + c.charCodeAt(0)))
    : '';

  const scheme = tr.schemes[d?.scheme] || d?.scheme || '—';
  const type = tr.types[d?.type] || d?.type || '—';
  const brand = d?.brand || '—';
  const isPrepaid = tr.yesNo[d?.prepaid] || '—';
  
  // Дані банку (якщо є в базі API)
  const bankName = d?.bank?.name || '—';
  const bankUrl = d?.bank?.url || '—';
  const bankPhone = d?.bank?.phone || '—'; 
  
  const countryName = getCountryName(d?.country?.alpha2);
  const countryCode = d?.country?.alpha2 || '—';

  return [
    `💳 *BIN:* \`${bin}\``,
    `📌 *Система:* ${scheme}`,
    `🎯 *Тип:* ${type}`,
    `🏷 *Бренд:* ${brand}`,
    `💰 *Prepaid:* ${isPrepaid}`,
    `🏦 *Банк:* ${bankName}`,
    `🌐 *Сайт:* ${bankUrl}`,
    `📞 *Телефон:* ${bankPhone}`,
    `${flag} *Країна:* ${countryName} (${countryCode})`,
  ].join('\n');
}

// --- Обробник повідомлень ---
const replyToUser = async (ctx, text) => {
  const bin = extractBin(text);
  if (!bin) return ctx.reply('⚠️ Введіть мінімум 6 цифр. Приклад: 45717360');
  
  try {
    const data = await lookupBin(bin);
    if (!data) return ctx.reply('❌ BIN не знайдено в базі даних.');
    return ctx.replyWithMarkdown(format(bin, data));
  } catch (error) {
    return ctx.reply('⚠️ Помилка з\'єднання з сервером. Спробуйте пізніше.');
  }
};

// --- Команди бота ---
bot.start(ctx => ctx.reply('Привіт! 👋\nВідправ мені номер картки (або перші 6-8 цифр), і я покажу інформацію про неї.'));
bot.help(ctx => ctx.reply('Просто напиши в чат цифри BIN (наприклад: 537541). Або використовуй команду /bin 537541.'));

bot.command('bin', ctx => replyToUser(ctx, ctx.message.text));

// Реакція на звичайний текст (якщо це цифри)
bot.on('text', ctx => {
  if (ctx.message.text.startsWith('/')) return; // ігноруємо інші команди
  // Якщо в тексті є 6 або більше цифр підряд (з пробілами чи без)
  if (/(?:\d[ -]*?){6,}/.test(ctx.message.text)) {
    replyToUser(ctx, ctx.message.text);
  }
});

// Запуск бота
bot.launch().then(() => console.log('🤖 Бот успішно запущений!'));

// Безпечне вимкнення
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ── Health-check сервер для Render (щоб не вибивало помилку) ──
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot is running OK')).listen(PORT, () => {
  console.log(`🌐 Health check server is listening on port ${PORT}`);
});
