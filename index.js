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
const CACHE_TTL = 24 * 60 * 60 * 1000; // Кешування на 1 день

// --- Словники для перекладу ---
const tr = {
  types: { debit: 'Дебетова', credit: 'Кредитна', charge: 'Charge', prepaid: 'Передплачена' },
  schemes: { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', jcb: 'JCB', unionpay: 'UnionPay' },
  yesNo: { true: 'Так', false: 'Ні' }
};

// Функція перекладу країн (UA -> Україна)
const getCountryName = (code) => {
  if (!code) return '—';
  try { return new Intl.DisplayNames(['uk'], { type: 'region' }).of(code); } 
  catch (e) { return code; }
};

// --- Витягування BIN з тексту ---
function extractBin(text) {
  if (!text) return null;
  const raw = text.replace(/^\/bin(?:@\w+)?\s*/i, '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6) return null;
  return digits.slice(0, 8); 
}

// --- Послідовний запит до 3-х різних API ---
async function lookupBin(bin) {
  const now = Date.now();
  const hit = cache.get(bin);
  if (hit && now - hit.ts < CACHE_TTL) return hit.data;

  let resultData = null;

  // АПІ №1: binlist.net
  try {
    const res = await fetch(`https://lookup.binlist.net/${bin}`, { headers: { 'Accept-Version': '3' } });
    if (res.ok) {
      resultData = await res.json();
      console.log('API 1 (binlist.net) OK');
    }
  } catch (e) {
    console.log('API 1 Fail');
  }

  // АПІ №2: freebinchecker.com
  if (!resultData || Object.keys(resultData).length === 0) {
    try {
      const res = await fetch(`https://api.freebinchecker.com/bin/${bin}`);
      if (res.ok) {
        const raw = await res.json();
        // Перевіряємо, чи дійсно є дані, а не просто заглушка
        if (raw.valid && (raw.card || raw.issuer || raw.country)) {
          resultData = {
            scheme: raw.card?.scheme || raw.scheme,
            type: raw.card?.type || raw.type,
            brand: raw.card?.category || raw.brand,
            prepaid: raw.card?.prepaid || raw.prepaid,
            country: { name: raw.country?.name, alpha2: raw.country?.alpha2 },
            bank: { name: raw.issuer?.name || raw.bank?.name, url: raw.issuer?.url || raw.bank?.url, phone: raw.issuer?.phone || raw.bank?.phone }
          };
          console.log('API 2 (freebinchecker) OK');
        }
      }
    } catch (e) {
      console.log('API 2 Fail');
    }
  }

  // АПІ №3: bininfo.io
  if (!resultData || Object.keys(resultData).length === 0) {
    try {
      const res = await fetch(`https://bininfo.io/bin/${bin}`);
      if (res.ok) {
        const raw = await res.json();
        // Перевіряємо, чи повернулася валідна схема або банк
        if (raw.bin && (raw.scheme || raw.bank_name || raw.country_code)) {
          resultData = {
            scheme: raw.scheme,
            type: raw.type,
            brand: raw.brand,
            prepaid: raw.prepaid === 'Yes' ? true : (raw.prepaid === 'No' ? false : null),
            country: { name: raw.country_name, alpha2: raw.country_code },
            bank: { name: raw.bank_name, url: raw.bank_url, phone: raw.bank_phone }
          };
          console.log('API 3 (bininfo) OK');
        }
      }
    } catch (e) {
      console.error('API 3 Fail');
    }
  }

  // Якщо всі 3 API відпрацювали, але даних так і немає:
  if (!resultData || Object.keys(resultData).length === 0 || (!resultData.scheme && !resultData.bank)) {
    // НЕ зберігаємо в кеш, щоб при наступному запиті бот спробував ще раз
    return null; 
  }

  // Якщо дані є - зберігаємо в пам'ять
  cache.set(bin, { ts: now, data: resultData });
  return resultData;
}

// --- Форматування відповіді ---
function format(bin, d) {
  const flag = d?.country?.alpha2
    ? String.fromCodePoint(...[...d.country.alpha2.toUpperCase()].map(c => 0x1F1E0 - 65 + c.charCodeAt(0)))
    : '';

  const scheme = tr.schemes[d?.scheme?.toLowerCase()] || d?.scheme || '—';
  const type = tr.types[d?.type?.toLowerCase()] || d?.type || '—';
  const brand = d?.brand || '—';
  const isPrepaid = tr.yesNo[d?.prepaid] || '—';
  
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
    if (!data) return ctx.reply('❌ BIN не знайдено в базі даних (або ліміти всіх API вичерпано).');
    return ctx.replyWithMarkdown(format(bin, data));
  } catch (error) {
    return ctx.reply('⚠️ Помилка з\'єднання з серверами. Спробуйте пізніше.');
  }
};

// --- Команди бота ---
bot.start(ctx => ctx.reply('Привіт! 👋\nВідправ мені номер картки (або перші 6-8 цифр), і я покажу інформацію про неї.'));
bot.help(ctx => ctx.reply('Просто напиши в чат цифри BIN (наприклад: 537541). Або використовуй команду /bin 537541.'));

bot.command('bin', ctx => replyToUser(ctx, ctx.message.text));

bot.on('text', ctx => {
  if (ctx.message.text.startsWith('/')) return; 
  if (/(?:\d[ -]*?){6,}/.test(ctx.message.text)) {
    replyToUser(ctx, ctx.message.text);
  }
});

// Запуск бота
bot.launch().then(() => console.log('🤖 Бот успішно запущений!'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// Health-check для Render
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('Bot is running OK')).listen(PORT, () => {
  console.log(`🌐 Health check server is listening on port ${PORT}`);
});
