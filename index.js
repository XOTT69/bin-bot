require('dotenv').config();
const { Telegraf } = require('telegraf');
const http = require('http');

const bot = new Telegraf(process.env.BOT_TOKEN);
const cache = new Map();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function extractBin(text) {
  const raw = text.replace(/^\/bin(?:@\w+)?\s*/i, '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 6) return null;
  return digits.slice(0, 8);
}

async function lookupBin(bin) {
  const now = Date.now();
  const hit = cache.get(bin);
  if (hit && now - hit.ts < CACHE_TTL) return hit.data;

  const res = await fetch(`https://lookup.binlist.net/${bin}`, {
    headers: { 'Accept-Version': '3' }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  cache.set(bin, { ts: now, data });
  return data;
}

function format(bin, d) {
  const flag = d?.country?.alpha2
    ? String.fromCodePoint(...[...d.country.alpha2.toUpperCase()].map(c => 0x1F1E0 - 65 + c.charCodeAt(0)))
    : '';
  return [
    `💳 *BIN:* \`${bin}\``,
    `📌 Scheme: ${d?.scheme ?? '—'}`,
    `🎯 Type: ${d?.type ?? '—'}`,
    `🏷 Brand: ${d?.brand ?? '—'}`,
    `💰 Prepaid: ${d?.prepaid === true ? 'yes' : d?.prepaid === false ? 'no' : '—'}`,
    `🏦 Bank: ${d?.bank?.name ?? '—'}`,
    `🌐 Bank URL: ${d?.bank?.url ?? '—'}`,
    `📞 Phone: ${d?.bank?.phone ?? '—'}`,
    `${flag} Country: ${d?.country?.name ?? '—'} (${d?.country?.alpha2 ?? '—'})`,
  ].join('\n');
}

const reply = async (ctx, text) => {
  const bin = extractBin(text);
  if (!bin) return ctx.reply('Дай мінімум 6 цифр. Приклад: /bin 45717360');
  try {
    const data = await lookupBin(bin);
    if (!data) return ctx.reply('❌ BIN не знайдено');
    return ctx.replyWithMarkdown(format(bin, data));
  } catch {
    return ctx.reply('⚠️ Помилка запиту. Спробуй пізніше.');
  }
};

bot.start(ctx => ctx.reply('Привіт! Відправ /bin 45717360 або просто перші 6–8 цифр картки.'));
bot.command('bin', ctx => reply(ctx, ctx.message.text));
bot.on('text', ctx => {
  if (ctx.message.text.startsWith('/')) return;
  if (/\d{6,}/.test(ctx.message.text)) reply(ctx, ctx.message.text);
});

bot.launch();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// ── Health-check для Render (щоб не вбивав процес) ──
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => res.end('OK')).listen(PORT, () => {
  console.log(`Bot running. Health check on port ${PORT}`);
});
