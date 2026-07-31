/**
 * HVMI — единый Worker сайта.
 * Формат «Workers with assets»: этот файл управляет каждым запросом,
 * статические файлы (весь текущий репозиторий) отдаёт через биндинг ASSETS.
 *
 * ФАЙЛ КЛАДЁТСЯ В КОРЕНЬ РЕПОЗИТОРИЯ:  worker.js
 * (рядом с index.html, wrangler.jsonc и остальными страницами)
 *
 * ЕДИНИЦА ДОСТУПА И ПРОДАЖИ — ОТЧЁТ (product_key), не направление.
 *   Десять ключей: macro, wlm, flows, wpm, wsm, qeg, lead, margin, aicm, cockpit.
 *   Прежние шесть «направлений» (altitude/radar/airframe/horizon/echelon)
 *   остались только как группировка-рекомендация («комплекс») на витрине —
 *   в базе и в правах доступа их больше нет. cockpit — исключение: как и раньше,
 *   один ключ покрывает все три живых инструмента разом.
 *
 * Обслуживает:
 *   POST /api/auth/request   { email }              → отправляет код на почту
 *   POST /api/auth/verify    { email, code, keep }  → проверяет код, выдаёт сессию
 *   GET  /app/file/<slug>                            → отдаёт PDF выпуска из R2
 *   POST /app/api/renew      { product, on }         → включает и отключает продление подписки на отчёт
 *   GET  /app/api/issue?slug=<slug>                   → один выпуск и предыдущие выпуски того же отчёта
 *   POST /api/ls/webhook                              → события Lemon Squeezy (подпись + защита от повтора)
 *   POST /api/checkout       { products, period }    → открывает оплату в кассе, возвращает ссылку
 *   POST /api/contact        { topic, name, email, company, message } → письмо с формы контактов на hello@
 *   всё под /app/*                                   → пропускает только с живой сессией
 *   /app/bottom · /app/tott · /app/gex                → дополнительно требуют оплаченной Приборной доски
 *   всё остальное                                    → отдаёт как есть (витрина, вход, legal)
 *   по расписанию (каждые 15 минут)                   → публикация выпусков из R2 + письма подписчикам
 *
 * ПУБЛИКАЦИЯ ВЫПУСКА — только загрузка файлов, никаких команд:
 *   в бакет R2 кладутся два объекта: <slug>.pdf и <slug>.summary.html,
 *   slug = код-отчёта-ГГГГ-ММ-ДД (коды — таблица PRODUCT_INFO ниже,
 *   код в имени файла и есть product_key).
 *   Ближайший проход расписания заводит выпуск в базу и рассылает
 *   уведомления всем, у кого оплачен этот отчёт.
 *   Пока лежит только один файл из пары — выпуск ждёт второй.
 *   Ошибки публикации видны в таблице webhook_event (kind = 'publish_error').
 *
 * Привязки в wrangler.jsonc:
 *   ASSETS   статические файлы (задаётся автоматически полем assets.binding)
 *   DB       база D1 со схемой из schema.sql (после миграции на product_key —
 *            см. schema-v2-migration.sql)
 *   R2       бакет R2 с файлами выпусков; ключ объекта лежит в issue.pdf_key
 *
 * Секреты — панель Cloudflare → проект → Settings → Variables and Secrets (тип Secret),
 * в wrangler.jsonc НЕ хранятся:
 *   AUTH_SECRET       случайная строка от 32 символов; соль для хешей кодов и токенов
 *   RESEND_API_KEY    ключ Resend
 *   LS_WEBHOOK_SECRET секрет вебхука Lemon Squeezy (тот же, что вписан в кассе)
 *   LS_API_KEY        ключ API Lemon Squeezy (нужен только для создания оплаты)
 *
 * Обычные переменные (можно в wrangler.jsonc, можно тоже в панели):
 *   MAIL_FROM        Helicopter View <login@hvmiresearch.com>
 *   APP_HOME         /app/overview.html
 *   LS_STORE_ID      номер магазина в Lemon Squeezy
 *   LS_VARIANT_YEAR  номер годового варианта товара подписки
 *   LS_VARIANT_MONTH номер помесячного варианта того же товара
 *   LS_TEST_MODE     '1' — оплата открывается в тестовом режиме кассы
 *
 * Вариантов два, потому что интервал списания в кассе живёт на варианте,
 * а не на чекауте. Цену обоих назначает этот воркер.
 *
 * Пока ключ, магазин и нужный вариант не заведены, маршрут оплаты
 * отвечает 503 с внятным текстом — остальной сайт от этого не страдает.
 */

const CODE_TTL       = 900;          // код живёт 15 минут
const MAX_ATTEMPTS   = 5;            // попыток ввода на один код
const MAX_REQUESTS   = 3;            // запросов кода на адрес за то же окно
const SESSION_SHORT  = 12 * 3600;    // без галочки «не выходить на этом устройстве»
const SESSION_LONG   = 30 * 86400;   // с галочкой
const COOKIE_NAME    = 'hv_session';
const LOGIN_PAGE     = '/login.html';
const NO_ACCESS      = '/app/no-access.html';
const REPORTS_PAGE   = '/app/reports.html';
const TOUCH_AFTER    = 3600;         // отметку «был на сайте» пишем не чаще раза в час
const BUY_RETURN     = '/welcome.html';   // куда касса возвращает покупателя (вне гейта: сессии ещё нет)
const LS_API         = 'https://api.lemonsqueezy.com/v1/checkouts';
const MAX_BODY       = 64 * 1024;    // предельный размер тела POST-запроса, с запасом на вебхук кассы
const CANON_HOST     = 'www.hvmiresearch.com';   // единственный канонический хост; апекс переадресуется сюда

const QA_GATE_OFF    = 1;    // ВРЕМЕННЫЙ ОБХОД ГЕЙТА ДЛЯ ПРОГОНА QA. 1 — включён, 0 — выключен.
const QA_SID         = 1;    // id подписчика, от имени которого работает обход при QA_GATE_OFF = 1

/* ------------------------------------------------------------------ */
/* пути, которые наружу не отдаются, и заголовки безопасности          */
/* ------------------------------------------------------------------ */

/**
 * Статика раздаётся из корня репозитория, поэтому рядом с index.html лежат
 * исходники и служебные файлы. Всё перечисленное отвечает 404 — как будто
 * файла нет. Проверка стоит раньше маршрутов и раньше выдачи статики.
 */
const BLOCKED_PATHS = [
  /^\/\.git(\/|$)/i,             // каталог репозитория целиком
  /^\/\.[^/]*$/,                 // .env, .gitignore и прочие точечные файлы в корне
  /^\/worker\.js$/i,
  /^\/wrangler\.(jsonc|json|toml)$/i,
  /^\/package(-lock)?\.json$/i,
  /^\/node_modules(\/|$)/i,
  /\.(sql|md|toml|lock|env|sh|py|bak|log)$/i
];

function isBlockedPath(path) {
  for (const re of BLOCKED_PATHS) if (re.test(path)) return true;
  return false;
}

/**
 * Заголовки безопасности на каждый ответ сайта.
 * Content-Security-Policy сознательно не ставится: страницы держат стили и
 * скрипты внутри себя, инструменты зоны ходят за данными на сторонние адреса —
 * политика потребует отдельной сборки и проверки.
 */
function harden(res) {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set('Strict-Transport-Security', 'max-age=31536000');
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Один канонический хост: апекс уводится на www постоянной переадресацией,
    // иначе сайт целиком доступен по двум адресам как дубль.
    if (url.hostname !== CANON_HOST && url.hostname.endsWith('hvmiresearch.com')) {
      url.hostname = CANON_HOST;
      return harden(Response.redirect(url.toString(), 301));
    }

    if (isBlockedPath(url.pathname)) {
      return harden(new Response('Not found', { status: 404 }));
    }

    return harden(await route(request, env, ctx, url));
  },

  /**
   * Расписание (wrangler.jsonc → triggers.crons): публикация выпусков.
   * Раз в 15 минут смотрим бакет R2; каждая пара slug.pdf + slug.summary.html,
   * которой ещё нет в базе, становится выпуском, подписчики получают письмо.
   */
  async scheduled(event, env, ctx) {
    return handleScheduled(event, env, ctx);
  }
};

/* Маршрутизация запроса — прежнее тело fetch без изменений. */
async function route(request, env, ctx, url) {
  const path = url.pathname;

    // Тело POST-запроса ограничено по размеру: ни один наш маршрут не ждёт
    // больше нескольких килобайт, а читаются тела целиком. Заголовок длины
    // проверяется первым как быстрый отсев, но верить только ему нельзя —
    // при передаче по частям его нет, поэтому прочитанное тело меряется тоже.
    // Читаем ровно один раз здесь и передаём дальше готовым.
    let raw = null;
    if (request.method === 'POST' && path.startsWith('/api/')) {
      const declared = Number(request.headers.get('Content-Length') || 0);
      if (declared > MAX_BODY) return json({ ok: false, error: 'Запрос слишком велик.' }, 413);

      raw = await request.text();
      if (raw.length > MAX_BODY) return json({ ok: false, error: 'Запрос слишком велик.' }, 413);
    }

    if (request.method === 'POST' && path === '/api/auth/request') {
      return handleRequest(parseBody(raw), env);
    }
    if (request.method === 'POST' && path === '/api/auth/verify') {
      return handleVerify(parseBody(raw), env);
    }

    if (request.method === 'POST' && path === '/api/ls/webhook') {
      return handleWebhook(request, env, raw);
    }

    if (request.method === 'POST' && path === '/api/checkout') {
      return handleCheckout(parseBody(raw), env, url);
    }

    if (request.method === 'POST' && path === '/api/contact') {
      return handleContact(parseBody(raw), env);
    }

    if (path.startsWith('/app/')) {
      const gate = await checkAccess(request, env, url);
      if (gate.deny) return gate.deny;   // редирект на вход / «нет доступа» / 401 на запрос данных

      const slug = fileSlug(url);
      if (slug) return serveFile(request, env, url, gate.sid, slug);

      const api = apiName(url);
      if (api) return serveApi(request, env, url, gate.sid, api);

      const res = await env.ASSETS.fetch(request);
      const out = new Response(res.body, res);
      out.headers.set('Cache-Control', 'no-store');
      return out;
    }

    // Промах по маршруту под /api/ отвечает коротким JSON, а не страницей 404:
    // иначе на каждый неверный запрос уходит целый HTML-документ.
    if (path.startsWith('/api/')) {
      return json({ ok: false, error: 'Маршрут не найден.' }, 404);
    }

    return env.ASSETS.fetch(request);
}

/* Прежнее тело scheduled без изменений. */
async function handleScheduled(event, env, ctx) {
  ctx.waitUntil(publishPending(env));
}

/* ------------------------------------------------------------------ */
/* защита /app/*                                                       */
/* ------------------------------------------------------------------ */

/**
 * Возвращает { deny: Response } — если пускать нельзя,
 * либо { sid } — опознанный подписчик.
 */
async function checkAccess(request, env, url) {
  // ВРЕМЕННЫЙ ОБХОД ДЛЯ QA. QA_GATE_OFF: 1 — сессия не проверяется вовсе,
  // все запросы идут от имени подписчика QA_SID; 0 — обход выключен.
  // Переключается правкой этой константы и повторной заливкой на GitHub.
  if (QA_GATE_OFF) return { sid: QA_SID };

  const now   = unix();
  const token = readCookie(request, COOKIE_NAME);

  if (!token) return { deny: unauthorized(request, url, false) };

  const session = await env.DB
    .prepare(`SELECT s.subscriber_id AS sid, s.last_seen_at AS seen, u.email AS email
              FROM session s JOIN subscriber u ON u.id = s.subscriber_id
              WHERE s.id = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2
                AND u.blocked_at IS NULL`)
    .bind(await hashWith(token, env.AUTH_SECRET), now)
    .first();

  if (!session) return { deny: unauthorized(request, url, true) };

  if (now - session.seen > TOUCH_AFTER) {
    ctxWaitOrRun(env.DB
      .prepare('UPDATE session SET last_seen_at = ?2 WHERE id = ?1')
      .bind(await hashWith(token, env.AUTH_SECRET), now)
      .run());
  }

  const tool = toolDir(url);
  if (tool) {
    if (await hasRight(env, session.sid, tool, now)) return { sid: session.sid };
    return { deny: redirect(noAccessUrl(url, tool, '')) };
  }

  const slug = issueSlug(url);
  if (!slug) return { sid: session.sid };   // не страница выпуска — сессии достаточно

  const issue = await env.DB
    .prepare('SELECT product_key AS product FROM issue WHERE slug = ?1 AND is_published = 1')
    .bind(slug)
    .first();

  if (!issue) return { deny: redirect(new URL(REPORTS_PAGE, url)) };

  const right = await hasRight(env, session.sid, issue.product, now);
  if (right) return { sid: session.sid };

  return { deny: redirect(noAccessUrl(url, issue.product, slug)) };
}

/** product — ключ отчёта (product_key), например 'wlm' или 'cockpit'. */
async function hasRight(env, sid, product, now) {
  const row = await env.DB
    .prepare(`SELECT 1 AS ok FROM entitlement
              WHERE subscriber_id = ?1 AND product_key = ?2
                AND status = 'active' AND expires_at > ?3`)
    .bind(sid, product, now)
    .first();
  return !!row;
}

function noAccessUrl(url, product, slug) {
  const to = new URL(NO_ACCESS, url);
  to.searchParams.set('product', product);
  if (slug) to.searchParams.set('slug', slug);
  return to;
}

/**
 * Страницы инструментов считают всё в браузере — сессии для них мало,
 * иначе Приборная доска достаётся любому, кто оплатил что угодно другое.
 * Страница /app/indicators открыта всем подписчикам сознательно: витрина доски.
 */
const TOOL_PAGES = { bottom: 'cockpit', tott: 'cockpit', gex: 'cockpit' };

function toolDir(url) {
  const m = url.pathname.match(/^\/app\/(bottom|tott|gex)(?:\.html)?\/?$/);
  return m ? TOOL_PAGES[m[1]] : null;
}

function unauthorized(request, url, stale) {
  const headers = { 'Cache-Control': 'no-store' };
  if (stale) {
    headers['Set-Cookie'] = `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  }

  if (wantsJson(request, url.pathname)) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    return new Response(JSON.stringify({ ok: false, error: 'Нужен вход.' }), { status: 401, headers });
  }

  const to = new URL(LOGIN_PAGE, url);
  to.searchParams.set('next', url.pathname + url.search);
  headers['Location'] = to.toString();
  return new Response(null, { status: 302, headers });
}

function wantsJson(request, path) {
  if (path.startsWith('/app/api/')) return true;
  const accept = request.headers.get('accept') || '';
  if (accept.includes('application/json')) return true;
  return (request.headers.get('sec-fetch-mode') || '') === 'cors';
}

function issueSlug(url) {
  const m = url.pathname.match(/^\/app\/issue\/([A-Za-z0-9._-]{1,80})\/?$/);
  if (m) return m[1];
  if (/^\/app\/issue\.html$/.test(url.pathname)) {
    const q = url.searchParams.get('slug') || '';
    if (/^[A-Za-z0-9._-]{1,80}$/.test(q)) return q;
  }
  return null;
}

function redirect(to) {
  return new Response(null, {
    status: 302,
    headers: { 'Location': to.toString(), 'Cache-Control': 'no-store' }
  });
}

/* ------------------------------------------------------------------ */
/* выдача PDF выпуска                                                  */
/* ------------------------------------------------------------------ */

/** /app/file/<slug> и /app/file/<slug>.pdf — оба ведут к одному выпуску. */
function fileSlug(url) {
  const m = url.pathname.match(/^\/app\/file\/([A-Za-z0-9._-]{1,80}?)(?:\.pdf)?\/?$/);
  return m ? m[1] : null;
}

async function serveFile(request, env, url, sid, slug) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { 'Cache-Control': 'no-store' } });
  }

  const now = unix();

  const issue = await env.DB
    .prepare(`SELECT product_key AS product, pdf_key AS key FROM issue
              WHERE slug = ?1 AND is_published = 1`)
    .bind(slug)
    .first();

  // нет выпуска или файл к нему не приложен — уводим в ленту, а не показываем ошибку
  if (!issue || !issue.key) return redirect(new URL(REPORTS_PAGE, url));

  if (!(await hasRight(env, sid, issue.product, now))) {
    return redirect(noAccessUrl(url, issue.product, slug));
  }

  const obj = await env.R2.get(issue.key);
  if (!obj) return redirect(new URL(REPORTS_PAGE, url));

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Content-Type', 'application/pdf');
  headers.set('Content-Length', String(obj.size));
  headers.set('Content-Disposition', `attachment; filename="${slug}.pdf"`);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');

  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(obj.body, { headers });
}

/* ------------------------------------------------------------------ */
/* запросы данных для страниц зоны                                     */
/* ------------------------------------------------------------------ */

/** /app/api/me · /app/api/issues · /app/api/issue · /app/api/payments · /app/api/renew */
function apiName(url) {
  const m = url.pathname.match(/^\/app\/api\/(me|issues|issue|payments|renew)\/?$/);
  return m ? m[1] : null;
}

/**
 * Все запросы данных обёрнуты перехватом: без него любая ошибка базы валит
 * весь воркер и Cloudflare показывает пустую страницу «Error 1101», по которой
 * нельзя понять причину. Здесь она приходит текстом в поле error.
 */
async function serveApi(request, env, url, sid, name) {
  try {
    return await serveApiInner(request, env, url, sid, name);
  } catch (e) {
    return json({ ok: false, error: 'Сбой запроса: ' + ((e && e.message) || String(e)) }, 500);
  }
}

async function serveApiInner(request, env, url, sid, name) {
  if (name === 'renew') {
    if (request.method !== 'POST') return json({ ok: false, error: 'Только POST.' }, 405);
    const body = await safeJson(request);
    if (body === null) return json({ ok: false, error: 'Запрос слишком велик.' }, 413);
    return apiRenew(body, env, sid);
  }

  if (request.method !== 'GET') return json({ ok: false, error: 'Только GET.' }, 405);

  if (name === 'me')       return apiMe(env, sid);
  if (name === 'issues')   return apiIssues(env, url, sid);
  if (name === 'issue')    return apiIssue(env, url, sid);
  if (name === 'payments') return apiPayments(env, sid);

  return json({ ok: false, error: 'Неизвестный запрос.' }, 404);
}

/** Кто вошёл и что у него открыто. */
async function apiMe(env, sid) {
  const now = unix();

  const who = await env.DB
    .prepare('SELECT email, deliver_email AS deliver FROM subscriber WHERE id = ?1')
    .bind(sid)
    .first();

  if (!who) return json({ ok: false, error: 'Подписчик не найден.' }, 404);

  const rows = await env.DB
    .prepare(`SELECT e.product_key AS product, e.starts_at AS starts, e.expires_at AS expires,
                     e.auto_renew AS renew, e.status AS status
                FROM entitlement e JOIN product p ON p.key = e.product_key
               WHERE e.subscriber_id = ?1
               ORDER BY p.sort`)
    .bind(sid)
    .all();

  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM product').first();

  const products = (rows.results || []).map(r => ({
    key:       r.product,
    starts_at: r.starts,
    expires_at: r.expires,
    auto_renew: !!r.renew,
    status:    r.status,
    active:    r.status === 'active' && r.expires > now,
    days_left: Math.max(0, Math.ceil((r.expires - now) / 86400))
  }));

  return json({
    ok: true,
    email: who.email,
    deliver_email: who.deliver || null,
    products,
    active_count: products.filter(d => d.active).length,
    total_products: total ? total.n : 0,
    now
  });
}

/**
 * Лента выпусков. Отдаёт и недоступные — страница показывает их приглушённо,
 * но без summary и без ссылки на файл.
 * Отбор: ?product=<ключ> · ?limit=<1..100>
 * Плейсхолдеры нумерованные (?1, ?2…), как и во всех остальных запросах файла:
 * безымянные `?` в D1 не отработали.
 */
async function apiIssues(env, url, sid) {
  const now     = unix();
  const product = clean(url.searchParams.get('product'));
  const limit   = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 100);

  // Общая часть выборки. Дальше два отдельных запроса — с отбором по отчёту
  // и без него. Так проще, чем один запрос с проверкой на NULL: никаких
  // повторов плейсхолдеров и никаких пустых значений в привязке.
  const head = `SELECT i.slug, i.product_key AS product, i.title, i.cadence,
                       i.published_at AS published, i.summary_html AS summary, i.pdf_key AS pdf,
                       EXISTS (SELECT 1 FROM entitlement e
                                WHERE e.subscriber_id = ?1
                                  AND e.product_key = i.product_key
                                  AND e.status = 'active' AND e.expires_at > ?2) AS ok
                  FROM issue i
                 WHERE i.is_published = 1`;

  const rows = product
    ? await env.DB
        .prepare(`${head} AND i.product_key = ?3 ORDER BY i.published_at DESC LIMIT ?4`)
        .bind(sid, now, product, limit)
        .all()
    : await env.DB
        .prepare(`${head} ORDER BY i.published_at DESC LIMIT ?3`)
        .bind(sid, now, limit)
        .all();

  const issues = (rows.results || []).map(r => {
    const open = !!r.ok;
    return {
      slug:         r.slug,
      product:      r.product,
      title:        r.title,
      cadence:      r.cadence,
      published_at: r.published,
      available:    open,
      summary_html: open ? (r.summary || null) : null,
      file:         open && r.pdf ? `/app/file/${r.slug}` : null
    };
  });

  return json({ ok: true, issues, now });
}

/**
 * Один выпуск по слагу плюс предыдущие выпуски того же отчёта.
 * Право проверяется здесь заново: страница защищена гейтом, но запрос
 * могут позвать и напрямую. Без права выпуск отдаётся без текста и без файла.
 */
async function apiIssue(env, url, sid) {
  const now  = unix();
  const asked = String(url.searchParams.get('slug') || '').trim();
  if (!asked) return json({ ok: false, error: 'Выпуск не указан.' }, 400);

  const slug = clean(asked);
  if (!slug) return json({ ok: false, error: 'Выпуск не найден.' }, 404);

  const row = await env.DB
    .prepare(`SELECT slug, product_key AS product, title, cadence,
                     published_at AS published, summary_html AS summary, pdf_key AS key
                FROM issue WHERE slug = ?1 AND is_published = 1`)
    .bind(slug)
    .first();

  if (!row) return json({ ok: false, error: 'Выпуск не найден.' }, 404);

  const open = await hasRight(env, sid, row.product, now);

  const prev = await env.DB
    .prepare(`SELECT slug, published_at AS published, summary_html AS summary
                FROM issue
               WHERE is_published = 1 AND product_key = ?1 AND published_at < ?2
               ORDER BY published_at DESC LIMIT 5`)
    .bind(row.product, row.published)
    .all();

  return json({
    ok: true,
    issue: {
      slug:         row.slug,
      product:      row.product,
      title:        row.title,
      cadence:      row.cadence,
      published_at: row.published,
      available:    open,
      summary_html: open ? (row.summary || null) : null,
      file:         open && row.key ? `/app/file/${row.slug}` : null
    },
    previous: open ? (prev.results || []).map(r => ({
      slug:         r.slug,
      published_at: r.published,
      summary_html: r.summary || null
    })) : [],
    now
  });
}

/**
 * Отказ от продления и возврат к нему.
 * Доступ не трогаем: подписка живёт до конца оплаченного периода,
 * меняется только то, будет ли она возобновлена по его окончании.
 * Настоящая отмена живёт в Lemon Squeezy — при подключении кассы
 * сюда добавится вызов её API, а вебхук приведёт зеркало в соответствие.
 */
async function apiRenew(body, env, sid) {
  const product = clean(body && body.product);
  if (!product) return json({ ok: false, error: 'Подписка не указана.' }, 400);
  if (!body || typeof body.on !== 'boolean') {
    return json({ ok: false, error: 'Не указано, включить продление или отключить.' }, 400);
  }

  const now = unix();
  const on  = body.on ? 1 : 0;

  const row = await env.DB
    .prepare(`SELECT expires_at AS expires, status FROM entitlement
              WHERE subscriber_id = ?1 AND product_key = ?2`)
    .bind(sid, product)
    .first();

  if (!row) return json({ ok: false, error: 'Эта подписка у вас не оплачена.' }, 404);

  await env.DB
    .prepare(`UPDATE entitlement SET auto_renew = ?3
              WHERE subscriber_id = ?1 AND product_key = ?2`)
    .bind(sid, product, on)
    .run();

  return json({
    ok: true,
    product,
    auto_renew: !!on,
    expires_at: row.expires,
    active: row.status === 'active' && row.expires > now
  });
}

/** Платежи для раздела «Платежи» в профиле. */
async function apiPayments(env, sid) {
  const rows = await env.DB
    .prepare(`SELECT paid_at, amount_cents AS cents, currency, what, detail, ls_order_id AS order_id
                FROM payment WHERE subscriber_id = ?1 ORDER BY paid_at DESC LIMIT 200`)
    .bind(sid)
    .all();

  return json({ ok: true, payments: rows.results || [] });
}

/** Пустая строка в отборе — это «не задано», а не «пусто». */
function clean(v) {
  const s = String(v || '').trim();
  return /^[A-Za-z0-9._-]{1,40}$/.test(s) ? s : null;
}

/* ------------------------------------------------------------------ */
/* 1. запросить код                                                    */
/* ------------------------------------------------------------------ */

async function handleRequest(body, env) {
  const email = normalizeEmail(body && body.email);
  if (!email) return json({ ok: false, error: 'Проверьте адрес почты.' }, 400);

  const now = unix();

  const recent = await env.DB
    .prepare('SELECT COUNT(*) AS n FROM login_code WHERE email = ?1 AND created_at > ?2')
    .bind(email, now - CODE_TTL)
    .first();

  if (recent && recent.n >= MAX_REQUESTS) return json({ ok: true });   // ответ тот же, что при успехе

  const sub = await env.DB
    .prepare('SELECT id FROM subscriber WHERE email = ?1 AND blocked_at IS NULL')
    .bind(email)
    .first();

  if (!sub) return json({ ok: true });   // адреса нет — наружу это не сообщается

  const code = randomCode();
  const hash = await hashWith(code, env.AUTH_SECRET);

  await env.DB
    .prepare(`INSERT INTO login_code (email, code_hash, created_at, expires_at, request_ip)
              VALUES (?1, ?2, ?3, ?4, ?5)`)
    .bind(email, hash, now, now + CODE_TTL, '')
    .run();

  const sent = await sendCode(env, email, code);
  if (!sent) return json({ ok: false, error: 'Письмо не удалось отправить. Попробуйте ещё раз.' }, 502);

  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* 2. проверить код и выдать сессию                                    */
/* ------------------------------------------------------------------ */

async function handleVerify(body, env) {
  const email = normalizeEmail(body && body.email);
  const code  = String((body && body.code) || '').replace(/\s/g, '');
  const keep  = !!(body && body.keep);
  const WRONG = 'Код не подошёл. Он действует 15 минут и только один раз — запросите новый.';

  if (!email || !/^\d{6}$/.test(code)) {
    return json({ ok: false, error: 'Код состоит из шести цифр.' }, 400);
  }

  const now = unix();

  const row = await env.DB
    .prepare(`SELECT id, code_hash, attempts, expires_at FROM login_code
              WHERE email = ?1 AND used_at IS NULL
              ORDER BY created_at DESC LIMIT 1`)
    .bind(email)
    .first();

  if (!row || row.expires_at <= now) return json({ ok: false, error: WRONG }, 401);

  if (row.attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare('UPDATE login_code SET used_at = ?2 WHERE id = ?1').bind(row.id, now).run();
    return json({ ok: false, error: 'Слишком много попыток. Запросите новый код.' }, 429);
  }

  await env.DB.prepare('UPDATE login_code SET attempts = attempts + 1 WHERE id = ?1').bind(row.id).run();

  const hash = await hashWith(code, env.AUTH_SECRET);
  if (!equalHex(hash, row.code_hash)) return json({ ok: false, error: WRONG }, 401);

  const sub = await env.DB
    .prepare('SELECT id FROM subscriber WHERE email = ?1 AND blocked_at IS NULL')
    .bind(email)
    .first();

  if (!sub) return json({ ok: false, error: WRONG }, 401);

  await env.DB.batch([
    env.DB.prepare('UPDATE login_code SET used_at = ?2 WHERE id = ?1').bind(row.id, now),
    env.DB.prepare('UPDATE login_code SET used_at = ?2 WHERE email = ?1 AND used_at IS NULL').bind(email, now),
    env.DB.prepare('UPDATE subscriber SET last_login_at = ?2 WHERE id = ?1').bind(sub.id, now)
  ]);

  const token = randomToken();
  const ttl   = keep ? SESSION_LONG : SESSION_SHORT;

  await env.DB
    .prepare(`INSERT INTO session (id, subscriber_id, created_at, last_seen_at, expires_at)
              VALUES (?1, ?2, ?3, ?3, ?4)`)
    .bind(await hashWith(token, env.AUTH_SECRET), sub.id, now, now + ttl)
    .run();

  return json(
    { ok: true, redirect: env.APP_HOME || '/app/overview.html' },
    200,
    { 'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Lax` }
  );
}

/* ------------------------------------------------------------------ */
/* вебхук Lemon Squeezy                                                */
/* ------------------------------------------------------------------ */

/**
 * Касса шлёт сюда события подписок и платежей.
 * Порядок: проверить подпись → записать событие (повтор отсеивается по ключу)
 * → разложить по таблицам → пометить обработанным.
 *
 * Модель продажи — вариант A: один товар-конструктор с назначаемой ценой.
 * Какие отчёты оплачены, приходит в meta.custom_data.products списком
 * ключей product_key через запятую; период — meta.custom_data.period
 * ('year' | 'month'). Отмена и окончание работают не по custom_data,
 * а по ls_subscription_id: трогаются ровно те строки, которые эта
 * подписка и открыла.
 */
async function handleWebhook(request, env, raw) {
  const sig = request.headers.get('X-Signature') || '';

  if (!(await validSignature(raw, sig, env.LS_WEBHOOK_SECRET))) {
    return json({ ok: false, error: 'Подпись не сходится.' }, 401);
  }

  let body;
  try { body = JSON.parse(raw); } catch (e) {
    return json({ ok: false, error: 'Тело не разбирается.' }, 400);
  }

  const kind = (body && body.meta && body.meta.event_name) || 'unknown';
  const now  = unix();

  // Повторную доставку того же события касса шлёт с тем же телом,
  // поэтому подпись годится как ключ события.
  const seen = await env.DB
    .prepare(`INSERT OR IGNORE INTO webhook_event (id, kind, received_at, payload)
              VALUES (?1, ?2, ?3, ?4)`)
    .bind(sig, kind, now, raw.slice(0, 20000))
    .run();

  if (seen && seen.meta && seen.meta.changes === 0) {
    return json({ ok: true, repeat: true });   // уже обрабатывали
  }

  try {
    await applyEvent(env, kind, body, now);
    await env.DB.prepare('UPDATE webhook_event SET handled_at = ?2 WHERE id = ?1')
      .bind(sig, unix()).run();
  } catch (e) {
    await env.DB.prepare('UPDATE webhook_event SET error = ?2 WHERE id = ?1')
      .bind(sig, String((e && e.message) || e).slice(0, 500)).run();
    // Касса повторит доставку — отвечаем ошибкой сознательно.
    return json({ ok: false, error: 'Событие не разложено.' }, 500);
  }

  return json({ ok: true });
}

async function applyEvent(env, kind, body, now) {
  const a = (body && body.data && body.data.attributes) || {};
  const custom = (body && body.meta && body.meta.custom_data) || {};
  const subId  = String((body && body.data && body.data.id) || '');

  if (kind === 'subscription_created' || kind === 'subscription_updated' ||
      kind === 'subscription_resumed' || kind === 'subscription_unpaused') {
    return grantSubscription(env, a, custom, subId, now);
  }

  // Отмена в кассе = отказ от продления: доступ живёт до конца оплаченного периода.
  if (kind === 'subscription_cancelled') {
    await env.DB
      .prepare(`UPDATE entitlement SET auto_renew = 0, updated_at = ?2
                 WHERE ls_subscription_id = ?1`)
      .bind(subId, now).run();
    return;
  }

  if (kind === 'subscription_expired') {
    const ends = when(a.ends_at) || now;
    await env.DB
      .prepare(`UPDATE entitlement SET status = 'expired', expires_at = ?2, updated_at = ?3
                 WHERE ls_subscription_id = ?1`)
      .bind(subId, ends, now).run();
    return;
  }

  if (kind === 'subscription_payment_success') {
    return recordPayment(env, a, custom, now);
  }

  // Остальные события кассы нам сейчас не нужны — событие записано, действий нет.
}

/** Открыть подписчику перечисленные отчёты и продлить срок. */
async function grantSubscription(env, a, custom, subId, now) {
  const email = normalizeEmail(a.user_email);
  if (!email) throw new Error('в событии нет почты покупателя');

  const keys = await validKeys(env, custom.products);
  if (!keys.length) throw new Error('в событии нет ни одного известного ключа отчёта');

  const sid = await subscriberId(env, email, a.customer_id, now);

  // Отменённая в кассе подписка продолжает работать до конца периода.
  const renew  = a.cancelled ? 0 : 1;
  const status = 'active';
  const until  = when(a.renews_at) || when(a.ends_at) || periodEnd(custom.period, now);

  for (const key of keys) {
    await env.DB
      .prepare(`INSERT INTO entitlement
                  (subscriber_id, product_key, starts_at, expires_at,
                   auto_renew, status, ls_subscription_id, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                ON CONFLICT (subscriber_id, product_key) DO UPDATE SET
                  expires_at = excluded.expires_at,
                  auto_renew = excluded.auto_renew,
                  status = excluded.status,
                  ls_subscription_id = excluded.ls_subscription_id,
                  updated_at = excluded.updated_at`)
      .bind(sid, key, now, until, renew, status, subId, now)
      .run();
  }
}

/** Записать списание в раздел «Платежи». */
async function recordPayment(env, a, custom, now) {
  const email = normalizeEmail(a.user_email);
  if (!email) return;

  const sid   = await subscriberId(env, email, a.customer_id, now);
  const order = String(a.order_id || '');
  const cents = Number(a.total || a.subtotal || 0) || 0;
  const paid  = when(a.created_at) || now;

  const keys   = await validKeys(env, custom.products);
  const period = custom.period === 'month' ? 'Помесячная подписка' : 'Годовая подписка';
  const detail = keys.length ? keys.length + ' ' + word(keys.length, 'подписка', 'подписки', 'подписок') : null;

  await env.DB
    .prepare(`INSERT OR IGNORE INTO payment
                (subscriber_id, paid_at, amount_cents, currency, what, detail, ls_order_id)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
    .bind(sid, paid, cents, a.currency || 'USD', period, detail, order || null)
    .run();
}

/** Подписчик по почте: находим или заводим. */
async function subscriberId(env, email, lsCustomer, now) {
  const found = await env.DB
    .prepare('SELECT id FROM subscriber WHERE email = ?1')
    .bind(email)
    .first();

  if (found) {
    if (lsCustomer) {
      await env.DB
        .prepare('UPDATE subscriber SET ls_customer_id = ?2 WHERE id = ?1 AND ls_customer_id IS NULL')
        .bind(found.id, String(lsCustomer)).run();
    }
    return found.id;
  }

  const made = await env.DB
    .prepare(`INSERT INTO subscriber (email, ls_customer_id, created_at)
              VALUES (?1, ?2, ?3) RETURNING id`)
    .bind(email, lsCustomer ? String(lsCustomer) : null, now)
    .first();

  return made.id;
}

/** Из списка ключей отчётов оставляем только те, что есть в справочнике. */
async function validKeys(env, raw) {
  const asked = String(raw || '')
    .split(',')
    .map(v => v.trim().toLowerCase())
    .filter(v => /^[a-z_]{2,20}$/.test(v));

  if (!asked.length) return [];

  const rows = await env.DB.prepare('SELECT key FROM product').all();
  const known = new Set((rows.results || []).map(r => r.key));
  return [...new Set(asked.filter(k => known.has(k)))];
}

/** Русское склонение для подписи к платежу. */
function word(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5)   return few;
  if (b === 1)          return one;
  return many;
}

/** Дата из кассы приходит строкой ISO. */
function when(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return isNaN(t) ? null : Math.floor(t / 1000);
}

/** Запасной срок, если касса не прислала дату продления. */
function periodEnd(period, now) {
  return now + (period === 'month' ? 31 * 86400 : 365 * 86400);
}

/** Подпись кассы — HMAC-SHA256 сырого тела, шестнадцатеричной строкой. */
async function validSignature(raw, sig, secret) {
  if (!secret || !/^[0-9a-f]{64}$/i.test(sig || '')) return false;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');

  return equalHex(hex, String(sig).toLowerCase());
}

/* ------------------------------------------------------------------ */
/* оплата: создание чекаута в кассе                                     */
/* ------------------------------------------------------------------ */

/**
 * Витрина присылает состав заказа, воркер сам считает деньги.
 * Цена от клиента не принимается ни в каком виде: приходят только ключи
 * подписок и период, сумма собирается здесь по таблице ниже.
 *
 * Состав уходит в кассу полем checkout_data.custom и возвращается оттуда
 * вебхуком как meta.custom_data — те же два поля (dirs, period), которые
 * разбирает handleWebhook. Ничего третьего между ними не передаётся.
 */

/**
 * ЦЕНЫ ЛЕЖАТ В ДВУХ МЕСТАХ: здесь и в объекте BLOCKS внутри pricing.html.
 * Витрина обязана показывать ровно эти числа — менять всегда обе таблицы.
 * Ключи — те же, что в справочнике product базы: по одному на каждый отчёт,
 * плюс cockpit на все три живых инструмента разом.
 */
const PRICE = {
  wlm:     { month: 17, year: 136 },
  flows:   { month: 17, year: 136 },
  wpm:     { month: 17, year: 136 },
  wsm:     { month: 17, year: 136 },
  lead:    { month: 17, year: 136 },
  margin:  { month: 17, year: 136 },
  macro:   { month: 10, year: 80  },
  aicm:    { month: 10, year: 80  },
  qeg:     { month: 8,  year: 64  },
  cockpit: { month: 19, year: 152 }
};

/**
 * Полный доступ (все десять отчётов сразу) продаётся не суммой цен, а
 * отдельной сниженной ценой — скидка около 42 % к сумме поштучных цен.
 */
const FULL_PRICE = { month: 86, year: 690 };

/**
 * Имена и периодичность отчётов. Нужны кассе (покупатель должен видеть,
 * за что платит) и публикации выпусков (тот же код, что в имени файла
 * из R2, — это и есть product_key).
 */
const PRODUCT_INFO = {
  macro:   { title: 'Monthly US Macro',              cadence: 'month'   },
  wlm:     { title: 'Weekly Liquidity Monitor',      cadence: 'week'    },
  flows:   { title: 'Weekly Fund Flows',             cadence: 'week'    },
  wpm:     { title: 'Weekly Positioning Monitor',    cadence: 'week'    },
  wsm:     { title: 'Weekly Sentiment Monitor',      cadence: 'week'    },
  qeg:     { title: 'Quarterly Earnings & Guidance', cadence: 'quarter' },
  lead:    { title: 'Weekly Leadership Monitor',     cadence: 'week'    },
  margin:  { title: 'Weekly Margin Fragility',       cadence: 'week'    },
  aicm:    { title: 'Monthly AI Cycle Monitor',      cadence: 'month'   },
  cockpit: { title: 'Приборная доска',               cadence: 'live'    }
};

const ALL_PRODUCT_KEYS = Object.keys(PRICE);

function priceOf(key, period) {
  const row = PRICE[key];
  return row ? row[period] : null;
}

async function handleCheckout(body, env, url) {
  const period = (body && body.period) === 'month' ? 'month' : 'year';

  const asked = Array.isArray(body && body.products)
    ? body.products.join(',')
    : String((body && body.products) || '');

  // Ключи сверяются со справочником product — тем же, что и в вебхуке.
  const keys = await validKeys(env, asked);

  if (!keys.length) return json({ ok: false, error: 'Не выбран ни один отчёт.' }, 400);
  if (keys.length > ALL_PRODUCT_KEYS.length) {
    return json({ ok: false, error: 'В заказе больше отчётов, чем есть в линейке.' }, 400);
  }

  // Все десять — это полный доступ по отдельной, сниженной цене, не по сумме.
  const isFullAccess = keys.length === ALL_PRODUCT_KEYS.length &&
    ALL_PRODUCT_KEYS.every(k => keys.includes(k));

  let dollars;
  if (isFullAccess) {
    dollars = FULL_PRICE[period];
  } else {
    dollars = 0;
    for (const key of keys) {
      const price = priceOf(key, period);
      if (!price) return json({ ok: false, error: 'Для одного из отчётов не задана цена.' }, 500);
      dollars += price;
    }
  }

  // Интервал списания задаётся вариантом товара, поэтому вариант свой на каждый период.
  const variant = period === 'month' ? env.LS_VARIANT_MONTH : env.LS_VARIANT_YEAR;

  if (!env.LS_API_KEY || !env.LS_STORE_ID || !variant) {
    return json({ ok: false, error: 'Оплата пока не подключена. Напишите нам, оформим вручную.' }, 503);
  }

  const name = isFullAccess
    ? 'Helicopter View — полный доступ'
    : 'Helicopter View — ' + keys.length + ' ' +
      word(keys.length, 'подписка', 'подписки', 'подписок');

  const description = (isFullAccess ? 'Все десять отчётов и приборная доска' :
      keys.map(k => (PRODUCT_INFO[k] && PRODUCT_INFO[k].title) || k).join(' · ')) +
    (period === 'month' ? ' — помесячная оплата' : ' — годовая оплата');

  const payload = {
    data: {
      type: 'checkouts',
      attributes: {
        custom_price: dollars * 100,
        product_options: {
          name,
          description,
          redirect_url: url.origin + BUY_RETURN +
                        '?products=' + encodeURIComponent(keys.join(',')) + '&period=' + period,
          // Без этого касса покажет оба варианта товара, и покупатель,
          // выбравший на витрине месяц, сможет уехать на год с месячной суммой.
          enabled_variants: [Number(variant)]
        },
        checkout_data: { custom: { products: keys.join(','), period } },
        test_mode: env.LS_TEST_MODE === '1'
      },
      relationships: {
        store:   { data: { type: 'stores',   id: String(env.LS_STORE_ID) } },
        variant: { data: { type: 'variants', id: String(variant) } }
      }
    }
  };

  let res;
  try {
    res = await fetch(LS_API, {
      method: 'POST',
      headers: {
        'Accept':        'application/vnd.api+json',
        'Content-Type':  'application/vnd.api+json',
        'Authorization': 'Bearer ' + env.LS_API_KEY
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return json({ ok: false, error: 'Касса не отвечает. Попробуйте ещё раз.' }, 502);
  }

  if (!res.ok) {
    return json({ ok: false, error: 'Касса не приняла заказ. Попробуйте ещё раз.' }, 502);
  }

  const out  = await res.json().catch(() => null);
  const link = out && out.data && out.data.attributes && out.data.attributes.url;
  if (!link) return json({ ok: false, error: 'Касса не вернула ссылку на оплату.' }, 502);

  return json({ ok: true, url: link, amount_cents: dollars * 100 });
}

/* ------------------------------------------------------------------ */
/* публикация выпусков по расписанию                                   */
/* ------------------------------------------------------------------ */

const SITE_ORIGIN = 'https://www.hvmiresearch.com';

/**
 * Код в имени файла (slug выпуска: <код>-ГГГГ-ММ-ДД, файлы в R2:
 * <slug>.pdf и <slug>.summary.html) — это и есть product_key; имя и
 * периодичность берутся из PRODUCT_INFO выше. cockpit сюда не попадает —
 * у живых инструментов нет PDF-выпусков.
 */

/**
 * Один проход расписания: собрать содержимое бакета, найти готовые пары,
 * завести новые выпуски, разослать письма. Каждый slug обрабатывается
 * независимо — ошибка одного не останавливает остальные, а пишется
 * в webhook_event с kind='publish_error' (там её видно из консоли D1).
 */
async function publishPending(env) {
  await ensureNotifyColumn(env);

  const pdfs = new Map();   // slug → размер PDF в байтах
  const sums = new Set();   // слаги, у которых уже лежит summary
  let cursor;
  do {
    const page = await env.R2.list({ cursor, limit: 1000 });
    for (const o of page.objects || []) {
      let m = o.key.match(/^([a-z]+-\d{4}-\d{2}-\d{2})\.pdf$/);
      if (m) { pdfs.set(m[1], o.size); continue; }
      m = o.key.match(/^([a-z]+-\d{4}-\d{2}-\d{2})\.summary\.html$/);
      if (m) sums.add(m[1]);
    }
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);

  for (const [slug, bytes] of pdfs) {
    if (!sums.has(slug)) continue;   // второй файл пары ещё не загружен — ждём
    try {
      await publishOne(env, slug, bytes);
    } catch (e) {
      await logPublishError(env, slug, e);
    }
  }
}

async function publishOne(env, slug, bytes) {
  const m    = slug.match(/^([a-z]+)-(\d{4})-(\d{2})-(\d{2})$/);
  const code = m && m[1];
  const spec = code && PRODUCT_INFO[code];
  if (!spec || code === 'cockpit') return;   // код не из справочника отчётов — файл не наш, не трогаем

  const known = await env.DB
    .prepare('SELECT slug FROM issue WHERE slug = ?1')
    .bind(slug)
    .first();

  if (!known) {
    const published = Date.parse(`${m[2]}-${m[3]}-${m[4]}T00:00:00Z`);
    if (isNaN(published)) throw new Error('дата в имени файла не разбирается');

    const obj = await env.R2.get(`${slug}.summary.html`);
    if (!obj) return;   // summary исчез между просмотром бакета и чтением — подождём следующего прохода
    const summary = (await obj.text()).trim();
    if (!summary)               throw new Error('файл summary пуст');
    if (summary.length > 100000) throw new Error('файл summary подозрительно велик — загружен не тот файл?');

    await env.DB
      .prepare(`INSERT OR IGNORE INTO issue
                  (slug, product_key, title, cadence, published_at,
                   is_published, summary_html, pdf_key, pdf_bytes, notified_at)
                VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, NULL)`)
      .bind(slug, code,
            `${spec.title} — ${m[4]}.${m[3]}.${m[2]}`,
            spec.cadence, Math.floor(published / 1000),
            summary, `${slug}.pdf`, bytes)
      .run();
  }

  // Отметка о рассылке ставится ДО отправки: если проход оборвётся на середине,
  // часть писем потеряется, но никто не получит письмо дважды. У выпусков,
  // существовавших до появления колонки, notified_at = 0 — они не рассылаются.
  const claim = await env.DB
    .prepare('UPDATE issue SET notified_at = ?2 WHERE slug = ?1 AND notified_at IS NULL')
    .bind(slug, unix())
    .run();
  if (!claim || !claim.meta || claim.meta.changes === 0) return;   // уже разослано

  await notifyIssue(env, slug, code, spec);
}

/** Письмо каждому, у кого оплачен этот отчёт. */
async function notifyIssue(env, slug, code, spec) {
  const now  = unix();
  const rows = await env.DB
    .prepare(`SELECT COALESCE(NULLIF(TRIM(u.deliver_email), ''), u.email) AS addr
                FROM entitlement e JOIN subscriber u ON u.id = e.subscriber_id
               WHERE e.product_key = ?1 AND e.status = 'active'
                 AND e.expires_at > ?2 AND u.blocked_at IS NULL`)
    .bind(code, now)
    .all();

  const link = `${SITE_ORIGIN}/app/issue/${slug}`;
  for (const r of (rows.results || [])) {
    await sendIssueMail(env, r.addr, spec.title, link);
    await pause(600);   // Resend принимает не больше двух писем в секунду
  }
}

async function sendIssueMail(env, to, product, link) {
  const text =
    `Вышел новый выпуск: ${product}.\n\n` +
    `Читать и скачать PDF: ${link}\n\n` +
    'Helicopter View Market Intelligence';

  const html =
    '<div style="font-family:Manrope,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">' +
      `<p style="margin:0 0 18px">Вышел новый выпуск: <strong>${product}</strong>.</p>` +
      `<p style="margin:0 0 24px"><a href="${link}" style="color:#0050b3">Читать выпуск и скачать PDF</a></p>` +
      '<p style="margin:0;font-size:11px;color:#767676">Helicopter View Market Intelligence</p>' +
    '</div>';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: `Новый выпуск — ${product}`, text, html })
    });
    return res.ok;
  } catch (e) {
    return false;   // одно неушедшее письмо не останавливает рассылку остальным
  }
}

/**
 * Колонка отметки о рассылке. Добавляется на лету при первом проходе:
 * существовавшие к этому моменту выпуски получают 0 («рассылка не нужна»),
 * новые вставляются с NULL («ждёт рассылки»).
 */
async function ensureNotifyColumn(env) {
  try {
    await env.DB.prepare('ALTER TABLE issue ADD COLUMN notified_at INTEGER DEFAULT 0').run();
  } catch (e) { /* колонка уже есть — это норма */ }
}

/** Ошибка публикации → строка в webhook_event, видна из консоли D1. */
async function logPublishError(env, slug, e) {
  try {
    await env.DB
      .prepare(`INSERT OR REPLACE INTO webhook_event (id, kind, received_at, error, payload)
                VALUES (?1, 'publish_error', ?2, ?3, ?4)`)
      .bind(`publish:${slug}`, unix(), String((e && e.message) || e).slice(0, 500), slug)
      .run();
  } catch (_) { /* журнал не должен ронять публикацию */ }
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ------------------------------------------------------------------ */
/* письмо через Resend                                                 */
/* ------------------------------------------------------------------ */

async function sendCode(env, email, code) {
  const text =
    `Код для входа: ${code}\n\n` +
    'Введите его на странице входа. Код действует 15 минут и работает один раз.\n\n' +
    'Если вход запрашивали не вы, письмо можно не открывать — без кода доступ не откроется.\n\n' +
    'Helicopter View Market Intelligence';

  const html =
    '<div style="font-family:Manrope,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">' +
      '<p style="margin:0 0 18px">Код для входа в Helicopter View:</p>' +
      `<p style="margin:0 0 18px;font-size:28px;letter-spacing:.3em;font-weight:600">${code}</p>` +
      '<p style="margin:0 0 18px">Введите его на странице входа. Код действует 15 минут и работает один раз.</p>' +
      '<p style="margin:0 0 24px;color:#767676">Если вход запрашивали не вы, письмо можно не открывать — ' +
        'без кода доступ не откроется.</p>' +
      '<p style="margin:0;font-size:11px;color:#767676">Helicopter View Market Intelligence</p>' +
    '</div>';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject: 'Код для входа — Helicopter View', text, html })
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* форма контактов → письмо на hello@                                  */
/* ------------------------------------------------------------------ */

const CONTACT_TO     = 'hello@hvmiresearch.com';
const CONTACT_TOPICS = {
  subscription: 'Подписка и оплата',
  products:     'Продукты и доступ',
  press:        'Пресса и партнёрства',
  other:        'Другое'
};

async function handleContact(body, env) {
  const topic   = CONTACT_TOPICS[String((body && body.topic) || '')] || null;
  const email   = normalizeEmail(body && body.email);
  const name    = String((body && body.name)    || '').trim().slice(0, 100);
  const company = String((body && body.company) || '').trim().slice(0, 200);
  const message = String((body && body.message) || '').trim().slice(0, 5000);

  if (!topic || !email || !name || !message) {
    return json({ ok: false, error: 'Заполните тему, имя, почту и сообщение.' }, 400);
  }

  const text =
    `Тема: ${topic}\n` +
    `Имя: ${name}\n` +
    `Почта: ${email}\n` +
    (company ? `Компания: ${company}\n` : '') +
    `\n${message}\n`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [CONTACT_TO],
        reply_to: email,
        subject: `Запрос с сайта — ${topic}`,
        text
      })
    });
    if (!res.ok) return json({ ok: false, error: 'Не удалось отправить запрос. Попробуйте позже.' }, 502);
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: 'Не удалось отправить запрос. Попробуйте позже.' }, 502);
  }
}

/* ------------------------------------------------------------------ */
/* вспомогательное                                                     */
/* ------------------------------------------------------------------ */

function unix() { return Math.floor(Date.now() / 1000); }

/* Тело уже прочитано в route() с проверкой размера — здесь только разбор. */
function parseBody(raw) {
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

/* Для маршрутов зоны, где тело читается на месте: тот же предел размера. */
async function safeJson(request) {
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return null;   // слишком велико — вызывающий отвечает 413
    return parseBody(raw);
  } catch (e) { return {}; }
}

function normalizeEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s.length < 6 || s.length > 254) return null;
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s)) return null;
  return s;
}

function randomCode() {
  const buf = new Uint32Array(1);
  const limit = 4294967296 - (4294967296 % 1000000);
  let v;
  do { crypto.getRandomValues(buf); v = buf[0]; } while (v >= limit);
  return String(v % 1000000).padStart(6, '0');
}

function randomToken() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashWith(value, secret) {
  const data = new TextEncoder().encode(`${value}:${secret || ''}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function equalHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return /^[A-Za-z0-9._~-]{20,200}$/.test(v) ? v : null;
    }
  }
  return null;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {})
  });
}

/** Ждать запись в базу не обязательно — ответ пользователю не должен от неё зависеть. */
function ctxWaitOrRun(promise) { promise.catch(() => {}); }
