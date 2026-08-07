/**
 * American Investor — единый Worker сайта.
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
 *   POST /app/api/order      { kind, subject, context } → заказ разового разбора, возвращает ссылку на оплату
 *   GET  /app/api/orders                              → заказы подписчика для страницы «Заказы»
 *   POST /api/contact        { topic, name, email, company, message } → письмо с формы контактов на hello@
 *   POST /api/indicator      { key, value, note, tone, asof }  → показание индикатора от прогона отчёта (закрыт секретом)
 *   GET  /api/indicators                              → значения индикаторов для страниц (открыто;
 *                                                     без входа — только пять макропоказателей главной)
 *   всё под /app/*                                   → пропускает только с живой сессией
 *   /app/bottom · /app/tott · /app/gex                → дополнительно требуют оплаченной Приборной доски
 *   всё остальное                                    → отдаёт как есть (витрина, вход, legal)
 *   по расписанию (каждые 15 минут)                   → публикация выпусков из R2 + письма подписчикам
 *                                                     + пересчёт заглавного числа Peak Signal в таблицу indicator
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
 *   INDICATOR_TOKEN   случайная строка от 32 символов; ею прогон отчёта подписывает
 *                     показание индикатора (заголовок Authorization: Bearer <строка>)
 *
 * Обычные переменные (можно в wrangler.jsonc, можно тоже в панели):
 *   MAIL_FROM        American Investor <login@americaninvestor.capital>
 *   APP_HOME         /app/overview.html
 *   LS_STORE_ID      номер магазина в Lemon Squeezy
 *   LS_VARIANT_YEAR  номер годового варианта товара подписки
 *   LS_VARIANT_MONTH номер помесячного варианта того же товара
 *   LS_TEST_MODE     '1' — оплата открывается в тестовом режиме кассы
 *   LS_VARIANT_ONEOFF номер варианта товара для разового разбора
 *   ORDER_NOTIFY_TO  куда слать письмо о новом оплаченном разборе
 *                    (не задано — уходит на hello@americaninvestor.capital)
 *
 * Вариантов два, потому что интервал списания в кассе живёт на варианте,
 * а не на чекауте. Цену обоих назначает этот воркер.
 *
 * Пока ключ, магазин и нужный вариант не заведены, маршрут оплаты
 * отвечает 503 с внятным текстом — остальной сайт от этого не страдает.
 */

const CODE_TTL       = 900;          // код живёт 15 минут
const MAX_ATTEMPTS   = 5;            // попыток ввода на один код
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
const CANON_HOST     = 'www.americaninvestor.capital';   // единственный канонический хост; апекс переадресуется сюда

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
    if (url.hostname !== CANON_HOST && url.hostname.endsWith('americaninvestor.capital')) {
      url.hostname = CANON_HOST;
      return harden(Response.redirect(url.toString(), 301));
    }

    if (isBlockedPath(url.pathname)) {
      return harden(new Response('Not found', { status: 404 }));
    }

    return harden(await route(request, env, ctx, url));
  },

  /**
   * Расписание (wrangler.jsonc → triggers.crons). Раз в 15 минут смотрим
   * бакет R2: каждая пара slug.pdf + slug.summary.html, которой ещё нет в
   * базе, становится выпуском, подписчики получают письмо. Дважды в сутки
   * отдельным заходом обновляется запас опционных цепочек для GEX.
   */
  async scheduled(event, env, ctx) {
    return handleScheduled(event, env, ctx);
  }
};

/* Маршрутизация запроса — прежнее тело fetch без изменений. */
async function route(request, env, ctx, url) {
  const path = url.pathname;

    // Загрузка файлов выпусков со страницы публикации. Файлы пары весят около
    // мегабайта, поэтому маршрут разбирает multipart-тело сам и в общий предел
    // размера POST-запросов не входит. Закрыт паролем публикации (adminGate).
    if (request.method === 'POST' && path === '/api/admin/upload') {
      return adminSafe(() => handleAdminUpload(request, env));
    }

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

    // Справочник линейки: названия, периодичность, цены подписки и разовых
    // разборов. Открыт намеренно — те же сведения стоят на странице тарифов,
    // и держать их вторую копию в вёрстке уже приводило к расхождению цены.
    if (request.method === 'GET' && path === '/api/catalog') {
      return apiCatalog(env);
    }

    // Заказ разового разбора с витрины: покупателю не нужен вход в кабинет,
    // поэтому маршрут открытый. Подписчик находится или заводится по почте.
    if (request.method === 'POST' && path === '/api/order') {
      return handlePublicOrder(parseBody(raw), env, url);
    }

    // Показание индикатора от прогона отчёта. Маршрут открытый: у прогона нет
    // и не должно быть сессии подписчика, поэтому он закрыт отдельным секретом.
    if (request.method === 'POST' && path === '/api/indicator') {
      return handleIndicatorPut(request, parseBody(raw), env);
    }

    // Служебные запросы страницы публикации: состояние выпусков, замена
    // записи выпуска, смена пароля публикации. Тела маленькие, идут общим путём.
    if (request.method === 'POST' && path === '/api/admin/check') {
      return adminSafe(() => handleAdminCheck(parseBody(raw), env));
    }
    if (request.method === 'POST' && path === '/api/admin/replace') {
      return adminSafe(() => handleAdminReplace(parseBody(raw), env));
    }
    if (request.method === 'POST' && path === '/api/admin/remove') {
      return adminSafe(() => handleAdminRemove(parseBody(raw), env));
    }
    if (request.method === 'POST' && path === '/api/admin/issues') {
      return adminSafe(() => handleAdminIssues(parseBody(raw), env));
    }
    if (request.method === 'POST' && path === '/api/admin/password') {
      return adminSafe(() => handleAdminPassword(parseBody(raw), env));
    }

    // Значения индикаторов для страниц. Тоже открыто: блок живых индикаторов
    // стоит не только в кабинете, но и на главной витрины.
    if (request.method === 'GET' && path === '/api/indicators') {
      return handleIndicators(request, env);
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

    // Публичная статика. Страницы отдаются как раньше — с обязательной
    // проверкой при каждом заходе, иначе правка сайта дойдёт до посетителя
    // с задержкой. Файлам из assets и картинкам ставится срок жизни в кэше
    // браузера: без него каждый переход по сайту тянет CSS и JS по сети.
    {
      const res = await env.ASSETS.fetch(request);
      const cc = staticCacheControl(path);
      if (!cc || !res.ok) return res;
      const out = new Response(res.body, res);
      out.headers.set('Cache-Control', cc);
      return out;
    }
}

/**
 * Срок жизни публичного файла в кэше браузера.
 * null — не трогать заголовок (HTML-страницы и всё прочее).
 * Имена файлов при выпуске не меняются, поэтому срок для стилей и скрипта
 * держится коротким: правка доходит до вернувшегося посетителя в пределах часа,
 * а до этого файл берётся из кэша и в фоне обновляется.
 */
function staticCacheControl(path) {
  if (/\.(css|js)$/i.test(path))  return 'public, max-age=3600, stale-while-revalidate=86400';
  if (/\.(png|jpe?g|webp|gif|svg|ico|woff2?|pdf)$/i.test(path)) return 'public, max-age=604800';
  return null;
}

/*
 * Два расписания в одном обработчике (wrangler.jsonc → triggers.crons):
 *   «*\/15 * * * *»    — публикация выпусков и дописывание ряда put/call;
 *   «0 11,21 * * 1-5» — полный обход опционных цепочек для GEX.
 * Цепочки разведены отдельно по двум причинам. Открытый интерес меняется
 * раз в сутки, поэтому качать 133 МБ каждые 15 минут незачем. И у запуска
 * с интервалом от часа потолок процессорного времени 15 минут вместо 30
 * секунд — полный обход в него укладывается с запасом.
 */
async function handleScheduled(event, env, ctx) {
  const cron = event && event.cron ? String(event.cron) : '';
  const frequent = cron.startsWith('*/15');
  const when = new Date(event && event.scheduledTime ? event.scheduledTime : Date.now());

  if (!cron || frequent) {
    ctx.waitUntil(publishPending(env));
    ctx.waitUntil(refreshPutcall(env));
    ctx.waitUntil(refreshPeakSignal(env).catch(() => {}));
    ctx.waitUntil(refreshBottomSignal(env).catch(() => {}));
    ctx.waitUntil(refreshGex(env).catch(() => {}));
    ctx.waitUntil(refreshHomeStats(env).catch(() => {}));
    // Обход рынка идёт по воскресеньям: биржа закрыта, спешить некуда,
    // а девяноста шести запусков за сутки хватает на весь справочник.
    if (when.getUTCDay() === 0) ctx.waitUntil(scanUniverse(env));
  }
  if (!cron || !frequent) {
    ctx.waitUntil(refreshChains(env));
    ctx.waitUntil(cleanupStale(env).catch(() => {}));
  }
}

/** Сколько держим неоплаченный заказ, прежде чем считать его брошенным. */
const KEEP_UNPAID_DAYS = 30;

/**
 * Уборка следов незавершённых покупок.
 *
 * Заказ записывается в базу ДО оплаты, а покупатель заводится по одной только
 * почте из формы на витрине. Значит каждый, кто начал оформление и не дошёл до
 * кассы, оставляет строку заказа и строку покупателя. Доступа они не дают, но
 * копятся и попадают в глаза при разборе базы.
 *
 * Убираем только заведомо брошенное:
 *   - заказы «ожидает оплаты» старше KEEP_UNPAID_DAYS (отменённые вручную
 *     оставляем: это история покупателя, он её видит в кабинете);
 *   - просроченные коды входа и сессии;
 *   - покупателей, у которых после этого не осталось НИЧЕГО — ни прав доступа,
 *     ни платежей, ни заказов, ни живых сессий.
 *
 * Оплаченное не трогается ни при каких условиях: строка платежа и строка права
 * доступа сами по себе держат покупателя в базе. Подписчик QA исключён отдельно,
 * чтобы уборка не выбила его во время проверок.
 */
async function cleanupStale(env) {
  const now    = unix();
  const cutoff = now - KEEP_UNPAID_DAYS * 86400;

  // Сначала файлы брошенных заказов, потом сами записи: после удаления строк
  // ключи в R2 уже не найти, и файлы остались бы лежать навсегда.
  const doomed = await env.DB
    .prepare(`SELECT file_key FROM order_request
               WHERE status = 'wait' AND created_at < ?1 AND file_key IS NOT NULL`)
    .bind(cutoff).all();

  for (const row of (doomed.results || [])) {
    try { await env.R2.delete(row.file_key); } catch (e) {}
  }

  await env.DB
    .prepare(`DELETE FROM order_request
               WHERE status = 'wait' AND created_at < ?1`)
    .bind(cutoff).run();

  await env.DB.prepare('DELETE FROM login_code WHERE expires_at < ?1').bind(now).run();
  await env.DB.prepare('DELETE FROM session    WHERE expires_at < ?1').bind(now).run();

  await env.DB
    .prepare(`DELETE FROM subscriber
               WHERE created_at < ?1
                 AND id <> ?2
                 AND NOT EXISTS (SELECT 1 FROM entitlement   e WHERE e.subscriber_id = subscriber.id)
                 AND NOT EXISTS (SELECT 1 FROM payment       p WHERE p.subscriber_id = subscriber.id)
                 AND NOT EXISTS (SELECT 1 FROM order_request o WHERE o.subscriber_id = subscriber.id)
                 AND NOT EXISTS (SELECT 1 FROM session       s WHERE s.subscriber_id = subscriber.id)`)
    .bind(cutoff, QA_SID).run();
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

/** /app/api/me · issues · issue · payments · renew · notify · logout · email-code · email-confirm */
function apiName(url) {
  const m = url.pathname.match(/^\/app\/api\/(me|issues|issue|catalog|payments|renew|notify|logout|email-code|email-confirm|proxy|cboe|putcall|coverage|order|order-cancel|orders)\/?$/);
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

const POST_ONLY = ['renew', 'notify', 'logout', 'email-code', 'email-confirm',
                   'order', 'order-cancel'];

async function serveApiInner(request, env, url, sid, name) {
  if (POST_ONLY.includes(name)) {
    if (request.method !== 'POST') return json({ ok: false, error: 'Только POST.' }, 405);

    if (name === 'logout') return apiLogout(request, env);

    const body = await safeJson(request);
    if (body === null) return json({ ok: false, error: 'Запрос слишком велик.' }, 413);

    if (name === 'renew')         return apiRenew(body, env, sid);
    if (name === 'notify')        return apiNotify(body, env, sid);
    if (name === 'email-code')    return apiEmailCode(body, env, sid);
    if (name === 'email-confirm') return apiEmailConfirm(body, env, sid);
    if (name === 'order')         return apiOrder(body, env, sid, url);
    if (name === 'order-cancel')  return apiOrderCancel(body, env, sid);
  }

  if (request.method !== 'GET') return json({ ok: false, error: 'Только GET.' }, 405);

  if (name === 'me')       return apiMe(env, sid);
  if (name === 'issues')   return apiIssues(env, url, sid);
  if (name === 'issue')    return apiIssue(env, url, sid);
  if (name === 'catalog')  return apiCatalog(env);
  if (name === 'orders')   return apiOrders(env, sid);
  if (name === 'payments') return apiPayments(env, sid);
  if (name === 'proxy')    return apiProxy(env, url);
  if (name === 'cboe')     return apiCboe(env, url);
  if (name === 'putcall')  return apiPutcall(env, url);
  if (name === 'coverage') return apiCoverage(env);

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
    .prepare(`SELECT i.slug, i.product_key AS product, i.title, i.cadence,
                     i.published_at AS published, i.summary_html AS summary, i.pdf_key AS key,
                     p.title AS product_title
                FROM issue i
                LEFT JOIN product p ON p.key = i.product_key
               WHERE i.slug = ?1 AND i.is_published = 1`)
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
      /* Название отчёта — из справочника product: единственное место,
         где имена хранятся. Страница их у себя не держит. */
      product_title: row.product_title || row.product,
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
 * Справочник линейки для страниц зоны: название, периодичность, цена,
 * комплекс. Названия берутся из таблицы product — единственного места, где
 * они хранятся; цены и состав комплексов лежат в этом файле. Страницы своих
 * копий не держат.
 */
async function apiCatalog(env) {
  const rows = await env.DB
    .prepare('SELECT key, title, cadence, sort FROM product ORDER BY sort')
    .all();

  const products = (rows.results || []).map(r => ({
    key:      r.key,
    title:    r.title,
    cadence:  r.cadence,
    complex:  COMPLEX[r.key] || null,
    parts:    PARTS[r.key] || null,
    price:    PRICE[r.key] || null
  }));

  // Разовые разборы идут отдельным разделом: подписки у них нет, справочника
  // product тоже — но цена и название нужны и витрине, и странице заказа.
  const oneoff = Object.keys(ONEOFF).map(k => ({
    kind:  k,
    title: ONEOFF[k].title,
    what:  ONEOFF[k].what,
    price: ONEOFF[k].price
  }));

  return json({ ok: true, products, oneoff, order_days: ORDER_DAYS });
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

/** Адрес для рассылки выпусков — отдельно от адреса входа. Пустое значение возвращает к адресу входа. */
async function apiNotify(body, env, sid) {
  const raw = String((body && body.deliver_email) || '').trim();
  let value = null;
  if (raw) {
    value = normalizeEmail(raw);
    if (!value) return json({ ok: false, error: 'Проверьте адрес — он выглядит неверно.' }, 400);
  }

  await env.DB.prepare('UPDATE subscriber SET deliver_email = ?2 WHERE id = ?1').bind(sid, value).run();
  return json({ ok: true, deliver_email: value });
}

/** Выход: гасим текущую сессию по её токену из куки и чистим куку в ответе. */
async function apiLogout(request, env) {
  const token = readCookie(request, COOKIE_NAME);
  if (token) {
    await env.DB
      .prepare('UPDATE session SET revoked_at = ?2 WHERE id = ?1')
      .bind(await hashWith(token, env.AUTH_SECRET), unix())
      .run();
  }
  return json({ ok: true }, 200, {
    'Set-Cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
  });
}

/* ------------------------------------------------------------------ */
/* запас опционных цепочек для GEX                                     */
/* CBOE закрывает доступ по стране посетителя, и посредник тут не      */
/* спасает: запрос всё равно уходит с учётом того, откуда пришёл       */
/* человек. У работы по расписанию посетителя нет вовсе, поэтому       */
/* цепочки скачиваются заранее и кладутся в R2, а страница читает      */
/* готовое. Данные CBOE и так с задержкой 15 минут, обновление раз в   */
/* 15 минут ничего не ухудшает.                                        */
/* ------------------------------------------------------------------ */

/* Покрытие GEX. Рабочий список живёт в feed/cboe-coverage.json и       */
/* пересобирается еженедельным обходом всего рынка (см. ниже). Список  */
/* здесь — запасной: он же результат ручного замера 02.08.2026 и       */
/* используется, пока файл покрытия не собран или недоступен.          */
const CHAIN_FALLBACK = [
  'SPX', 'NDX', 'RUT', 'SPY', 'QQQ', 'IWM', 'DIA', 'VOO',
  'SMH', 'SOXX', 'XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLP',
  'XBI', 'XOP', 'KRE', 'ARKK', 'EEM', 'URA', 'GLD', 'SLV',
  'GDX', 'USO', 'TLT', 'NVDA', 'MSFT', 'AAPL', 'AMZN', 'GOOGL',
  'META', 'AVGO', 'AMD', 'MU', 'INTC', 'TSM', 'ASML', 'AMAT',
  'LRCX', 'QCOM', 'TXN', 'ADI', 'ON', 'ARM', 'ADBE', 'ORCL',
  'IBM', 'CSCO', 'CRWD', 'PANW', 'ZS', 'DDOG', 'CDNS', 'SNPS',
  'INTU', 'TEAM', 'APP', 'SHOP', 'PLTR', 'TSLA', 'TTWO', 'CHTR',
  'DASH', 'JPM', 'C', 'GS', 'BLK', 'AXP', 'SCHW', 'WFC',
  'V', 'MA', 'COIN', 'HOOD', 'MSTR', 'LLY', 'UNH', 'ISRG',
  'AMGN', 'MRK', 'JNJ', 'VRTX', 'ABT', 'ABBV', 'CVS', 'GILD',
  'REGN', 'COST', 'WMT', 'TGT', 'KO', 'PEP', 'PG', 'MCD',
  'SBUX', 'NKE', 'LULU', 'DIS', 'BKNG', 'DLTR', 'HD', 'ABNB',
  'MELI', 'BABA', 'CVNA', 'CAT', 'DE', 'LMT', 'GE', 'BA',
  'AVAV', 'UPS', 'FDX', 'UAL', 'DAL', 'GM', 'COP', 'CVX',
  'CEG', 'OKLO'
];

const chainKey = sym => 'feed/cboe-chain-' + sym + '.json';
const CHAIN_MAX_AGE = 24 * 3600;   // сколько живёт сохранённый срез, секунд
const sleep = ms => new Promise(r => setTimeout(r, ms));

const COVERAGE_KEY = 'feed/cboe-coverage.json';
const UNIVERSE_KEY = 'feed/cboe-universe.json';
const SCAN_KEY     = 'feed/cboe-scan.json';

/* Отсечки покрытия. Вход строже выхода: имя на границе иначе прыгало бы   */
/* в список и обратно каждую неделю, а вместе с ним — меню у подписчика.   */
const COV = {
  stepMax: 1.3,   // шаг сетки страйков, % цены — грубее уровень не назвать
  inMin:   300,   // живых контрактов в ближних 45 днях, чтобы войти
  outMin:  200,   // ниже этого имя выпадает, но только со второго раза
  misses:  2
};

/**
 * Рабочий список имён: покрытие из обхода ПЛЮС базовый список. Объединение,
 * а не замена: обход зависит от биржи и в плохой круг возвращает обрезанный
 * список, а основные инструменты должны быть доступны всегда.
 */
function withBaseline(syms) {
  const out = [], seen = new Set();
  for (const s of syms.concat(CHAIN_FALLBACK)) {
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

async function activeSymbols(env) {
  try {
    const o = await env.R2.get(COVERAGE_KEY);
    if (o) {
      const c = await o.json();
      if (c && Array.isArray(c.symbols) && c.symbols.length) {
        return withBaseline(c.symbols.map(x => x.s));
      }
    }
  } catch (e) { /* остаётся запасной */ }
  return CHAIN_FALLBACK.slice();
}

/** GET /app/api/coverage — что сейчас в покрытии и по каким меркам. */
async function apiCoverage(env) {
  const o = await env.R2.get(COVERAGE_KEY);
  if (o) {
    try {
      const c = await o.json();
      const known = new Map((c.symbols || []).map(x => [x.s, x]));
      const symbols = withBaseline((c.symbols || []).map(x => x.s))
        .map(s => known.get(s) || { s });
      return json({ ...c, count: symbols.length, symbols });
    } catch (e) { /* испорченный файл — ниже запасной список */ }
  }
  return json({
    ok: true, source: 'fallback', thresholds: COV,
    symbols: CHAIN_FALLBACK.map(s => ({ s })), count: CHAIN_FALLBACK.length
  });
}

/** Скачать цепочку и вернуть срез — то же, что отдаёт /app/api/cboe. */
async function fetchChainSlice(sym) {
  const d = await cboeChainFetch(sym);
  if (!d || !Array.isArray(d.options)) throw new Error('неожиданный вид данных');

  const options = [];
  for (const o of d.options) {
    const iv = +o.iv, oi = +o.open_interest;
    if (!o.option || !(iv > 0.01) || !(oi > 0)) continue;
    options.push({ option: o.option, iv, open_interest: oi });
  }
  return { data: { current_price: +d.current_price, options }, stored_at: unix() };
}

/**
 * Обновить запас. Итог каждого захода пишется в feed/cboe-status.json —
 * по нему видно, пропускает ли CBOE запросы расписания вообще.
 */
async function refreshChains(env) {
  const report = {};
  let ok = 0, fail = 0;

  // CBOE отбивает частые запросы кодом 429 — замер показал предел около
  // шести одновременных. Поэтому строго по одному, с паузой между именами
  // и одним повтором после ожидания.
  const list = await activeSymbols(env);
  for (const sym of list) {
    let saved = false;
    for (let attempt = 0; attempt < 2 && !saved; attempt++) {
      try {
        const slice = await fetchChainSlice(sym);
        await env.R2.put(chainKey(sym), JSON.stringify(slice), {
          httpMetadata: { contentType: 'application/json; charset=utf-8' }
        });
        report[sym] = 'ok · контрактов ' + slice.data.options.length;
        saved = true; ok++;
      } catch (e) {
        const msg = String(e.message || e);
        if (attempt === 0 && /429/.test(msg)) { await sleep(4000); continue; }
        report[sym] = 'сбой · ' + msg.slice(0, 120);
        fail++;
      }
    }
    await sleep(250);
  }
  report._итог = 'обновлено ' + ok + ', сбоев ' + fail + ', всего ' + list.length;

  await env.R2.put('feed/cboe-status.json',
    JSON.stringify({ checked_at: unix(), symbols: list, result: report }),
    { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
}

/* ------------------------------------------------------------------ */
/* еженедельный обход рынка и пересборка покрытия                      */
/*                                                                     */
/* Справочник опционных имён CBOE публикует сам — 5 300 с лишним строк,*/
/* новые размещения появляются там без нашего участия. Раз в неделю мы */
/* проходим его целиком и считаем по каждому имени две мерки: шаг      */
/* сетки страйков в процентах цены (точность, с какой вообще можно     */
/* назвать уровень) и число живых контрактов в ближних 45 днях (масса, */
/* из которой уровень складывается). Прошедшие обе — и есть покрытие.  */
/*                                                                     */
/* Обход режется на куски: 5 300 цепочек — это около часа работы и     */
/* полтора гигабайта, в один запуск не влезает. Куски идут по          */
/* воскресеньям на обычном пятнадцатиминутном расписании; закладка     */
/* лежит в R2, поэтому обход продолжается с того места, где встал.     */
/* Цепочки непрошедших имён не сохраняются — только два числа.         */
/* ------------------------------------------------------------------ */

const SYMBOL_DIR_URL = 'https://www.cboe.com/us/options/symboldir/equity_index_options/?download=csv';
const SCAN_BUDGET = 200;   // имён за один запуск

/** Справочник имён с опционами. Вторая колонка CSV — тикер. */
async function fetchUniverse() {
  const r = await fetch(SYMBOL_DIR_URL, {
    headers: { 'User-Agent': FEED_UA, Accept: 'text/csv,*/*' }, redirect: 'follow'
  });
  if (!r.ok) throw new Error('справочник CBOE: HTTP ' + r.status);
  const text = await r.text();

  const out = new Set();
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('","');
    if (cells.length < 2) continue;
    const sym = cells[1].replace(/"/g, '').trim().toUpperCase();
    if (/^[A-Z]{1,5}$/.test(sym)) out.add(sym);
  }
  if (out.size < 1000) throw new Error('справочник разобран неверно: имён ' + out.size);
  return [...out].sort();
}

/** Две мерки по сырой цепочке. Возвращает null, если считать не из чего. */
function chainMetrics(d) {
  const spot = +d.current_price;
  if (!(spot > 0) || !Array.isArray(d.options)) return null;

  const nowMs = Date.now();
  const near = new Set();
  let n = 0;
  for (const o of d.options) {
    const m = OCC_RE.exec(o.option || '');
    if (!m) continue;
    const iv = +o.iv, oi = +o.open_interest;
    if (!(iv > 0.01) || !(oi > 0)) continue;
    const y = 2000 + (+m[2].slice(0, 2)), mo = (+m[2].slice(2, 4)) - 1, dd = +m[2].slice(4, 6);
    const dte = (Date.UTC(y, mo, dd, 16, 0, 0) - nowMs) / 86400000;
    if (!(dte > 0 && dte <= 45)) continue;
    n++;
    const k = (+m[4]) / 1000;
    if (Math.abs(k - spot) / spot <= 0.10) near.add(k);
  }
  const ks = [...near].sort((a, b) => a - b);
  if (ks.length < 3) return { n, pct: null };

  const gaps = [];
  for (let i = 1; i < ks.length; i++) gaps.push(ks[i] - ks[i - 1]);
  gaps.sort((a, b) => a - b);
  return { n, pct: +(gaps[Math.floor(gaps.length / 2)] / spot * 100).toFixed(3) };
}

const OCC_RE = /^(.+?)(\d{6})([PC])(\d{8})$/;

/** Сырая цепочка без среза — нужна только для замера. */
/**
 * Запрос цепочки к CBOE с повтором. Биржа отбивает частые обращения не только
 * кодом 429: наблюдался и 403. Поэтому повтор делается при ЛЮБОМ отказе, а не
 * по списку кодов — единственное исключение 404, когда имени просто нет.
 */
async function cboeChainFetch(sym) {
  const indices = new Set(['SPX', 'NDX', 'RUT', 'VIX', 'DJX']);
  const src = 'https://cdn.cboe.com/api/global/delayed_quotes/options/' +
              (indices.has(sym) ? '_' + sym : sym) + '.json';
  let lastErr = 'неизвестная ошибка';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(attempt * 3000);
    try {
      const r = await fetch(src, { headers: { 'User-Agent': FEED_UA, Accept: '*/*' }, redirect: 'follow' });
      if (r.status === 404) throw new Error('HTTP 404');
      if (!r.ok) { lastErr = 'HTTP ' + r.status; continue; }
      const body = await r.json();
      return body && body.data ? body.data : null;
    } catch (e) {
      lastErr = String(e.message || e);
      if (/404/.test(lastErr)) break;
    }
  }
  throw new Error(lastErr);
}

async function fetchChainRaw(sym) {
  return cboeChainFetch(sym);
}

/** Один кусок обхода. Дойдя до конца справочника, пересобирает покрытие. */
async function scanUniverse(env) {
  let state = {};
  try { const o = await env.R2.get(SCAN_KEY); if (o) state = await o.json(); } catch (e) {}
  if (!state || typeof state !== 'object') state = {};

  // справочник: берётся заново на каждом круге
  let universe = state.universe;
  if (!Array.isArray(universe) || !universe.length || !(state.idx >= 0)) {
    universe = await fetchUniverse();
    state = { universe, idx: 0, metrics: {}, misses: state.misses || {}, started_at: unix() };
    await env.R2.put(UNIVERSE_KEY, JSON.stringify({ fetched_at: unix(), count: universe.length }),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
  }

  const from = state.idx || 0;
  const slice = universe.slice(from, from + SCAN_BUDGET);
  if (!(state.failed >= 0)) state.failed = 0;
  for (const sym of slice) {
    try {
      const d = await fetchChainRaw(sym);
      const m = d ? chainMetrics(d) : null;
      if (m) state.metrics[sym] = m;
    } catch (e) {
      // Отказы источника считаем: по этому числу видно, прошёл ли круг
      // впустую. Имя без метрики не выпадает — его переносит rebuildCoverage.
      if (!/404/.test(String(e.message || e))) state.failed++;
    }
    await sleep(250);
  }
  state.idx = from + slice.length;

  if (state.idx >= universe.length) {
    await rebuildCoverage(env, state);
    state.idx = 0;
    state.universe = null;          // на следующем круге справочник тянется заново
    state.metrics = {};
    state.failed = 0;
  }

  await env.R2.put(SCAN_KEY, JSON.stringify(state),
    { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
}

/**
 * Пересборка покрытия по итогам круга. Гистерезис: войти можно при inMin,
 * а выпасть — только опустившись ниже outMin дважды подряд.
 */
async function rebuildCoverage(env, state) {
  let prev = [];
  try {
    const o = await env.R2.get(COVERAGE_KEY);
    if (o) { const c = await o.json(); if (c && Array.isArray(c.symbols)) prev = c.symbols; }
  } catch (e) {}
  if (!prev.length) prev = CHAIN_FALLBACK.map(s => ({ s }));
  const wasIn = new Set(prev.map(x => x.s));
  const misses = state.misses || {};

  const keep = [];
  for (const [sym, m] of Object.entries(state.metrics)) {
    const fine = m.pct != null && m.pct <= COV.stepMax;
    if (!fine) { misses[sym] = COV.misses; continue; }

    if (wasIn.has(sym)) {
      if (m.n >= COV.outMin) { misses[sym] = 0; keep.push({ s: sym, pct: m.pct, n: m.n }); }
      else {
        misses[sym] = (misses[sym] || 0) + 1;
        if (misses[sym] < COV.misses) keep.push({ s: sym, pct: m.pct, n: m.n });
      }
    } else if (m.n >= COV.inMin) {
      misses[sym] = 0; keep.push({ s: sym, pct: m.pct, n: m.n });
    }
  }
  // Имя, которое в этом круге измерить не удалось (биржа не отдала цепочку),
  // остаётся в покрытии по прошлому кругу. Иначе молчание источника выбивает
  // из списка живые инструменты: круг 02.08 измерил 1 102 имени из 5 328 и
  // выкинул QQQ, SPY, SPX вместе со всей основой.
  const measured = new Set(Object.keys(state.metrics));
  let carried = 0;
  for (const x of prev) {
    if (!measured.has(x.s)) { keep.push(x); carried++; }
  }
  keep.sort((a, b) => (a.pct == null ? 99 : a.pct) - (b.pct == null ? 99 : b.pct));
  state.misses = misses;

  // Пустой результат не публикуем: скорее это сбой обхода, чем рынок без опционов.
  if (!keep.length) return;

  await env.R2.put(COVERAGE_KEY, JSON.stringify({
    ok: true, source: 'scan', built_at: unix(), thresholds: COV,
    universe_count: (state.universe || []).length,
    measured: Object.keys(state.metrics).length,
    failed: state.failed || 0,
    carried,
    count: keep.length, symbols: keep
  }), { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
}

/* ------------------------------------------------------------------ */
/* ряд отношений put/call                                              */
/* Архив CBOE (equitypcarchive.csv, totalpcarchive.csv) отдаёт 200, но */
/* обрывается на 07.06.2012 — фильтр свежести его отбраковывает, и обе */
/* плашки Bottom Signal оставались пустыми у всех посетителей. Замена  */
/* — OCC, клиринговая палата всех американских опционных бирж: те же   */
/* два среза (equity и весь рынок), история с 2018 года. Источник      */
/* отдаёт ПО ОДНОМУ ДНЮ за запрос, поэтому история собрана один раз и  */
/* лежит в R2, а расписание дописывает свежие дни.                     */
/* ------------------------------------------------------------------ */

const PC_KEY = 'feed/occ-putcall.csv';
const PC_STATUS_KEY = 'feed/occ-putcall-status.json';
const PC_MAX_PER_RUN = 3;   // дней за один заход: источник опрашивается по дню

/** Итоговая строка «Total» нужного среза. */
function occTotalRow(rows) {
  for (const r of (rows || [])) {
    if (String(r.exchange || '').trim().toLowerCase() === 'total') return r;
  }
  return null;
}

/** Отношение пут/колл из объёмов (в ответе ratio округлён до сотых). */
function occRatio(row) {
  const c = Number(row && row.calls), p = Number(row && row.puts);
  if (!(c > 0) || !(p >= 0)) return null;
  return Math.round((p / c) * 1e4) / 1e4;
}

/** Один день от OCC: вернёт «дата,equity,total» или null, если дня нет. */
async function fetchPutcallDay(day) {
  const src = 'https://marketdata.theocc.com/mdapi/daily-volume-totals?report_date=' + day;
  const r = await fetch(src, { headers: { 'User-Agent': FEED_UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);

  const body = await r.json();
  const e = (body && body.entity) || {};
  const eq = occRatio(occTotalRow(e.equity_volume));
  const to = occRatio(occTotalRow(e.total_volume));
  if (eq === null || to === null) return null;   // выходной, праздник либо день ещё не опубликован
  return day + ',' + eq + ',' + to;
}

/**
 * Дописать в хранимый ряд дни после последней строки. Файл истории кладётся
 * в бакет один раз вручную; без него расписание ничего не делает.
 */
async function refreshPutcall(env) {
  const obj = await env.R2.get(PC_KEY);
  if (!obj) {
    await env.R2.put(PC_STATUS_KEY,
      JSON.stringify({ checked_at: unix(), result: 'ряда нет в хранилище' }),
      { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
    return;
  }

  const text = await obj.text();
  const lines = text.trim().split('\n');
  const last = lines[lines.length - 1].split(',')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(last)) return;

  const today = new Date().toISOString().slice(0, 10);
  const added = [];
  const report = [];
  let cursor = new Date(last + 'T00:00:00Z');

  for (let i = 0; i < PC_MAX_PER_RUN; i++) {
    cursor = new Date(cursor.getTime() + 864e5);
    const day = cursor.toISOString().slice(0, 10);
    if (day > today) break;
    const wd = cursor.getUTCDay();
    if (wd === 0 || wd === 6) continue;   // биржа закрыта

    try {
      const row = await fetchPutcallDay(day);
      if (row) { added.push(row); report.push(day + ' ok'); }
      else report.push(day + ' нет данных');
    } catch (e) {
      report.push(day + ' сбой · ' + String(e.message || e).slice(0, 80));
      break;   // источник молчит — следующий заход через 15 минут
    }
  }

  if (added.length) {
    await env.R2.put(PC_KEY, text.trim() + '\n' + added.join('\n') + '\n',
      { httpMetadata: { contentType: 'text/csv; charset=utf-8' } });
  }

  await env.R2.put(PC_STATUS_KEY,
    JSON.stringify({ checked_at: unix(), last_row: added.length ? added[added.length - 1].split(',')[0] : last, result: report }),
    { httpMetadata: { contentType: 'application/json; charset=utf-8' } });
}

/**
 * GET /app/api/putcall?kind=equity|total → CSV «DATE,VALUE»
 * GET /app/api/putcall?status=1         → как отработал последний заход
 */
async function apiPutcall(env, url) {
  if (url.searchParams.get('status')) {
    const st = await env.R2.get(PC_STATUS_KEY);
    if (!st) return json({ ok: false, error: 'Ряд ещё не обновлялся.' }, 404);
    return new Response(st.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  const kind = (url.searchParams.get('kind') || '').trim().toLowerCase();
  if (kind !== 'equity' && kind !== 'total') {
    return json({ ok: false, error: 'Неверный срез.' }, 400);
  }

  const obj = await env.R2.get(PC_KEY);
  if (!obj) return json({ ok: false, error: 'Ряд недоступен.' }, 404);

  const col = kind === 'equity' ? 1 : 2;
  const rows = ['DATE,VALUE'];
  for (const line of (await obj.text()).trim().split('\n').slice(1)) {
    const p = line.split(',');
    if (p.length > col && p[col].trim() !== '') rows.push(p[0] + ',' + p[col].trim());
  }

  return new Response(rows.join('\n'), {
    status: 200,
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'public, max-age=1800' }
  });
}

/* ------------------------------------------------------------------ */
/* данные для инструментов зоны: посредник к внешним источникам        */
/* Источники не отдают заголовков CORS, поэтому браузер не может      */
/* обращаться к ним напрямую со страницы. Раньше эту роль играли      */
/* бесплатные публичные прокси; 31.07.2026 оба отказали разом и      */
/* инструменты встали. Теперь запрос идёт через свой воркер.          */
/* Оба маршрута лежат ПОД гейтом (/app/api/...) — посредник доступен  */
/* только вошедшему подписчику, а не всему интернету.                 */
/* ------------------------------------------------------------------ */

/** Единственные адреса, на которые посреднику разрешено ходить. */
const FEED_HOSTS = new Set([
  'cdn.cboe.com',
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'publicreporting.cftc.gov',
  'fred.stlouisfed.org',
  'www.aaii.com',
  'aaii.com',
  "www.finra.org",
  "www.multpl.com",
  'www.cboe.com',
]);

/* Часть источников отвечает отказом на запрос без обычных заголовков
   браузера, поэтому они подставляются. AAII вдобавок смотрит на Referer.
   FINRA — наоборот: её защита сверяет подпись браузера с признаками
   соединения и отвечает 403 на всё, что выдаёт себя за Chrome. Ей
   подставляется короткая подпись, с ней файл отдаётся без отказа. */
const FEED_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function feedHeaders(target) {
  const h = {
    'User-Agent': FEED_UA,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  if (target.hostname.includes('finra.org')) {
    h['User-Agent'] = 'Mozilla/5.0';
    delete h['Accept-Language'];
  }
  if (target.hostname.includes('aaii.com')) {
    h['Accept'] = 'application/vnd.ms-excel,application/octet-stream,*/*';
    h['Referer'] = 'https://www.aaii.com/sentimentsurvey';
  }
  return h;
}

/**
 * FRED режет обращения к fredgraph.csv, поэтому ряд берётся официальным
 * интерфейсом и приводится к тому же виду CSV, который ждут инструменты:
 * первая строка — заголовок, дальше «дата,значение».
 */
async function fredSeries(seriesId, apiKey) {
  const api = 'https://api.stlouisfed.org/fred/series/observations'
            + '?series_id=' + encodeURIComponent(seriesId)
            + '&api_key=' + encodeURIComponent(apiKey)
            + '&file_type=json';
  const r = await fetch(api, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('FRED ответил HTTP ' + r.status);
  const data = await r.json();
  const rows = ['DATE,VALUE'];
  for (const o of (data.observations || [])) rows.push(o.date + ',' + o.value);
  return rows.join('\n');
}

/** GET /app/api/proxy?url=<адрес источника из белого списка> */
async function apiProxy(env, url) {
  const raw = url.searchParams.get('url') || '';

  let target;
  try { target = new URL(raw); }
  catch (e) { return json({ ok: false, error: 'Неверный адрес источника.' }, 400); }

  if (target.protocol !== 'https:' || !FEED_HOSTS.has(target.hostname)) {
    return json({ ok: false, error: 'Источник не разрешён.' }, 403);
  }

  if (target.hostname === 'fred.stlouisfed.org' && target.pathname === '/graph/fredgraph.csv') {
    const seriesId = target.searchParams.get('id');
    if (!seriesId) return json({ ok: false, error: 'Не указан ряд FRED.' }, 400);
    if (!env.FRED_API_KEY) {
      return json({ ok: false, error: 'Ключ FRED не задан в настройках сайта.' }, 500);
    }
    const csv = await fredSeries(seriesId, env.FRED_API_KEY);
    return new Response(csv, {
      status: 200,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'public, max-age=1800' }
    });
  }

  const r = await fetch(target.toString(), { headers: feedHeaders(target), redirect: 'follow' });
  const out = new Response(r.body, { status: r.status });
  out.headers.set('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
  out.headers.set('Cache-Control', 'public, max-age=1800');
  return out;
}

/**
 * GET /app/api/cboe?symbol=QQQ
 * Полная цепочка CBOE весит около тринадцати мегабайт. Здесь она разбирается
 * на сервере и наружу уходит только то, что нужно расчёту: цена и живые
 * контракты. Ответ выходит примерно в десять раз легче исходного.
 */
async function apiCboe(env, url) {
  // Служебный ответ: как отработал последний заход расписания.
  if (url.searchParams.get('status')) {
    const st = await env.R2.get('feed/cboe-status.json');
    if (!st) return json({ ok: false, error: 'Запас ещё не обновлялся.' }, 404);
    return new Response(st.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }

  const sym = (url.searchParams.get('symbol') || '').trim().toUpperCase();
  if (!/^[A-Z]{1,6}$/.test(sym)) {
    return json({ ok: false, error: 'Неверный символ.' }, 400);
  }

  // Сначала запас из R2: он собран расписанием и доступен из любой страны.
  // Срез принимается, пока он не старше суток. Открытый интерес обновляется
  // раз в день, поэтому суток достаточно; более старый срез означает, что
  // расписание не отработало, и тогда лучше сходить к бирже, чем молча
  // отдать позавчерашнюю картину.
  const kept = await env.R2.get(chainKey(sym));
  if (kept) {
    let fresh = true;
    try {
      const c = await kept.json();
      fresh = c && c.stored_at ? (unix() - c.stored_at) < CHAIN_MAX_AGE : true;
      if (fresh) {
        return new Response(JSON.stringify(c), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
        });
      }
    } catch (e) { /* испорченный срез — идём к бирже */ }
  }

  // Живой запрос: повторы при отказе делает сам fetchChainSlice.
  let slice = null, lastErr = '';
  try {
    slice = await fetchChainSlice(sym);
  } catch (e) {
    lastErr = String(e.message || e);
  }
  if (!slice) {
    // Биржа молчит. Если в запасе есть срез — пусть даже вчерашний, — он
    // полезнее пустого экрана: открытый интерес и так суточный.
    if (kept) {
      try {
        const c = await kept.json();
        if (c && c.data) {
          return new Response(JSON.stringify(c), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
          });
        }
      } catch (e) { /* испорченный срез — отдаём ошибку */ }
    }
    return json({ ok: false, error: 'Биржа не ответила: ' + lastErr }, 502);
  }

  // Раз уж цепочка скачана — кладём её в запас. Следующий читатель того же
  // имени получит срез из хранилища, не дожидаясь биржи.
  try {
    await env.R2.put(chainKey(sym), JSON.stringify(slice), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });
  } catch (e) { /* не удалось сохранить — ответ всё равно уходит */ }

  return new Response(JSON.stringify(slice), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' }
  });
}

/* ------------------------------------------------------------------ */
/* смена почты входа: код на новый адрес, затем подтверждение          */
/* Переиспользует таблицу login_code (та же, что и вход по коду) —     */
/* purpose различает назначение, subscriber_id привязывает к заявителю */
/* (для входа email code уже несёт личность, для смены — нет, новый    */
/* адрес ещё не принадлежит никакому подписчику).                      */
/* ------------------------------------------------------------------ */

async function ensureEmailChangeColumns(env) {
  try { await env.DB.prepare("ALTER TABLE login_code ADD COLUMN purpose TEXT DEFAULT 'login'").run(); } catch (e) {}
  try { await env.DB.prepare('ALTER TABLE login_code ADD COLUMN subscriber_id INTEGER').run(); } catch (e) {}
}

async function apiEmailCode(body, env, sid) {
  await ensureEmailChangeColumns(env);

  const email = normalizeEmail(body && body.new_email);
  if (!email) return json({ ok: false, error: 'Проверьте новый адрес почты.' }, 400);

  const now = unix();

  const taken = await env.DB
    .prepare('SELECT id FROM subscriber WHERE email = ?1 AND id != ?2')
    .bind(email, sid)
    .first();
  if (taken) return json({ ok: false, error: 'Эта почта уже используется другой подпиской.' }, 409);

  const code = randomCode();
  const hash = await hashWith(code, env.AUTH_SECRET);

  await env.DB
    .prepare(`INSERT INTO login_code (email, code_hash, created_at, expires_at, request_ip, purpose, subscriber_id)
              VALUES (?1, ?2, ?3, ?4, '', 'email_change', ?5)`)
    .bind(email, hash, now, now + CODE_TTL, sid)
    .run();

  const sent = await sendCode(env, email, code, true);
  if (!sent) return json({ ok: false, error: 'Письмо не удалось отправить. Попробуйте ещё раз.' }, 502);

  return json({ ok: true });
}

async function apiEmailConfirm(body, env, sid) {
  await ensureEmailChangeColumns(env);

  const code  = String((body && body.code) || '').replace(/\s/g, '');
  const WRONG = 'Код не подошёл. Он действует 15 минут и только один раз — запросите новый.';
  if (!/^\d{6}$/.test(code)) return json({ ok: false, error: 'Код состоит из шести цифр.' }, 400);

  const now = unix();

  const row = await env.DB
    .prepare(`SELECT id, email, code_hash, attempts, expires_at FROM login_code
              WHERE subscriber_id = ?1 AND purpose = 'email_change' AND used_at IS NULL
              ORDER BY created_at DESC LIMIT 1`)
    .bind(sid)
    .first();

  if (!row || row.expires_at <= now) return json({ ok: false, error: WRONG }, 401);

  if (row.attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare('UPDATE login_code SET used_at = ?2 WHERE id = ?1').bind(row.id, now).run();
    return json({ ok: false, error: 'Слишком много попыток. Запросите новый код.' }, 429);
  }

  await env.DB.prepare('UPDATE login_code SET attempts = attempts + 1 WHERE id = ?1').bind(row.id).run();

  const hash = await hashWith(code, env.AUTH_SECRET);
  if (!equalHex(hash, row.code_hash)) return json({ ok: false, error: WRONG }, 401);

  // подстраховка от гонки: адрес мог занять кто-то другой между запросом кода и подтверждением
  const taken = await env.DB
    .prepare('SELECT id FROM subscriber WHERE email = ?1 AND id != ?2')
    .bind(row.email, sid)
    .first();
  if (taken) return json({ ok: false, error: 'Эта почта уже используется другой подпиской.' }, 409);

  await env.DB.batch([
    env.DB.prepare('UPDATE login_code SET used_at = ?2 WHERE id = ?1').bind(row.id, now),
    env.DB.prepare('UPDATE subscriber SET email = ?2 WHERE id = ?1').bind(sid, row.email)
  ]);

  return json({ ok: true, email: row.email });
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

  // Разовая покупка: подписки здесь нет, есть оплаченный заказ разбора.
  if (kind === 'order_created' && custom && custom.order) {
    return payOrderRequest(env, a, custom, now);
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

/**
 * Оплаченный разовый разбор: заказ переходит в работу, срок считается
 * с даты оплаты. Списание попадает в раздел «Платежи» тем же порядком,
 * что и подписка.
 */
async function payOrderRequest(env, a, custom, now) {
  const id = Number(custom.order);
  if (!id) return;

  const row = await env.DB
    .prepare('SELECT id, subscriber_id, kind, status FROM order_request WHERE id = ?1')
    .bind(id)
    .first();

  if (!row || row.status !== 'wait') return;   // повтор доставки или чужое событие

  const paid  = when(a.created_at) || now;
  const due   = workingDeadline(paid, ORDER_DAYS);
  const order = String(a.id || a.order_id || '');
  const cents = Number(a.total || a.subtotal || 0) || 0;

  await env.DB
    .prepare(`UPDATE order_request
                 SET status = 'work', paid_at = ?2, due_at = ?3, ls_order_id = ?4
               WHERE id = ?1`)
    .bind(id, paid, due, order || null)
    .run();

  const spec = ONEOFF[row.kind];

  await env.DB
    .prepare(`INSERT OR IGNORE INTO payment
                (subscriber_id, paid_at, amount_cents, currency, what, detail, ls_order_id)
              VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
    .bind(row.subscriber_id, paid, cents, a.currency || 'USD',
          'Разовый разбор', (spec && spec.title) || row.kind, order || null)
    .run();

  await notifyOrderPaid(env, id, row, spec, due, a);
}

/**
 * Письмо о новом оплаченном разборе. Уходит на служебный адрес и содержит
 * всё, что нужно для работы: что разбираем, кому и к какому сроку. Отправка
 * обёрнута перехватом: если письмо не ушло, заказ всё равно уже в работе.
 */
async function notifyOrderPaid(env, id, row, spec, due, a) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return;

  const to = env.ORDER_NOTIFY_TO || CONTACT_TO;

  const full = await env.DB
    .prepare(`SELECT o.subject, o.context, o.amount, o.file_key, o.file_name, s.email
                FROM order_request o
                LEFT JOIN subscriber s ON s.id = o.subscriber_id
               WHERE o.id = ?1`)
    .bind(id)
    .first();

  const title = (spec && spec.title) || row.kind;
  const money = full && full.amount ? '$' + (full.amount / 100) : '';
  const dueTxt = new Date(due * 1000).toISOString().slice(0, 10);

  const text =
    `Оплачен разовый разбор.\n\n` +
    `Что: ${title}${money ? ' (' + money + ')' : ''}\n` +
    `Заказ: ${id}\n` +
    `Покупатель: ${(full && full.email) || 'адрес не найден'}\n` +
    `Срок: до ${dueTxt}\n\n` +
    `Статус оплаты: оплачено\n\n` +
    `Предмет разбора:\n${(full && full.subject) || '—'}\n\n` +
    `Что важно учесть:\n${(full && full.context) || '—'}\n`;

  // Файл с портфелем идёт вложением. Не прочитался — письмо уходит без него.
  const attachments = [];
  if (full && full.file_key) {
    try {
      const obj = await env.R2.get(full.file_key);
      if (obj) {
        const bytes = new Uint8Array(await obj.arrayBuffer());
        if (bytes.length && bytes.length <= ORDER_FILE_MAX) {
          attachments.push({
            filename: safeFileName(full.file_name || 'portfolio'),
            content:  bytesToB64(bytes)
          });
        }
      }
    } catch (e) {
      // вложение не собралось: письмо всё равно нужно отправить
    }
  }

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [to],
        reply_to: (full && full.email) || undefined,
        subject: `Новый заказ — ${title}`,
        text,
        attachments: attachments.length ? attachments : undefined
      })
    });
  } catch (e) {
    // письмо не ушло: заказ уже в работе, состояние базы от этого не зависит
  }
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
  wlm:     { month: 15,   year: 129 },
  flows:   { month: 15,   year: 129 },
  wpm:     { month: 15,   year: 129 },
  wsm:     { month: 15,   year: 129 },
  lead:    { month: 15,   year: 129 },
  margin:  { month: 15,   year: 129 },
  macro:   { month: 20,   year: 149 },
  aicm:    { month: 15,   year: 119 },
  /* Квартальный отчёт продаётся только на год: помесячной цены у него нет. */
  qeg:     { month: null, year: 160 },
  cockpit: { month: 20,   year: 149 }
};

/**
 * Имена и периодичность отчётов. Нужны кассе (покупатель должен видеть,
 * за что платит) и публикации выпусков (тот же код, что в имени файла
 * из R2, — это и есть product_key).
 */
const PRODUCT_INFO = {
  macro:   { title: 'Макрорежим США',              cadence: 'month'   },
  wlm:     { title: 'Системная ликвидность',       cadence: 'week'    },
  flows:   { title: 'Потоки в фонды',              cadence: 'week'    },
  wpm:     { title: 'Позиционирование участников', cadence: 'week'    },
  wsm:     { title: 'Настроения рынка',            cadence: 'week'    },
  qeg:     { title: 'Отчётность и прогнозы',       cadence: 'quarter' },
  lead:    { title: 'Ротация секторов',            cadence: 'week'    },
  margin:  { title: 'Маржинальность и леверидж',   cadence: 'week'    },
  aicm:    { title: 'Цикл сектора ИИ',             cadence: 'month'   },
  cockpit: { title: 'Панель сигналов',             cadence: 'live'    }
};

const ALL_PRODUCT_KEYS = Object.keys(PRICE);

/**
 * Комплексы витрины — те же группы, что на странице тарифов. Нигде больше
 * не хранятся: в таблице product такого поля нет. Отчёты без комплекса
 * («Отчётность и прогнозы», «Цикл сектора ИИ») продаются поодиночке.
 */
const COMPLEX = {
  macro:  'Условия рынка',
  wlm:    'Условия рынка',
  flows:  'Поведение участников',
  wpm:    'Поведение участников',
  wsm:    'Поведение участников',
  lead:   'Структура рынка',
  margin: 'Структура рынка'
};

/** Состав Панели сигналов: у неё нет выпусков, есть три инструмента. */
const PARTS = {
  cockpit: ['Bottom Signal', 'GEX Analysis', 'Peak Signal']
};

/**
 * Разовые разборы. В подписку не входят, справочника product у них нет:
 * это разовая покупка, а не право доступа.
 * ЭТО ЕДИНСТВЕННОЕ МЕСТО, где живут их названия и суммы: страница тарифов и
 * страница заказа берут их из справочника (/api/catalog), своих копий не держат.
 */
const ONEOFF = {
  company:   { title: 'Разбор компании', price: 249, what: 'компанию или тикер' },
  portfolio: { title: 'Second Opinion',  price: 800, what: 'состав портфеля', file: true }
};

/**
 * Файл с составом портфеля. Приходит из формы строкой base64, проверяется
 * по расширению И по первым байтам (расширение подделывается легко), кладётся
 * в R2 рядом с номером заказа. В базе остаются только имя и ключ.
 * Письмо владельцу с вложением уходит после оплаты — см. notifyOrderPaid.
 */
const ORDER_FILE_MAX = 10 * 1024 * 1024;
const ORDER_FILE_TYPE = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf:  'application/pdf',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg'
};

function fileExt(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function safeFileName(name) {
  return String(name || 'file')
    .replace(/[^A-Za-z0-9А-Яа-яЁё._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'file';
}

function b64ToBytes(b64) {
  const raw = atob(String(b64).replace(/^data:[^,]*,/, ''));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(s);
}

/** Первые байты: pdf — %PDF, jpg — FFD8FF, docx и xlsx — это zip (PK). */
function fileLooksRight(ext, b) {
  if (b.length < 4) return false;
  if (ext === 'pdf')  return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
  if (ext === 'jpg' || ext === 'jpeg') return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
  return b[0] === 0x50 && b[1] === 0x4B && b[2] === 0x03 && b[3] === 0x04;
}

/** Срок исполнения разбора, рабочих дней с даты оплаты. */
const ORDER_DAYS = 5;

/** Куда касса возвращает покупателя после оплаты разового разбора. */
const ORDER_RETURN = '/app/orders.html';

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

  let dollars = 0;
  for (const key of keys) {
    const price = priceOf(key, period);
    if (!price) {
      // У квартального отчёта помесячной цены нет — он продаётся только на год.
      if (period === 'month') {
        return json({ ok: false, error: 'Один из отчётов продаётся только на год.' }, 400);
      }
      return json({ ok: false, error: 'Для одного из отчётов не задана цена.' }, 500);
    }
    dollars += price;
  }

  // Интервал списания задаётся вариантом товара, поэтому вариант свой на каждый период.
  const variant = period === 'month' ? env.LS_VARIANT_MONTH : env.LS_VARIANT_YEAR;

  if (!env.LS_API_KEY || !env.LS_STORE_ID || !variant) {
    return json({ ok: false, error: 'Оплата пока не подключена. Напишите нам, оформим вручную.' }, 503);
  }

  // Когда отчёт один, в кассе стоит его название, а не «1 подписка»: покупатель
  // должен видеть в чеке то же слово, что выбирал на витрине.
  const name = isFullAccess
    ? 'American Investor — полный доступ'
    : (keys.length === 1
        ? 'American Investor — ' + ((PRODUCT_INFO[keys[0]] && PRODUCT_INFO[keys[0]].title) || keys[0])
        : 'American Investor — ' + keys.length + ' ' +
          word(keys.length, 'подписка', 'подписки', 'подписок'));

  const description = (isFullAccess ? 'Полный доступ ко всей линейке отчётов и Панели сигналов' :
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
        // Предпросмотр списания выключен намеренно: он печатает цену варианта
        // товара-контейнера, а не нашу переданную сумму, и покупатель видел на
        // странице оплаты два разных числа. Язык страницы задаём сами, иначе
        // касса выбирает его по стране покупателя и русский сайт уводит на
        // английскую оплату.
        checkout_options: { subscription_preview: false, locale: 'ru' },
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
/* разовые разборы: заказ и оплата                                     */
/* ------------------------------------------------------------------ */

/**
 * Порядок один и тот же: сначала заказ записывается в базу, только потом
 * открывается касса. Если касса недоступна или ещё не настроена, заказ уже
 * сохранён и его видно в кабинете со статусом «ожидает оплаты» — работа
 * подписчика не пропадает.
 */
async function apiOrder(body, env, sid, url) {
  return createOrder(body, env, sid, url);
}

/**
 * Заказ с витрины. Входа нет, поэтому почта обязательна: по ней покупатель
 * находится в базе или заводится, к нему же привязывается заказ. После оплаты
 * он сможет войти в кабинет по коду на эту почту и увидеть свой разбор там.
 */
async function handlePublicOrder(body, env, url) {
  // Скрытое поле формы: человек его не видит и не заполняет, робот заполняет.
  // Отвечаем как при успехе, чтобы перебор не получил обратной связи.
  if (String((body && body.website) || '').trim()) {
    return json({ ok: true, id: 0, checkout: null });
  }

  const email = normalizeEmail(body && body.email);
  if (!email) return json({ ok: false, error: 'Укажите адрес почты.' }, 400);

  const sid = await subscriberId(env, email, null, unix());
  if (!sid) return json({ ok: false, error: 'Не удалось оформить заказ. Попробуйте ещё раз.' }, 500);

  return createOrder(body, env, sid, url);
}

/**
 * Общий приём заказа. Порядок один и тот же и для витрины, и для кабинета:
 * сначала заказ записывается в базу, только потом открывается касса. Если
 * касса недоступна или ещё не настроена, заказ уже сохранён и его видно
 * со статусом «ожидает оплаты» — работа покупателя не пропадает.
 */
async function createOrder(body, env, sid, url) {
  const kind = String((body && body.kind) || '').trim().toLowerCase();
  const spec = ONEOFF[kind];
  if (!spec) return json({ ok: false, error: 'Неизвестный предмет разбора.' }, 400);

  const subject = formText(body && body.subject, 200);
  if (!subject) {
    return json({ ok: false, error: 'Укажите ' + spec.what + ' — без этого разбор не собрать.' }, 400);
  }
  const context = formText(body && body.context, 2000);

  // Разбор портфеля принимается только файлом: docx, xlsx, pdf, jpg.
  let upload = null;
  if (spec.file) {
    const sent = (body && body.file) || null;
    const name = formText(sent && sent.name, 120);
    const data = String((sent && sent.data) || '');

    if (!name || !data) {
      return json({ ok: false, error: 'Приложите файл с портфелем.' }, 400);
    }
    const ext = fileExt(name);
    if (!ORDER_FILE_TYPE[ext]) {
      return json({ ok: false, error: 'Формат не подходит. Приложите docx, xlsx, pdf или jpg.' }, 400);
    }

    let bytes;
    try { bytes = b64ToBytes(data); }
    catch (e) { return json({ ok: false, error: 'Файл не удалось прочитать. Приложите его заново.' }, 400); }

    if (!bytes.length) {
      return json({ ok: false, error: 'Файл пустой. Приложите его заново.' }, 400);
    }
    if (bytes.length > ORDER_FILE_MAX) {
      return json({ ok: false, error: 'Файл больше 10 МБ. Приложите файл поменьше.' }, 400);
    }
    if (!fileLooksRight(ext, bytes)) {
      return json({ ok: false, error: 'Содержимое файла не совпадает с расширением. Приложите docx, xlsx, pdf или jpg.' }, 400);
    }

    upload = { name, ext, bytes };
  }

  const now = unix();

  const made = await env.DB
    .prepare(`INSERT INTO order_request
                (subscriber_id, kind, subject, context, status, amount, created_at)
              VALUES (?1, ?2, ?3, ?4, 'wait', ?5, ?6) RETURNING id`)
    .bind(sid, kind, subject, context || null, spec.price * 100, now)
    .first();

  const id = made && made.id;

  if (upload && id) {
    const key = 'orders/' + id + '/' + safeFileName(upload.name);
    await env.R2.put(key, upload.bytes, {
      httpMetadata: { contentType: ORDER_FILE_TYPE[upload.ext] }
    });
    await env.DB
      .prepare('UPDATE order_request SET file_key = ?2, file_name = ?3 WHERE id = ?1')
      .bind(id, key, upload.name).run();
  }

  const link = await oneOffCheckout(env, url, sid, id, kind, spec, subject);

  if (link) {
    await env.DB
      .prepare('UPDATE order_request SET checkout_url = ?2 WHERE id = ?1')
      .bind(id, link).run();
  }

  return json({ ok: true, id, checkout: link || null });
}

/**
 * Отмена заказа из кабинета. Отменить можно только свой заказ и только пока
 * он не оплачен: после оплаты вопрос решается возвратом, а не отменой.
 */
async function apiOrderCancel(body, env, sid) {
  const id = Number((body && body.id) || 0);
  if (!id) return json({ ok: false, error: 'Заказ не указан.' }, 400);

  const row = await env.DB
    .prepare('SELECT id, status FROM order_request WHERE id = ?1 AND subscriber_id = ?2')
    .bind(id, sid)
    .first();

  if (!row) return json({ ok: false, error: 'Заказ не найден.' }, 404);
  if (row.status === 'cancel') {
    return json({ ok: false, error: 'Этот заказ уже отменён.' }, 409);
  }
  if (row.status !== 'wait') {
    return json({ ok: false, error: 'Оплаченный заказ отменить нельзя — напишите нам.' }, 409);
  }

  await env.DB
    .prepare(`UPDATE order_request SET status = 'cancel', checkout_url = NULL
               WHERE id = ?1 AND subscriber_id = ?2 AND status = 'wait'`)
    .bind(id, sid)
    .run();

  return json({ ok: true, id, status: 'cancel' });
}

/** Список заказов подписчика для страницы «Заказы». */
async function apiOrders(env, sid) {
  const rows = await env.DB
    .prepare(`SELECT id, kind, subject, status, amount, checkout_url,
                     created_at, due_at, done_at, file_slug
                FROM order_request
               WHERE subscriber_id = ?1
               ORDER BY created_at DESC, id DESC`)
    .bind(sid)
    .all();

  const items = (rows.results || []).map(r => ({
    id:         r.id,
    kind:       r.kind,
    title:      (ONEOFF[r.kind] && ONEOFF[r.kind].title) || r.kind,
    subject:    r.subject,
    status:     r.status,
    amount:     r.amount,
    created_at: r.created_at,
    due:        r.due_at  || null,
    done:       r.done_at || null,
    file:       r.file_slug || null,
    checkout:   r.status === 'wait' ? (r.checkout_url || null) : null
  }));

  return json({ ok: true, items });
}

/**
 * Оплата разового разбора идёт отдельным вариантом товара: варианты подписки
 * заводят у покупателя периодическое списание, для разовой покупки это неверно.
 * Пока переменная LS_VARIANT_ONEOFF не задана, ссылки нет — заказ остаётся
 * в состоянии «ожидает оплаты», и счёт выставляется вручную.
 */
async function oneOffCheckout(env, url, sid, orderId, kind, spec, subject) {
  const variant = env.LS_VARIANT_ONEOFF;
  if (!env.LS_API_KEY || !env.LS_STORE_ID || !variant || !orderId) return null;

  const who = await env.DB
    .prepare('SELECT email FROM subscriber WHERE id = ?1')
    .bind(sid)
    .first();

  const payload = {
    data: {
      type: 'checkouts',
      attributes: {
        custom_price: spec.price * 100,
        product_options: {
          name: 'American Investor — ' + spec.title,
          description: spec.title + ': ' + subject + '. Срок ' + ORDER_DAYS +
                       ' рабочих дней с даты оплаты.',
          redirect_url: url.origin + ORDER_RETURN,
          enabled_variants: [Number(variant)]
        },
        checkout_options: { subscription_preview: false, locale: 'ru' },
        checkout_data: {
          email:  (who && who.email) || undefined,
          custom: { order: String(orderId), kind }
        },
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
    return null;
  }

  if (!res.ok) return null;

  const out = await res.json().catch(() => null);
  return (out && out.data && out.data.attributes && out.data.attributes.url) || null;
}

/**
 * Срок сдачи: рабочие дни, суббота и воскресенье пропускаются.
 * Праздники не учитываются — их календаря в системе нет.
 */
function workingDeadline(from, days) {
  let t = from;
  let left = days;
  while (left > 0) {
    t += 86400;
    const wd = new Date(t * 1000).getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return t;
}

/** Свободный текст из формы: пробелы по краям, предельная длина, без управляющих знаков. */
function formText(v, max) {
  const s = String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .trim();
  return s ? s.slice(0, max) : null;
}

/* ------------------------------------------------------------------ */
/* публикация выпусков по расписанию                                   */
/* ------------------------------------------------------------------ */

const SITE_ORIGIN = 'https://www.americaninvestor.capital';

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

  const link = `${SITE_ORIGIN}/app/issue.html?slug=${encodeURIComponent(slug)}`;
  for (const r of (rows.results || [])) {
    await sendIssueMail(env, r.addr, spec.title, link);
    await pause(600);   // Resend принимает не больше двух писем в секунду
  }
}

async function sendIssueMail(env, to, product, link) {
  const text =
    `Вышел новый выпуск: ${product}.\n\n` +
    `Читать и скачать PDF: ${link}\n\n` +
    'American Investor';

  const html =
    '<div style="font-family:Manrope,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">' +
      `<p style="margin:0 0 18px">Вышел новый выпуск: <strong>${product}</strong>.</p>` +
      `<p style="margin:0 0 24px"><a href="${link}" style="color:#0050b3">Читать выпуск и скачать PDF</a></p>` +
      '<p style="margin:0;font-size:11px;color:#767676">American Investor</p>' +
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

async function sendCode(env, email, code, isChange) {
  const purpose = isChange ? 'подтверждения новой почты' : 'входа';
  const subject = isChange ? 'Код для подтверждения почты — American Investor' : 'Код для входа — American Investor';

  const text =
    `Код для ${purpose}: ${code}\n\n` +
    (isChange
      ? 'Введите его в разделе «Профиль → Настройки безопасности». Код действует 15 минут и работает один раз.\n\n'
      : 'Введите его на странице входа. Код действует 15 минут и работает один раз.\n\n') +
    'Если это запрашивали не вы, письмо можно не открывать — без кода ничего не изменится.\n\n' +
    'American Investor';

  const html =
    '<div style="font-family:Manrope,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">' +
      `<p style="margin:0 0 18px">Код для ${purpose} в American Investor:</p>` +
      `<p style="margin:0 0 18px;font-size:28px;letter-spacing:.3em;font-weight:600">${code}</p>` +
      '<p style="margin:0 0 18px">' + (isChange
        ? 'Введите его в разделе «Профиль → Настройки безопасности».'
        : 'Введите его на странице входа.') + ' Код действует 15 минут и работает один раз.</p>' +
      '<p style="margin:0 0 24px;color:#767676">Если это запрашивали не вы, письмо можно не открывать — ' +
        'без кода ничего не изменится.</p>' +
      '<p style="margin:0;font-size:11px;color:#767676">American Investor</p>' +
    '</div>';

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [email], subject, text, html })
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* форма контактов → письмо на hello@                                  */
/* ------------------------------------------------------------------ */

const CONTACT_TO     = 'hello@americaninvestor.capital';
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

/* ------------------------------------------------------------------ */
/* индикаторы: расчёт заглавных чисел по расписанию                     */
/* ------------------------------------------------------------------ */

/*
 * Числа на карточках считаются здесь, а не в браузере у каждого посетителя.
 * Иначе на десять человек приходится десять обходов внешних источников, и
 * первым, кого они ограничат по частоте, будет наш адрес: сайт работает
 * у первого и не работает у десятого. Расписание обходит источники один раз,
 * страницы читают готовую строку.
 *
 * Страницы самих инструментов (bottom · tott · gex) не тронуты: их открывают
 * единицы и только с оплаченной Панелью сигналов, множителя нагрузки там нет.
 * Расчёт ниже повторяет движок страницы Peak Signal один в один, включая
 * пороги CFG, чтобы карточка и страница не разошлись.
 */

const PEAK = {
  FAST_THR: 77.9,     // 85-й перцентиль быстрого контура, 1976–2026
  SLOW_THR: 70.0,     // порог накопленного риска
  MOM_W: 26,          // окно импульса условий, недель
  FAST_WIN: 520, FAST_MINP: 260,
  MARGIN_WIN: 180, MARGIN_MINP: 60,
  ALLOC_MA: 60, ALLOC_WIN: 100, ALLOC_MINP: 25,
  MARGIN_LAG_D: 20,   // публикация FINRA — третья неделя следующего месяца
  Z1_LAG_D: 70,       // публикация счетов Z.1 — около 10 недель после квартала
};
const PEAK_FINRA = 'https://www.finra.org/sites/default/files/2021-03/margin-statistics.xlsx';

/* --- ряды --- */

function seriesFromCsv(text) {
  const t = [], v = [];
  const lines = String(text || '').split('\n');
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 2) continue;
    const d = new Date(p[0].trim() + 'T00:00:00Z');
    const raw = p[1].trim(), x = parseFloat(raw);
    if (!isNaN(+d) && raw !== '.' && isFinite(x)) { t.push(d); v.push(x); }
  }
  return { t, v };
}

/** Дневной ряд к пятницам: сравнение идёт по неделям. */
function toWeeklySeries(s) {
  const map = new Map();
  for (let i = 0; i < s.t.length; i++) {
    if (Number.isNaN(s.v[i])) continue;
    const d = s.t[i], add = (5 - d.getUTCDay() + 7) % 7;
    const fri = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add));
    map.set(+fri, { t: fri, v: s.v[i] });
  }
  const keys = [...map.keys()].sort((a, b) => a - b);
  return { t: keys.map(k => map.get(k).t), v: keys.map(k => map.get(k).v) };
}

/** Квартальный ряд сдвигается на срок публикации: будущее в расчёт не заглядывает. */
function shiftQuarterSeries(s, lagDays) {
  const t = s.t.map(d => {
    const q = Math.floor(d.getUTCMonth() / 3);
    return new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, lagDays));
  });
  return { t, v: s.v.slice() };
}

/* --- перцентили и производные --- */

/** Каузальный перцентиль: значение сравнивается только с прошлыми наблюдениями. */
function causalPctlRolling(vals, win, minp) {
  const n = vals.length, out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(vals[i])) continue;
    const lo = Math.max(0, i - win + 1);
    let c = 0, t = 0;
    for (let j = lo; j < i; j++) {
      const w = vals[j];
      if (!Number.isNaN(w)) { t++; if (w < vals[i]) c++; }
    }
    if (t >= minp) out[i] = 100 * c / t;
  }
  return out;
}
function diffK(v, k) {
  const o = new Array(v.length).fill(NaN);
  for (let i = k; i < v.length; i++) {
    const a = v[i - k], b = v[i];
    if (!Number.isNaN(a) && !Number.isNaN(b)) o[i] = b - a;
  }
  return o;
}
function pctChgK(v, k) {
  const o = new Array(v.length).fill(NaN);
  for (let i = k; i < v.length; i++) {
    const a = v[i - k], b = v[i];
    if (!Number.isNaN(a) && !Number.isNaN(b) && a !== 0) o[i] = (b - a) / Math.abs(a);
  }
  return o;
}
function rollMean(v, w) {
  const o = new Array(v.length).fill(NaN);
  let s = 0, c = 0; const q = [];
  for (let i = 0; i < v.length; i++) {
    const x = v[i]; q.push(x);
    if (!Number.isNaN(x)) { s += x; c++; }
    if (q.length > w) { const y = q.shift(); if (!Number.isNaN(y)) { s -= y; c--; } }
    o[i] = c > 0 ? s / c : NaN;
  }
  return o;
}
function lastFinite(a) { for (let i = a.length - 1; i >= 0; i--) if (Number.isFinite(a[i])) return a[i]; return NaN; }
function lastIdxFinite(a) { for (let i = a.length - 1; i >= 0; i--) if (Number.isFinite(a[i])) return i; return -1; }
const seriesOk = s => !!(s && s.t && s.t.length > 20);

/* --- чтение книги Excel --- */

/*
 * Страница разбирает файл FINRA внешней библиотекой, на сервере её нет.
 * Своего разбора книги целиком не требуется: нужны только первый лист и в нём
 * две колонки — месяц строкой и остаток числом. Поэтому лист достаётся из
 * архива напрямую и читается разбором разметки.
 */
function zipEntry(bytes, name) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 65558; i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('не найден конец архива');

  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();

  for (let k = 0; k < count; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('испорчен каталог архива');
    const method = v.getUint16(p + 10, true);
    const csize  = v.getUint32(p + 20, true);
    const nlen   = v.getUint16(p + 28, true);
    const elen   = v.getUint16(p + 30, true);
    const clen   = v.getUint16(p + 32, true);
    const lho    = v.getUint32(p + 42, true);
    if (dec.decode(bytes.subarray(p + 46, p + 46 + nlen)) === name) {
      if (v.getUint32(lho, true) !== 0x04034b50) throw new Error('испорчена запись архива');
      const start = lho + 30 + v.getUint16(lho + 26, true) + v.getUint16(lho + 28, true);
      return { method, data: bytes.subarray(start, start + csize) };
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error('в архиве нет ' + name);
}

async function xlsxFirstSheet(buf) {
  const bytes = new Uint8Array(buf);
  const e = zipEntry(bytes, 'xl/worksheets/sheet1.xml');
  if (e.method === 0) return new TextDecoder().decode(e.data);
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([e.data]).stream().pipeThrough(ds));
  return new TextDecoder().decode(await out.arrayBuffer());
}

/** Месячные остатки на маржинальных счетах; дата сдвинута на срок публикации. */
async function parseFinraMargin(buf) {
  const xml = await xlsxFirstSheet(buf);
  const re = /<row[^>]*>\s*<c[^>]*t="inlineStr"[^>]*>\s*<is><t>(\d{4})-(\d{2})<\/t><\/is><\/c>\s*<c[^>]*>\s*<v>([\d.]+)<\/v>/g;
  const items = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    items.push({ t: new Date(Date.UTC(+m[1], +m[2], PEAK.MARGIN_LAG_D)), v: parseFloat(m[3]) });
  }
  items.sort((a, b) => a.t - b.t);
  return items.length > 100 ? { t: items.map(x => x.t), v: items.map(x => x.v) } : null;
}

/* --- расчёт --- */

/** Состояние по совпадению обоих контуров — те же пороги, что на странице. */
function peakState(fast, slow) {
  const f = Number.isFinite(fast) && fast >= PEAK.FAST_THR;
  const s = Number.isFinite(slow) && slow >= PEAK.SLOW_THR;
  if (f && s) return { key: 'peak',  name: 'Режим вершины',    tone: 'off'  };
  if (s)      return { key: 'fuel',  name: 'Накопленный риск', tone: 'warn' };
  if (f)      return { key: 'tight', name: 'Ужесточение',      tone: 'warn' };
  return { key: 'calm', name: 'Спокойно', tone: 'up' };
}

async function fetchBuf(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 20000);
  try {
    const r = await fetch(url, { cf: { cacheTtl: 0 }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.arrayBuffer();
  } finally { clearTimeout(timer); }
}

/**
 * Peak Signal: считает накопленный риск и ужесточение условий, кладёт
 * заглавное число в строку indicator.tott. Карточка показывает накопленный
 * риск — он и описан в её подписи как положение рынка в своём диапазоне.
 */
async function refreshPeakSignal(env) {
  if (!env.FRED_API_KEY) return { ok: false, error: 'Ключ FRED не задан.' };

  const [credTxt, nfciTxt, allocTxt] = await Promise.all([
    fredSeries('NFCICREDIT', env.FRED_API_KEY).catch(() => null),
    fredSeries('NFCI',       env.FRED_API_KEY).catch(() => null),
    fredSeries('BOGZ1FL153064486Q', env.FRED_API_KEY).catch(() => null),
  ]);
  const finraBuf = await fetchBuf(PEAK_FINRA, 25000).catch(() => null);

  // быстрый контур: импульс кредитных и общих финансовых условий
  let fast = NaN, fastAt = null;
  const cred = credTxt ? toWeeklySeries(seriesFromCsv(credTxt)) : null;
  const nfci = nfciTxt ? toWeeklySeries(seriesFromCsv(nfciTxt)) : null;
  if (seriesOk(cred) && seriesOk(nfci)) {
    const a = causalPctlRolling(diffK(cred.v, PEAK.MOM_W), PEAK.FAST_WIN, PEAK.FAST_MINP);
    const b = causalPctlRolling(diffK(nfci.v, PEAK.MOM_W), PEAK.FAST_WIN, PEAK.FAST_MINP);
    const pCred = lastFinite(a), pNfci = lastFinite(b);
    if (Number.isFinite(pCred) && Number.isFinite(pNfci)) fast = (pCred + pNfci) / 2;
    const i = lastIdxFinite(a);
    if (i >= 0) fastAt = cred.t[i];
  }

  // медленный контур: маржинальный долг и доля акций у домохозяйств
  let pMargin = NaN, marginAt = null;
  const margin = finraBuf ? await parseFinraMargin(finraBuf).catch(() => null) : null;
  if (seriesOk(margin)) {
    pMargin = lastFinite(causalPctlRolling(pctChgK(margin.v, 12), PEAK.MARGIN_WIN, PEAK.MARGIN_MINP));
    marginAt = margin.t[margin.t.length - 1];
  }

  let pAlloc = NaN;
  if (allocTxt) {
    const alloc = shiftQuarterSeries(seriesFromCsv(allocTxt), PEAK.Z1_LAG_D);
    const ma = rollMean(alloc.v, PEAK.ALLOC_MA);
    const res = alloc.v.map((x, i) => Number.isNaN(ma[i]) ? NaN : x - ma[i]);
    pAlloc = lastFinite(causalPctlRolling(res, PEAK.ALLOC_WIN, PEAK.ALLOC_MINP));
  }

  const slow = (Number.isFinite(pMargin) && Number.isFinite(pAlloc)) ? (pMargin + pAlloc) / 2 : NaN;

  if (!Number.isFinite(slow)) {
    // Прежнее значение не трогаем: пустая карточка хуже вчерашнего числа,
    // а дата среза в строке покажет, что оно вчерашнее.
    return { ok: false, error: 'Источники не дали накопленный риск.' };
  }

  const st = peakState(fast, slow);
  const dates = [fastAt, marginAt].filter(Boolean);
  const asof = dates.length ? new Date(Math.max(...dates.map(d => +d))) : null;

  await env.DB
    .prepare('UPDATE indicator SET value = ?2, note = ?3, tone = ?4, asof = ?5 WHERE "key" = ?1')
    .bind('tott', String(Math.round(slow)), 'из 100 · ' + st.name, st.tone,
          asof ? asof.toISOString().slice(0, 10) : null)
    .run();

  return { ok: true, slow, fast, state: st.key, asof };
}
/* ------------------------------------------------------------------ */
/* Bottom Signal и GEX на сервере                                      */
/*                                                                     */
/* Оба движка перенесены со страниц зоны ОДИН В ОДИН вместе с порогами: */
/* карточка на «Рынке сегодня» и сама страница обязаны показывать одно  */
/* и то же число. Всё, что здесь считается, страница считает так же —   */
/* расхождение означало бы ошибку переноса, а не разные методики.       */
/* ------------------------------------------------------------------ */

/** Пороги Bottom Signal. Совпадают с CFG на странице /app/bottom. */
const BS = {
  GATE_THR: -8.0,     // композит ниже этого уровня — капитуляция
  OR_THR:   -9.0,     // любой отдельный показатель ниже — тоже капитуляция
  LATCH_N:  63,       // сколько торговых дней держится отметка после срабатывания
  MIN_PERIODS: 756    // минимум истории до первого ранга (около трёх лет)
};

/** Направление и сглаживание каждого канала: [инвертировать, окно средней]. */
const BS_SPEC = {
  vix:       [true, 10],
  vix_ts:    [true,  5],
  cot:       [false, 3],
  credit:    [true,  5],
  pc_equity: [true,  5],
  pc_total:  [true,  5],
  aaii:      [false, 3]
};

/**
 * Каузальный перцентиль: значение сравнивается ТОЛЬКО с прошлой историей.
 * История держится отсортированной, вставка и подсчёт — двоичным поиском,
 * иначе на пятнадцати тысячах дней расчёт не уложится в отведённое время.
 */
function bsCausalRank(vals, minPeriods) {
  const n = vals.length, out = new Array(n).fill(NaN), hist = [];

  const place = (arr, x) => {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; }
    return lo;
  };

  for (let i = 0; i < n; i++) {
    const x = vals[i];
    if (Number.isNaN(x)) continue;
    if (hist.length >= minPeriods) out[i] = (place(hist, x) / hist.length) * 100;
    hist.splice(place(hist, x), 0, x);
  }
  return out;
}

/** Перцентиль 0…100 к шкале страницы −10…+10. */
const bsToScale = p => p.map(x => (Number.isNaN(x) ? NaN : (x / 100) * 20 - 10));

function bsRankComponent(vals, invert, ma, minPeriods) {
  const proxy = vals.map(x => (Number.isNaN(x) ? NaN : (invert ? -x : x)));
  return bsToScale(bsCausalRank(rollMean(proxy, ma), minPeriods));
}

/** Композит: среднее по тем каналам, что посчитались на этот день. */
function bsComposite(cols) {
  const n = cols[0].length, out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (const col of cols) { const x = col[i]; if (!Number.isNaN(x)) { s += x; c++; } }
    if (c > 0) out[i] = s / c;
  }
  return out;
}

/** Капитуляция: композит ниже общего порога ИЛИ любой канал ниже своего. */
function bsGate(comp, cols, gateThr, orThr) {
  return comp.map((cv, i) => {
    if (!Number.isNaN(cv) && cv <= gateThr) return true;
    for (const col of cols) { const x = col[i]; if (!Number.isNaN(x) && x <= orThr) return true; }
    return false;
  });
}

/** Отметка держится N торговых дней после последнего срабатывания. */
function bsLatch(gate, n) {
  const out = new Array(gate.length).fill(false);
  let last = -1e9;
  for (let i = 0; i < gate.length; i++) { if (gate[i]) last = i; out[i] = i - last < n; }
  return out;
}

/** Ряд на общую ось дат, с переносом последнего значения не дальше лимита. */
function bsAlign(baseT, s, limit) {
  const out = new Array(baseT.length).fill(NaN);
  let j = 0, lastV = NaN, lastIdx = -1e9;
  for (let i = 0; i < baseT.length; i++) {
    while (j < s.t.length && +s.t[j] <= +baseT[i]) {
      if (!Number.isNaN(s.v[j])) { lastV = s.v[j]; lastIdx = i; }
      j++;
    }
    out[i] = (i - lastIdx <= limit) ? lastV : NaN;
  }
  return out;
}

function bsSortDedup(t, v) {
  const idx = t.map((_, i) => i).sort((a, b) => +t[a] - +t[b]);
  const t2 = [], v2 = [];
  for (const i of idx) {
    if (t2.length && +t2[t2.length - 1] === +t[i]) v2[v2.length - 1] = v[i];
    else { t2.push(t[i]); v2.push(v[i]); }
  }
  return { t: t2, v: v2 };
}

/** Отклонение от собственной нормы за окно; окно каузальное. */
function bsTrailingZ(s, win, minWin) {
  const t = [], v = [];
  for (let i = 0; i < s.v.length; i++) {
    const w = s.v.slice(Math.max(0, i - win + 1), i + 1);
    if (w.length < minWin) continue;
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) * (b - m), 0) / w.length);
    if (!(sd > 0)) continue;
    t.push(s.t[i]); v.push((s.v[i] - m) / sd);
  }
  return { t, v };
}

/** Ряд считается пригодным, если он длинный и не старше сорока пяти дней. */
const bsFresh = s => !!(s && s.t && s.t.length > 500 &&
  (Date.now() - +s.t[s.t.length - 1]) < 45 * 864e5);

/* --- источники Bottom Signal --- */

async function bsFetchText(url, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 20000);
  try {
    const r = await fetch(url, { cf: { cacheTtl: 0 }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = await r.text();
    if (t.length < 200) throw new Error('пустой ответ');
    return t;
  } finally { clearTimeout(timer); }
}

/** История индекса с сайта биржи: DATE,OPEN,HIGH,LOW,CLOSE. */
function bsParseCboe(text) {
  const t = [], v = [];
  for (const line of String(text).split('\n')) {
    const p = line.split(',');
    if (p.length < 5 || p[0].toUpperCase().startsWith('DATE')) continue;
    // Даты в этом файле записаны в американском порядке: месяц/день/год.
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(p[0].trim());
    const d = m ? new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]))
                : new Date(p[0].trim() + 'T00:00:00Z');
    const c = parseFloat(p[4]);
    if (!isNaN(+d) && isFinite(c)) { t.push(d); v.push(c); }
  }
  return { t, v };
}

/** Ответ Yahoo: берём скорректированные закрытия, иначе обычные. */
function bsParseYahoo(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { t: [], v: [] }; }
  const r = obj && obj.chart && obj.chart.result && obj.chart.result[0];
  if (!r || !r.timestamp) return { t: [], v: [] };
  const ind = r.indicators || {};
  const adj = ind.adjclose && ind.adjclose[0] && ind.adjclose[0].adjclose;
  const cls = ind.quote && ind.quote[0] && ind.quote[0].close;
  const src = (adj && adj.some(x => x != null)) ? adj : cls;
  if (!src) return { t: [], v: [] };
  const t = [], v = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = src[i];
    if (c != null && isFinite(c)) { t.push(new Date(r.timestamp[i] * 1000)); v.push(c); }
  }
  return { t, v };
}

/**
 * Индекс страховки: сначала FRED (тот же ряд закрытий, доступен отовсюду),
 * затем сайт биржи, затем Yahoo. Порядок такой же, как на странице.
 */
async function bsLoadIndex(env, name, fredId, yahooSym) {
  const s0 = await bsLoadFred(env, fredId);
  if (bsFresh(s0)) return s0;
  try {
    const s = bsParseCboe(await bsFetchText(
      'https://cdn.cboe.com/api/global/us_indices/daily_prices/' + name + '_History.csv', 25000));
    if (bsFresh(s)) return s;
  } catch (e) { /* следующий источник */ }
  try {
    const s = bsParseYahoo(await bsFetchText(
      'https://query1.finance.yahoo.com/v8/finance/chart/' + yahooSym +
      '?range=max&interval=1d', 25000));
    if (bsFresh(s)) return s;
  } catch (e) { /* нет источника */ }
  return null;
}

/**
 * Ряд FRED по идентификатору. Сначала обычный запрос с ключом; если ключа нет
 * или он не сработал — открытая выгрузка тем же адресом, каким пользуется
 * страница. Так канал не выпадает из-за одной настройки.
 */
async function bsLoadFred(env, id) {
  if (env.FRED_API_KEY) {
    try {
      const s = seriesFromCsv(await fredSeries(id, env.FRED_API_KEY));
      if (s && s.t.length) return s;
    } catch (e) { /* открытая выгрузка */ }
  }
  try {
    return seriesFromCsv(await bsFetchText(
      'https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + encodeURIComponent(id), 25000));
  } catch (e) { return null; }
}

/**
 * Ряд put/call берётся ПРЯМО из хранилища, а не через свой же маршрут:
 * маршрут лежит под гейтом, а у расписания сессии нет.
 */
async function bsLoadPutcall(env, kind) {
  const obj = await env.R2.get(PC_KEY);
  if (!obj) return null;
  const col = kind === 'equity' ? 1 : 2;
  const t = [], v = [];
  for (const line of (await obj.text()).trim().split('\n').slice(1)) {
    const p = line.split(',');
    if (p.length <= col) continue;
    const raw = (p[col] || '').trim();
    const x = parseFloat(raw);
    const d = new Date(p[0].trim() + 'T00:00:00Z');
    if (raw !== '' && isFinite(x) && !isNaN(+d)) { t.push(d); v.push(x); }
  }
  return t.length ? { t, v } : null;
}

/**
 * Чистая позиция управляющих во фьючерсе на индекс (отчёт CFTC).
 * Две оговорки перенесены со страницы:
 *  1. срез делается по вторникам, публикуется в пятницу — дата сдвигается
 *     на три дня вперёд, иначе это заглядывание в будущее;
 *  2. в композит идёт не уровень, а отклонение от собственной нормы за два
 *     года: доля выросла структурно, и ранг уровня навсегда упёрся бы в край.
 */
async function bsLoadCot() {
  const src = 'https://publicreporting.cftc.gov/resource/gpe5-46if.json?$limit=5000' +
    '&$select=report_date_as_yyyy_mm_dd,asset_mgr_positions_long,' +
    'asset_mgr_positions_short,open_interest_all' +
    "&$where=market_and_exchange_names='S%26P 500 Consolidated - CHICAGO MERCANTILE EXCHANGE'" +
    '&$order=report_date_as_yyyy_mm_dd ASC';

  let rows;
  try { rows = JSON.parse(await bsFetchText(src, 30000)); } catch (e) { return null; }
  if (!Array.isArray(rows) || rows.length < 100) return null;

  const t = [], v = [];
  for (const r of rows) {
    const L = parseFloat(r.asset_mgr_positions_long);
    const S = parseFloat(r.asset_mgr_positions_short);
    const oi = parseFloat(r.open_interest_all);
    const d = new Date(String(r.report_date_as_yyyy_mm_dd).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(+d) || !isFinite(L) || !isFinite(S) || !(oi > 0)) continue;
    t.push(new Date(+d + 3 * 864e5));
    v.push((L - S) / oi * 100);
  }
  const s = bsTrailingZ(bsSortDedup(t, v), 104, 52);
  return s.t.length < 200 ? null : s;
}

/* --- опрос частных инвесторов: книга Excel старого формата --- */

/*
 * ЛОВУШКА, из-за которой канал молча выпадал бы. Опрос публикуется книгой
 * СТАРОГО формата (OLE2/BIFF). Файл с тем же именем и расширением нового
 * формата на сайте тоже есть и моим читателем архива читается — но отстаёт
 * на месяцы и не прошёл бы фильтр свежести. Библиотеки разбора книг на
 * сервере нет, поэтому старый формат читается своим кодом.
 *
 * Строки в книге НЕ читаются вовсе: таблица общих строк не разбирается,
 * колонки берутся по местам. Вместо доверия к местам стоит структурная
 * проверка — доли ожидающих роста, нейтральных и ожидающих снижения обязаны
 * давать в сумме единицу. Строка, которая её не проходит, отбрасывается.
 */

/** Поток внутри контейнера OLE2 по таблице размещения. */
function oleStream(bytes, wanted) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint32(0, true) !== 0xE011CFD0 || v.getUint32(4, true) !== 0xE11AB1A1) {
    throw new Error('это не книга старого формата');
  }

  const secShift  = v.getUint16(30, true);
  const secSize   = 1 << secShift;
  const miniShift = v.getUint16(32, true);
  const miniSize  = 1 << miniShift;
  const off = sec => (sec + 1) * secSize;

  // Список секторов таблицы размещения: 109 записей в заголовке, остальные —
  // в цепочке дополнительных секторов.
  const fatSecs = [];
  for (let i = 0; i < 109; i++) {
    const s = v.getUint32(76 + i * 4, true);
    if (s === 0xFFFFFFFF) break;
    fatSecs.push(s);
  }
  let dif = v.getUint32(68, true);
  const difCount = v.getUint32(72, true);
  for (let k = 0; k < difCount && dif !== 0xFFFFFFFF; k++) {
    const base = off(dif);
    const per = secSize / 4 - 1;
    for (let i = 0; i < per; i++) {
      const s = v.getUint32(base + i * 4, true);
      if (s === 0xFFFFFFFF) break;
      fatSecs.push(s);
    }
    dif = v.getUint32(base + per * 4, true);
  }

  const fat = [];
  for (const s of fatSecs) {
    const base = off(s);
    for (let i = 0; i < secSize / 4; i++) fat.push(v.getUint32(base + i * 4, true));
  }

  const chain = (start, table) => {
    const out = [];
    let s = start, guard = 0;
    while (s !== 0xFFFFFFFE && s !== 0xFFFFFFFF && guard++ < 1e6) {
      out.push(s);
      s = table[s];
      if (s === undefined) break;
    }
    return out;
  };

  const readSectors = (secs, size, base) => {
    const out = new Uint8Array(secs.length * size);
    secs.forEach((s, i) => {
      const from = base ? base + s * size : off(s);
      out.set(bytes.subarray(from, from + size), i * size);
    });
    return out;
  };

  // Каталог: имя записано двухбайтовыми знаками, длина в поле рядом.
  const dirBytes = readSectors(chain(v.getUint32(48, true), fat), secSize);
  const dv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);

  let found = null, rootStart = 0, rootSize = 0;
  for (let p = 0; p + 128 <= dirBytes.length; p += 128) {
    const nameLen = dv.getUint16(p + 64, true);
    let name = '';
    for (let i = 0; i + 1 < nameLen; i += 2) {
      const c = dv.getUint16(p + i, true);
      if (c) name += String.fromCharCode(c);
    }
    const type  = dv.getUint8(p + 66);
    const start = dv.getUint32(p + 116, true);
    const size  = dv.getUint32(p + 120, true);
    if (type === 5) { rootStart = start; rootSize = size; }
    if (name === wanted) found = { start, size };
  }
  if (!found) throw new Error('в книге нет потока ' + wanted);

  // Мелкие потоки лежат в отдельном хранилище; книга обычно крупная,
  // но проверка стоит — иначе на маленьком файле читался бы мусор.
  if (found.size >= 4096) {
    const data = readSectors(chain(found.start, fat), secSize);
    return data.subarray(0, found.size);
  }

  const miniFatSecs = chain(v.getUint32(60, true), fat);
  const miniFatBytes = readSectors(miniFatSecs, secSize);
  const mfv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
  const miniFat = [];
  for (let i = 0; i < miniFatBytes.length / 4; i++) miniFat.push(mfv.getUint32(i * 4, true));

  const miniStore = readSectors(chain(rootStart, fat), secSize);
  const secs = chain(found.start, miniFat);
  const out = new Uint8Array(secs.length * miniSize);
  secs.forEach((s, i) => out.set(miniStore.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize));
  void rootSize;
  return out.subarray(0, found.size);
}

/** Число из упакованной записи: два младших бита — признаки формата. */
function biffRk(raw) {
  const isInt = (raw & 2) !== 0;
  const div100 = (raw & 1) !== 0;
  let x;
  if (isInt) {
    x = raw >> 2;
  } else {
    // Четыре байта записи — это СТАРШАЯ половина числа, младшая нулевая.
    const b = new ArrayBuffer(8), d = new DataView(b);
    d.setUint32(0, raw & 0xFFFFFFFC);
    x = d.getFloat64(0);
  }
  return div100 ? x / 100 : x;
}

/** Дата в книге хранится числом дней; отсчёт начинается 30.12.1899. */
const xlDate = n => new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 864e5);

/**
 * Опрос частных инвесторов: разница между долей ожидающих роста и долей
 * ожидающих снижения. Читаются только числовые ячейки первого листа.
 */
function parseAaiiWorkbook(buf) {
  const stream = oleStream(new Uint8Array(buf), 'Workbook');
  const v = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);

  // Где начинается первый лист — сказано в записи с описанием листов.
  let sheetStart = -1;
  for (let p = 0; p + 4 <= stream.length;) {
    const id = v.getUint16(p, true), len = v.getUint16(p + 2, true);
    if (id === 0x0085 && sheetStart < 0) sheetStart = v.getUint32(p + 4, true);
    if (id === 0x000A) break;
    p += 4 + len;
    if (len === 0 && id === 0) break;
  }
  if (sheetStart < 0 || sheetStart >= stream.length) sheetStart = 0;

  const cells = new Map();   // строка → { колонка: число }
  const put = (r, c, x) => {
    if (!cells.has(r)) cells.set(r, {});
    cells.get(r)[c] = x;
  };

  for (let p = sheetStart; p + 4 <= stream.length;) {
    const id = v.getUint16(p, true), len = v.getUint16(p + 2, true);
    const body = p + 4;
    if (body + len > stream.length) break;

    if (id === 0x0203) {                       // число с плавающей точкой
      put(v.getUint16(body, true), v.getUint16(body + 2, true), v.getFloat64(body + 6, true));
    } else if (id === 0x027E) {                // упакованное число
      put(v.getUint16(body, true), v.getUint16(body + 2, true), biffRk(v.getInt32(body + 6, true)));
    } else if (id === 0x00BD) {                // несколько упакованных подряд
      const row = v.getUint16(body, true);
      let col = v.getUint16(body + 2, true);
      for (let q = body + 4; q + 6 <= body + len - 2; q += 6) {
        put(row, col++, biffRk(v.getInt32(q + 2, true)));
      }
    } else if (id === 0x000A && p > sheetStart) {
      break;                                    // конец первого листа
    }
    p += 4 + len;
    if (len === 0 && id === 0) break;
  }

  const t = [], val = [];
  for (const [, row] of [...cells.entries()].sort((a, b) => a[0] - b[0])) {
    const d = row[0], bull = row[1], neut = row[2], bear = row[3];
    if (!(d > 25000 && d < 80000)) continue;                     // это не дата
    if (![bull, neut, bear].every(x => typeof x === 'number' && isFinite(x))) continue;
    if (Math.abs(bull + neut + bear - 1) > 0.02) continue;       // колонки не те
    t.push(xlDate(d));
    val.push((bull - bear) * 100);
  }
  return t.length ? bsSortDedup(t, val) : null;
}

async function bsLoadAaii() {
  try {
    const buf = await fetchBuf('https://www.aaii.com/files/surveys/sentiment.xls', 30000);
    const s = parseAaiiWorkbook(buf);
    return (s && s.t.length >= 300) ? s : null;
  } catch (e) { return null; }
}

/**
 * Bottom Signal: считает композит страха и кладёт его в строку indicator.bottom.
 * Если цена страховки не пришла — строка не трогается: вчерашнее число с датой
 * лучше пустой карточки.
 */
async function refreshBottomSignal(env) {
  const vix = await bsLoadIndex(env, 'VIX', 'VIXCLS', '%5EVIX');
  if (!bsFresh(vix)) return { ok: false, error: 'Нет ряда цены страховки.' };

  const v3m    = await bsLoadIndex(env, 'VIX3M', 'VXVCLS', '%5EVIX3M');
  const credit = await bsLoadFred(env, 'BAA10Y');
  const pcEq   = await bsLoadPutcall(env, 'equity').catch(() => null);
  const pcTot  = await bsLoadPutcall(env, 'total').catch(() => null);
  const cot    = await bsLoadCot();
  const aaii   = await bsLoadAaii();

  const baseT = vix.t;
  const parts = { vix: vix.v.slice() };

  if (bsFresh(v3m)) {
    const a3 = bsAlign(baseT, v3m, 3);
    parts.vix_ts = vix.v.map((x, i) => (isFinite(a3[i]) ? x / a3[i] : NaN));
  }
  if (bsFresh(cot))    parts.cot       = bsAlign(baseT, cot, 10);
  if (bsFresh(credit)) parts.credit    = bsAlign(baseT, credit, 5);
  if (bsFresh(pcEq))   parts.pc_equity = bsAlign(baseT, pcEq, 3);
  if (bsFresh(pcTot))  parts.pc_total  = bsAlign(baseT, pcTot, 3);
  if (bsFresh(aaii))   parts.aaii      = bsAlign(baseT, aaii, 7);

  const names = Object.keys(parts);
  const cols = names.map(n => {
    const [inv, ma] = BS_SPEC[n];
    return bsRankComponent(parts[n], inv, ma, BS.MIN_PERIODS);
  });

  const comp  = bsComposite(cols);
  const gate  = bsGate(comp, cols, BS.GATE_THR, BS.OR_THR);
  const latch = bsLatch(gate, BS.LATCH_N);
  const last  = comp.length - 1;

  if (!Number.isFinite(comp[last])) {
    return { ok: false, error: 'Композит не посчитался.' };
  }

  const value = comp[last].toFixed(1).replace('.', ',').replace('-', '\u2212');
  const note  = gate[last]  ? 'капитуляция'
              : latch[last] ? 'капитуляция была недавно'
                            : 'порог \u22128 не достигнут';
  const tone  = gate[last] ? 'up' : (latch[last] ? 'warn' : '');

  await env.DB
    .prepare('UPDATE indicator SET value = ?2, note = ?3, tone = ?4, asof = ?5 WHERE "key" = ?1')
    .bind('bottom', value, note, tone, baseT[last].toISOString().slice(0, 10))
    .run();

  return { ok: true, value: comp[last], parts: names.length, asof: baseT[last] };
}

/* --- GEX: разворотная цена по индексу S&P 500 --- */

/** Безрисковая ставка в расчёте гаммы — та же, что на странице. */
const GEX_RF = 0.04;

function normPdf(x) { return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI); }

function bsmGamma(S, K, tYr, iv, rf) {
  const t = Math.max(tYr, 1e-6);
  const d1 = (Math.log(S / K) + (rf + iv * iv / 2) * t) / (iv * Math.sqrt(t));
  return normPdf(d1) / (S * iv * Math.sqrt(t));
}

/** Разбор обозначения контракта: «SPX260918C05000000». Образец OCC_RE уже есть в файле. */
function parseOcc(sym) {
  const m = OCC_RE.exec(String(sym || ''));
  if (!m) return null;
  const y = 2000 + (+m[2].slice(0, 2)), mo = (+m[2].slice(2, 4)) - 1, d = +m[2].slice(4, 6);
  return { exp: new Date(Date.UTC(y, mo, d, 16, 0, 0)), cp: m[3], strike: (+m[4]) / 1000 };
}

/**
 * GEX: считается только разворотная цена. Цепочка берётся из запаса в
 * хранилище — лишних обходов биржи расписание не делает. Живая цена не
 * запрашивается: берётся цена того же среза, иначе разворотная считалась бы
 * от одной цены, а показывалась рядом с другой.
 */
async function refreshGex(env) {
  const obj = await env.R2.get(chainKey('SPX'));
  if (!obj) return { ok: false, error: 'Цепочки SPX нет в запасе.' };

  let slice;
  try { slice = JSON.parse(await obj.text()); } catch (e) { return { ok: false, error: 'Запас не разобрался.' }; }

  const data = slice && slice.data;
  const spot = data && +data.current_price;
  if (!(spot > 0) || !Array.isArray(data.options)) {
    return { ok: false, error: 'В запасе нет цены или контрактов.' };
  }

  // Время считается ТЕКУЩЕЕ, а не время среза: страница считает так же, а от
  // срока до истечения зависит гамма. Возьми время среза — карточка и страница
  // разошлись бы на несколько пунктов уже к вечеру.
  const nowMs = Date.now();
  const asofMs = slice.stored_at ? slice.stored_at * 1000 : nowMs;
  const rows = [];
  for (const o of data.options) {
    const p = parseOcc(o.option);
    if (!p) continue;
    const iv = +o.iv, oi = +o.open_interest || 0;
    const dte = (p.exp.getTime() - nowMs) / 86400000;
    if (!(dte > 0 && dte <= 400) || !(iv > 0.01) || !(oi > 0)) continue;
    rows.push({ strike: p.strike, iv, oi, tYr: dte / 365, sign: p.cp === 'C' ? 1 : -1 });
  }
  if (rows.length < 50) return { ok: false, error: 'Контрактов слишком мало.' };

  // Полная гамма как функция предполагаемой цены; разворотная — там, где
  // кривая пересекает ноль, из пересечений берётся ближайшее к цене среза.
  const grid = [];
  for (let i = 0; i < 121; i++) grid.push(spot * 0.85 + (spot * 0.30) * i / 120);

  const tot = grid.map(S => {
    let s = 0;
    for (const r of rows) {
      s += r.sign * S * S * bsmGamma(S, r.strike, r.tYr, r.iv, GEX_RF) * r.oi * 100 * 0.01;
    }
    return s;
  });

  let flip = null;
  for (let i = 0; i < grid.length - 1; i++) {
    if (tot[i] * tot[i + 1] <= 0 && tot[i] !== tot[i + 1]) {
      const x = grid[i] + (0 - tot[i]) * (grid[i + 1] - grid[i]) / (tot[i + 1] - tot[i]);
      if (flip === null || Math.abs(x - spot) < Math.abs(flip - spot)) flip = x;
    }
  }
  if (flip === null) return { ok: false, error: 'Разворотная цена не найдена.' };

  const above = spot > flip;
  const value = Math.round(flip).toLocaleString('ru-RU').replace(/\u00a0/g, ' ');

  await env.DB
    .prepare('UPDATE indicator SET value = ?2, note = ?3, tone = ?4, asof = ?5 WHERE "key" = ?1')
    .bind('gex', value,
          above ? 'цена выше разворотной' : 'цена ниже разворотной',
          above ? 'up' : 'warn',
          new Date(asofMs).toISOString().slice(0, 10))
    .run();

  return { ok: true, flip, spot };
}

/* ------------------------------------------------------------------ */
/* Показатели главной страницы                                          */
/*                                                                     */
/* Пять готовых рядов FRED. Ничего не считается: берётся последнее      */
/* опубликованное значение и записывается как есть. Инфляция запрошена  */
/* сразу в виде процента к прошлому году — это делает сам источник.     */
/* ------------------------------------------------------------------ */

/*
 * `goodUp` — в какую сторону движение показателя благоприятно для владельца
 * акций. Им же задаётся цвет стрелки: совпало — зелёная, нет — янтарная.
 */
const HOME_STATS = [
  { key: 'fed_rate',     series: 'DFF',       units: 'lin', kind: 'pct',  digits: 2, goodUp: false },
  { key: 'ust10',        series: 'DGS10',     units: 'lin', kind: 'pct',  digits: 2, goodUp: false },
  { key: 'inflation',    series: 'CPIAUCSL',  units: 'pc1', kind: 'pct',  digits: 1, goodUp: false },
  { key: 'fed_balance',  series: 'WALCL',     units: 'lin', kind: 'trln', digits: 1, goodUp: true  },
  { key: 'unemployment', series: 'UNRATE',    units: 'lin', kind: 'pct',  digits: 1, goodUp: false }
];

/** Мелкие колебания за движение не считаем — иначе стрелка дёргается зря. */
const HOME_FLAT = 1e-9;

/** Десятичная запятая и минус — как на остальных страницах сайта. */
function ruNum(x, digits) {
  return x.toFixed(digits).replace('.', ',').replace('-', '\u2212');
}

/**
 * Последнее значение ряда. Пропуски у FRED помечены точкой, поэтому
 * идём с конца до первого настоящего числа.
 */
async function fredLatest(seriesId, apiKey, units) {
  const api = 'https://api.stlouisfed.org/fred/series/observations'
            + '?series_id=' + encodeURIComponent(seriesId)
            + '&api_key=' + encodeURIComponent(apiKey)
            + '&file_type=json&sort_order=desc&limit=12'
            + '&units=' + encodeURIComponent(units || 'lin');

  const r = await fetch(api, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('FRED ответил HTTP ' + r.status);

  const data = await r.json();
  const got = [];
  for (const o of (data.observations || [])) {
    const x = parseFloat(o.value);
    if (Number.isFinite(x)) got.push({ value: x, date: String(o.date).slice(0, 10) });
    if (got.length === 2) break;
  }
  if (!got.length) throw new Error('в ряде нет значений');
  return { value: got[0].value, date: got[0].date, prev: got.length > 1 ? got[1].value : null };
}

/**
 * Запасной путь: открытая выгрузка того же ряда, без ключа. Годовой прирост
 * она не отдаёт — параметр преобразования там не работает, поэтому для
 * инфляции берётся отношение к значению годичной давности.
 */
async function fredLatestOpen(seriesId, units) {
  const s = seriesFromCsv(await bsFetchText(
    'https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + encodeURIComponent(seriesId), 25000));
  if (!s.t.length) throw new Error('пустой ряд');

  const i = s.t.length - 1;
  const date = s.t[i].toISOString().slice(0, 10);

  if (units !== 'pc1') {
    return { value: s.v[i], date, prev: i > 0 ? s.v[i - 1] : null };
  }

  const back = new Date(+s.t[i]);
  back.setUTCFullYear(back.getUTCFullYear() - 1);
  let j = -1;
  for (let k = i; k >= 0; k--) if (+s.t[k] <= +back) { j = k; break; }
  if (j < 0 || !(s.v[j] > 0)) throw new Error('нет значения годичной давности');

  // Для годового прироста «предыдущее» — тот же прирост на шаг назад.
  let prev = null;
  if (i > 0) {
    const back2 = new Date(+s.t[i - 1]);
    back2.setUTCFullYear(back2.getUTCFullYear() - 1);
    for (let k = i - 1; k >= 0; k--) {
      if (+s.t[k] <= +back2) { if (s.v[k] > 0) prev = (s.v[i - 1] / s.v[k] - 1) * 100; break; }
    }
  }
  return { value: (s.v[i] / s.v[j] - 1) * 100, date, prev };
}

async function refreshHomeStats(env) {
  const done = [];
  for (const s of HOME_STATS) {
    try {
      let got = null;
      if (env.FRED_API_KEY) {
        got = await fredLatest(s.series, env.FRED_API_KEY, s.units).catch(() => null);
      }
      if (!got) got = await fredLatestOpen(s.series, s.units);

      // Баланс публикуется в миллионах долларов — переводим в триллионы.
      const shown = s.kind === 'trln'
        ? '$' + ruNum(got.value / 1e6, s.digits) + ' трлн'
        : ruNum(got.value, s.digits) + ' %';

      // Направление хранится словом, окраска — обычным полем: страница сама
      // рисует стрелку и красит её, значение остаётся белым.
      let dir = '', tone = '';
      if (Number.isFinite(got.prev)) {
        const diff = got.value - got.prev;
        if (Math.abs(diff) > HOME_FLAT) {
          const rising = diff > 0;
          dir  = rising ? 'вверх' : 'вниз';
          tone = (rising === s.goodUp) ? 'up' : 'warn';
        }
      }

      await env.DB
        .prepare('UPDATE indicator SET value = ?2, note = ?3, tone = ?4, asof = ?5 WHERE "key" = ?1')
        .bind(s.key, shown, dir, tone, got.date)
        .run();

      done.push({ key: s.key, shown, dir, tone, asof: got.date });
    } catch (e) {
      // Один упавший ряд не должен ронять остальные: прежнее значение
      // остаётся на месте до следующего прохода.
      done.push({ key: s.key, error: String(e.message || e).slice(0, 80) });
    }
  }
  return { ok: true, done };
}

/* ------------------------------------------------------------------ */
/* индикаторы: приём показаний и выдача страницам                       */
/* ------------------------------------------------------------------ */

/*
 * Часть показателей страницы считают сами по внешним источникам через
 * /app/api/proxy — их здесь нет и быть не должно. В таблице лежат только
 * оценки, которые рождаются внутри выпуска отчёта: посчитать их из открытых
 * данных нельзя, они приходят от прогона, который собирает выпуск.
 */

/** Допустимая окраска значения: пусто — обычная, дальше классы страницы. */
const INDICATOR_TONES = ['', 'up', 'warn', 'off'];

/**
 * Приём показания. Ключ должен уже быть в таблице: заводить новые показатели
 * прогон не может, иначе на страницах появится строка, которую никто не вёрстывал.
 */
/* ── Публикация выпусков со страницы /app/admin.html ──────────────────────
   Страница закрыта паролем публикации. Пароль хранится в базе хэшем
   (SHA-256 с AUTH_SECRET, тем же способом, что коды входа) в таблице
   setting и меняется с самой страницы. Пока пароль не задан, работает
   только его первичное сохранение — остальные запросы отвечают отказом. */

const ADMIN_PASS_KEY = 'admin_pass_hash';
const ADMIN_PDF_MAX  = 15 * 1024 * 1024;   // предел PDF при загрузке
const ADMIN_SUM_MAX  = 100000;             // предел изложения — тот же, что в публикации
const ADMIN_SLUG_RX  = /^([a-z]+)-(\d{4})-(\d{2})-(\d{2})$/;

async function adminSafe(run) {
  try { return await run(); }
  catch (e) { return json({ ok: false, error: 'Сбой запроса: ' + ((e && e.message) || String(e)) }, 500); }
}

async function ensureSettingTable(env) {
  try { await env.DB.prepare('CREATE TABLE IF NOT EXISTS setting ("key" TEXT PRIMARY KEY, value TEXT)').run(); } catch (e) {}
}

async function adminPassHash(env) {
  await ensureSettingTable(env);
  const row = await env.DB.prepare('SELECT value FROM setting WHERE "key" = ?1').bind(ADMIN_PASS_KEY).first();
  return row && row.value ? String(row.value) : null;
}

/** null — доступ есть; иначе готовый ответ с отказом. */
async function adminGate(env, password) {
  const stored = await adminPassHash(env);
  if (!stored) return json({ ok: false, need_setup: true, error: 'Пароль публикации ещё не задан.' }, 403);
  const given = String(password || '');
  if (!given) return json({ ok: false, error: 'Введите пароль публикации.' }, 401);
  if (!equalHex(await hashWith(given, env.AUTH_SECRET), stored)) {
    return json({ ok: false, error: 'Пароль не подходит.' }, 401);
  }
  return null;
}

/** Смена пароля публикации; при незаданном пароле — первичное сохранение. */
async function handleAdminPassword(body, env) {
  const current = String((body && body.password) || '');
  const next    = String((body && body.next) || '');
  if (!next) return json({ ok: false, error: 'Введите новый пароль.' }, 400);

  const stored = await adminPassHash(env);
  if (stored) {
    if (!current) return json({ ok: false, error: 'Введите действующий пароль.' }, 401);
    if (!equalHex(await hashWith(current, env.AUTH_SECRET), stored)) {
      return json({ ok: false, error: 'Действующий пароль не подходит.' }, 401);
    }
  }

  await env.DB
    .prepare('INSERT OR REPLACE INTO setting ("key", value) VALUES (?1, ?2)')
    .bind(ADMIN_PASS_KEY, await hashWith(next, env.AUTH_SECRET))
    .run();
  return json({ ok: true, first: !stored });
}

/** Какие из перечисленных выпусков уже записаны на сайте. */
async function handleAdminCheck(body, env) {
  const deny = await adminGate(env, body && body.password);
  if (deny) return deny;

  const asked = Array.isArray(body && body.slugs) ? body.slugs.slice(0, 40) : [];
  const published = [];
  for (const raw of asked) {
    const slug = String(raw || '').trim();
    if (!ADMIN_SLUG_RX.test(slug)) continue;
    const row = await env.DB.prepare('SELECT slug FROM issue WHERE slug = ?1').bind(slug).first();
    if (row) published.push(slug);
  }
  return json({ ok: true, published });
}

/** Удаление записи выпуска: публикация пересоздаст её из свежей пары. */
async function handleAdminReplace(body, env) {
  const deny = await adminGate(env, body && body.password);
  if (deny) return deny;

  const slug = String((body && body.slug) || '').trim();
  if (!ADMIN_SLUG_RX.test(slug)) return json({ ok: false, error: 'Имя выпуска не разбирается.' }, 400);

  await env.DB.prepare('DELETE FROM issue WHERE slug = ?1').bind(slug).run();
  return json({ ok: true });
}

/** Приём файлов выпусков и запись их в хранилище публикации. */
async function handleAdminUpload(request, env) {
  let form;
  try { form = await request.formData(); }
  catch (e) { return json({ ok: false, error: 'Тело запроса не разбирается.' }, 400); }

  const deny = await adminGate(env, form.get('password'));
  if (deny) return deny;

  // Замены: список записей вида { slug, mail }. С письмом — запись удаляется,
  // публикация пересоздаст её и разошлёт письма подписчикам отчёта. Без
  // письма (по умолчанию) — запись обновляется на месте после загрузки
  // файлов: свежее изложение и размер PDF, рассылки нет.
  const silent = new Set();
  let replace = [];
  try {
    const r = JSON.parse(String(form.get('replace') || '[]'));
    if (Array.isArray(r)) replace = r;
  } catch (e) {}
  for (const item of replace.slice(0, 40)) {
    const slug = String((item && item.slug) || '').trim();
    if (!ADMIN_SLUG_RX.test(slug)) continue;
    if (item && item.mail) {
      await env.DB.prepare('DELETE FROM issue WHERE slug = ?1').bind(slug).run();
    } else {
      silent.add(slug);
    }
  }

  const files = form.getAll('file').filter(f => f && typeof f !== 'string' && f.name);
  if (!files.length) return json({ ok: false, error: 'Файлы не приложены.' }, 400);

  const results = [];
  const stored  = new Map();   // слаг → { summary, bytes } для тихого обновления
  for (const f of files.slice(0, 40)) results.push(await adminPutFile(env, f, stored));

  for (const slug of silent) {
    const got = stored.get(slug);
    if (!got || got.summary === undefined || got.bytes === undefined) continue;
    await env.DB
      .prepare('UPDATE issue SET summary_html = ?2, pdf_bytes = ?3 WHERE slug = ?1')
      .bind(slug, got.summary, got.bytes)
      .run();
  }
  return json({ ok: true, results });
}

async function adminPutFile(env, f, stored) {
  const name = String(f.name || '').trim();
  const out  = { name };

  const m = name.match(/^([a-z]+)-(\d{4})-(\d{2})-(\d{2})\.(pdf|summary\.html)$/);
  if (!m) { out.error = 'Имя не по правилу «код-ГГГГ-ММ-ДД.pdf / .summary.html».'; return out; }

  const code = m[1];
  const spec = PRODUCT_INFO[code];
  if (!spec || code === 'cockpit') { out.error = 'Код продукта в имени файла неизвестен.'; return out; }
  if (isNaN(Date.parse(m[2] + '-' + m[3] + '-' + m[4] + 'T00:00:00Z'))) {
    out.error = 'Дата в имени файла не разбирается.'; return out;
  }

  const bytes = new Uint8Array(await f.arrayBuffer());
  const isPdf = m[5] === 'pdf';
  if (!bytes.length) { out.error = 'Файл пуст.'; return out; }
  if (isPdf) {
    if (bytes.length > ADMIN_PDF_MAX) { out.error = 'Файл больше 15 МБ.'; return out; }
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== '%PDF') {
      out.error = 'Содержимое не похоже на PDF.'; return out;
    }
  } else if (bytes.length > ADMIN_SUM_MAX) {
    out.error = 'Изложение больше 100 КБ — публикация отвергнет такой файл.'; return out;
  }

  await env.R2.put(name, bytes, {
    httpMetadata: { contentType: isPdf ? 'application/pdf' : 'text/html; charset=utf-8' }
  });
  out.ok = true;
  out.bytes = bytes.length;

  if (stored) {
    const slug = m[1] + '-' + m[2] + '-' + m[3] + '-' + m[4];
    const got  = stored.get(slug) || {};
    if (isPdf) got.bytes = bytes.length;
    else       got.summary = new TextDecoder().decode(bytes).trim();
    stored.set(slug, got);
  }
  return out;
}

/** Список записанных выпусков для страницы публикации: что можно убрать. */
async function handleAdminIssues(body, env) {
  const deny = await adminGate(env, body && body.password);
  if (deny) return deny;

  const rows = await env.DB
    .prepare(`SELECT i.slug, i.product_key, i.published_at,
                     COALESCE(p.title, i.product_key) AS title
                FROM issue i LEFT JOIN product p ON p.key = i.product_key
               ORDER BY p.sort, i.published_at DESC
               LIMIT 400`)
    .all();

  const groups = [];
  const byKey  = new Map();
  for (const r of (rows.results || [])) {
    let g = byKey.get(r.product_key);
    if (!g) {
      g = { key: r.product_key, title: r.title, issues: [] };
      byKey.set(r.product_key, g);
      groups.push(g);
    }
    g.issues.push({ slug: r.slug, date: r.slug.slice(-10) });
  }
  return json({ ok: true, groups });
}

/** Полное снятие выпуска: файлы пары из хранилища и запись. Без писем. */
async function handleAdminRemove(body, env) {
  const deny = await adminGate(env, body && body.password);
  if (deny) return deny;

  const slug = String((body && body.slug) || '').trim();
  if (!ADMIN_SLUG_RX.test(slug)) return json({ ok: false, error: 'Имя выпуска не разбирается.' }, 400);

  try { await env.R2.delete(slug + '.pdf'); } catch (e) {}
  try { await env.R2.delete(slug + '.summary.html'); } catch (e) {}
  const res = await env.DB.prepare('DELETE FROM issue WHERE slug = ?1').bind(slug).run();
  const had = !!(res && res.meta && res.meta.changes);
  return json({ ok: true, record: had });
}

async function handleIndicatorPut(request, body, env) {
  const secret = env.INDICATOR_TOKEN;
  if (!secret) return json({ ok: false, error: 'Приём показаний не настроен.' }, 503);

  const head  = String(request.headers.get('authorization') || '');
  const given = head.slice(0, 7).toLowerCase() === 'bearer ' ? head.slice(7).trim() : '';
  if (!equalHex(given, String(secret))) {
    return json({ ok: false, error: 'Нет доступа.' }, 401);
  }

  const key   = String((body && body.key)   || '').trim().slice(0, 40);
  const value = String((body && body.value) || '').trim().slice(0, 40);
  const note  = String((body && body.note)  || '').trim().slice(0, 200);
  const tone  = String((body && body.tone)  || '').trim();
  const asof  = String((body && body.asof)  || '').trim();

  if (!key)   return json({ ok: false, error: 'Не указан ключ показателя.' }, 400);
  if (!value) return json({ ok: false, error: 'Не указано значение.' }, 400);
  if (!INDICATOR_TONES.includes(tone)) {
    return json({ ok: false, error: 'Неизвестная окраска значения.' }, 400);
  }
  if (asof && !/^\d{4}-\d{2}-\d{2}$/.test(asof)) {
    return json({ ok: false, error: 'Дата среза записывается как ГГГГ-ММ-ДД.' }, 400);
  }

  try {
    const res = await env.DB
      .prepare('UPDATE indicator SET value = ?2, note = ?3, tone = ?4, asof = ?5 WHERE "key" = ?1')
      .bind(key, value, note, tone, asof || null)
      .run();

    const changed = res && res.meta && res.meta.changes;
    if (!changed) {
      return json({ ok: false, error: 'Показателя с таким ключом в таблице нет.' }, 404);
    }
    return json({ ok: true });
  } catch (e) {
    return json({ ok: false, error: 'Сбой записи: ' + ((e && e.message) || String(e)) }, 500);
  }
}

/**
 * Выдача страницам. Без входа наружу уходят только пять макропоказателей
 * главной — их список берём из HOME_STATS, второй копии ключей не заводим.
 * Показания Bottom, Peak и GEX — содержимое платной Панели сигналов, поэтому
 * они уходят только подписчику с оплаченным доступом.
 * Открытый ответ живёт в кэше пять минут: показания меняются с выходом
 * выпуска, а заходов на главную кратно больше, чем выпусков. Ответ подписчику
 * не кэшируется. Оба помечены зависимостью от входа: без этой пометки общий
 * кэш отдал бы гостю ответ подписчика или наоборот.
 */
async function handleIndicators(request, env) {
  try {
    const full = await maySeeToolIndicators(request, env);

    const rows = await env.DB
      .prepare('SELECT "key", title, value, note, tone, asof FROM indicator ORDER BY sort, "key"')
      .all();

    let items = (rows && rows.results) || [];

    if (!full) {
      const open = new Set(HOME_STATS.map((st) => st.key));
      items = items.filter((it) => open.has(it.key));
    }

    return json({ ok: true, items }, 200, {
      'Cache-Control': full ? 'no-store' : 'public, max-age=300',
      'Vary': 'Cookie'
    });
  } catch (e) {
    return json({ ok: false, error: 'Сбой запроса: ' + ((e && e.message) || String(e)) }, 500);
  }
}

/**
 * Положены ли запросившему показания инструментов. Право проверяется той же
 * функцией, что закрывает страницы инструментов, поэтому расхождения между
 * страницей и выдачей быть не может. Отказ тихий: гость получает короткий
 * список, а не ошибку, — на главной блок работает как прежде.
 */
async function maySeeToolIndicators(request, env) {
  if (QA_GATE_OFF) return true;   // обход гейта включён — кабинет открыт целиком

  const token = readCookie(request, COOKIE_NAME);
  if (!token) return false;

  const now = unix();

  const session = await env.DB
    .prepare(`SELECT s.subscriber_id AS sid
              FROM session s JOIN subscriber u ON u.id = s.subscriber_id
              WHERE s.id = ?1 AND s.revoked_at IS NULL AND s.expires_at > ?2
                AND u.blocked_at IS NULL`)
    .bind(await hashWith(token, env.AUTH_SECRET), now)
    .first();

  if (!session) return false;

  return await hasRight(env, session.sid, TOOL_PAGES.bottom, now);
}

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
