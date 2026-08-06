/**
 * hvmi-quantum — отдельный воркер страницы Quantum Rating.
 * Основной сайт (hvmi-site) не затрагивает: свой репозиторный каталог, свой конфиг.
 *
 * Маршруты:
 *   GET /api/px?t=TICK    — дневные цены и объёмы за 10 лет (Yahoo)
 *   GET /api/fund?t=TICK  — отчётность из XBRL (EDGAR), обрезанная до нужных статей
 *
 * Обрезка ответа EDGAR делается здесь сознательно: companyfacts весит 3–6 МБ,
 * в браузер уходит около 40 КБ.
 */

const CIK = {
  NVDA: '0001045810', MSFT: '0000789019', COST: '0000909832', PGR: '0000080661',
  DE:   '0000315189', ANET: '0001596532', CMG:  '0001058090', DECK: '0000910521'
};

/* EDGAR отвечает только на запросы с контактом в User-Agent */
const UA_SEC = 'HVMI Research (research@hvmiresearch.com)';
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* Статьи отчётности. Порядок = порядок попыток: разные эмитенты называют
   выручку по-разному, берём первую найденную. */
const TAGS = {
  eps: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
  rev: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues',
        'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'],
  ni:  ['NetIncomeLoss'],
  /* Операционный денежный поток — для проверки, подтверждена ли прибыль деньгами. */
  cfo: ['NetCashProvidedByUsedInOperatingActivities',
        'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  eq:  ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']
};

const TTL = { px: 3600, fund: 86400 };   /* цены — час, отчётность — сутки */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === '/' || url.pathname === '') {
      return Response.redirect(new URL('/quantum.html', url).toString(), 302);
    }
    if (url.pathname === '/api/px')   return cached(req, ctx, TTL.px,   () => prices(url));
    if (url.pathname === '/api/fund') return cached(req, ctx, TTL.fund, () => fundamentals(url));
    if (url.pathname === '/api/tickers') return json({ tickers: Object.keys(CIK) }, 86400);

    return new Response('Not found', { status: 404 });
  }
};

/* ── общая обвязка ──────────────────────────────────────────────── */

function json(obj, ttl) {
  return new Response(JSON.stringify(obj), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=' + (ttl || 60)
    }
  });
}
function fail(msg, code) {
  /* Ответы с ошибкой не кэшируются — иначе неудача источника осела бы на часы. */
  return new Response(JSON.stringify({ error: msg }), {
    status: code || 502,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
async function cached(req, ctx, ttl, make) {
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return hit;
  let res;
  try { res = await make(); }
  catch (e) { return fail(String(e && e.message || e)); }
  if (res.status === 200) ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}
function ticker(url) {
  const t = (url.searchParams.get('t') || '').toUpperCase();
  return CIK[t] ? t : null;
}

/* ── цены: Yahoo ────────────────────────────────────────────────── */

async function prices(url) {
  const t = ticker(url);
  if (!t) return fail('неизвестный тикер', 400);

  const src = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
              encodeURIComponent(t) + '?range=10y&interval=1d&events=split';
  const r = await fetch(src, { headers: { 'user-agent': UA_WEB, accept: 'application/json' } });
  if (!r.ok) return fail('Yahoo ответил ' + r.status);

  const raw = await r.json();
  const res = raw && raw.chart && raw.chart.result && raw.chart.result[0];
  const q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
  if (!res || !q) return fail('Yahoo вернул пустой ответ');

  const ts = res.timestamp || [], cl = q.close || [], vl = q.volume || [];
  /* Дробления акций: цены Yahoo к ним приведены, а прибыль на акцию из EDGAR — нет.
     Отдаём список, чтобы страница привела показатели на акцию к сегодняшним долям. */
  const sp = [];
  const ev = (res.events && res.events.splits) || {};
  for (const k of Object.keys(ev)) {
    const x = ev[k];
    const r = (x.numerator || 0) / (x.denominator || 1);
    if (r > 0 && x.date) sp.push([x.date, r]);
  }
  sp.sort((a, b) => a[0] - b[0]);
  const out = { t: [], c: [], v: [], sp: sp };
  for (let i = 0; i < ts.length; i++) {
    if (cl[i] == null) continue;                      /* пропуски источника выбрасываем */
    out.t.push(ts[i]);
    out.c.push(Math.round(cl[i] * 10000) / 10000);
    out.v.push(vl[i] == null ? 0 : vl[i]);
  }
  if (out.c.length < 500) return fail('слишком короткий ряд цен: ' + out.c.length);
  return json(out, TTL.px);
}

/* ── отчётность: EDGAR ──────────────────────────────────────────── */

async function fundamentals(url) {
  const t = ticker(url);
  if (!t) return fail('неизвестный тикер', 400);

  const src = 'https://data.sec.gov/api/xbrl/companyfacts/CIK' + CIK[t] + '.json';
  const r = await fetch(src, {
    headers: { 'user-agent': UA_SEC, accept: 'application/json', 'accept-encoding': 'gzip' }
  });
  if (!r.ok) return fail('EDGAR ответил ' + r.status);

  const facts = await r.json();
  const g = (facts.facts && facts.facts['us-gaap']) || {};

  const out = { ticker: t, name: facts.entityName || t };
  for (const key of Object.keys(TAGS)) out[key] = pick(g, TAGS[key]);

  if (!out.eps.length && !out.ni.length) return fail('в отчётности нет ни прибыли, ни EPS');
  return json(out, TTL.fund);
}

/**
 * Берёт первую найденную статью и возвращает её точки в компактном виде:
 * [начало периода, конец периода, дата подачи, значение].
 * Начало пустое у моментных показателей (капитал на дату).
 * Дата подачи нужна для причинности: на снимке прошлого используются только
 * те цифры, которые к тому дню уже были опубликованы.
 */
function pick(g, tags) {
  let best = null;
  for (const tag of tags) {
    const node = g[tag];
    if (!node || !node.units) continue;
    const units = node.units;
    const uk = Object.keys(units).find(k => k === 'USD' || k === 'USD/shares') || Object.keys(units)[0];
    const arr = units[uk] || [];
    const seen = new Map();
    for (const x of arr) {
      if (x.val == null || !x.end || !x.filed) continue;
      const k = (x.start || '') + '|' + x.end;
      const prev = seen.get(k);
      /* Оставляем самую раннюю подачу — первую публикацию, без поздних уточнений. */
      if (!prev || x.filed < prev.filed) seen.set(k, x);
    }
    const out = [...seen.values()]
      .sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0))
      .map(x => [x.start || '', x.end, x.filed, x.val]);
    if (!out.length) continue;
    /* Берём не первую попавшуюся статью, а самую свежую: эмитенты меняют
       название статьи со временем, и старое остаётся в отчётности навсегда.
       У NVDA, например, "выручка по договорам" оборвана на 2022 году,
       а живой ряд лежит под "Revenues". */
    const last = out[out.length - 1][1];
    if (!best || last > best.last || (last === best.last && out.length > best.rows.length)) {
      best = { last: last, rows: out };
    }
  }
  return best ? best.rows : [];
}
