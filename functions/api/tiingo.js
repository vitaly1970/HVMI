// Cloudflare Pages Function — посредник к Tiingo.
// Путь: /api/tiingo?symbol=QQQ&start=1999-01-01  (история)
//   или /api/tiingo?symbol=QQQ&mode=iex           (внутридневная цена)
// Перенесено с Netlify Functions (tiingo.js), логика без изменений.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const KEY = env.TIINGO_KEY;
  if (!KEY) {
    return new Response(JSON.stringify({ error: "TIINGO_KEY не задан в переменных окружения" }), { status: 500, headers: CORS });
  }

  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  const mode = (url.searchParams.get("mode") || "daily").trim().toLowerCase();
  if (!/^[A-Z.]{1,10}$/.test(symbol)) {
    return new Response(JSON.stringify({ error: "некорректный symbol" }), { status: 400, headers: CORS });
  }

  if (mode === "iex" || mode === "live") {
    const target = `https://api.tiingo.com/iex/?tickers=${symbol}&token=${KEY}`;
    try {
      const r = await fetch(target, { headers: { "Content-Type": "application/json" } });
      if (!r.ok) {
        const txt = await r.text();
        return new Response(JSON.stringify({ error: `Tiingo IEX HTTP ${r.status}`, detail: txt.slice(0, 300) }), { status: r.status, headers: CORS });
      }
      const data = await r.json();
      if (!Array.isArray(data) || !data.length) {
        return new Response(JSON.stringify({ error: "Tiingo IEX: пустой ответ", detail: JSON.stringify(data).slice(0, 300) }), { status: 502, headers: CORS });
      }
      return new Response(JSON.stringify(data), { status: 200, headers: { ...CORS, "Cache-Control": "public, max-age=30" } });
    } catch (e) {
      return new Response(JSON.stringify({ error: "сбой запроса к Tiingo IEX", detail: String(e).slice(0, 300) }), { status: 500, headers: CORS });
    }
  }

  const start = (url.searchParams.get("start") || "1999-01-01").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return new Response(JSON.stringify({ error: "некорректная дата start" }), { status: 400, headers: CORS });
  }

  const target = `https://api.tiingo.com/tiingo/daily/${symbol}/prices?startDate=${start}&format=json&token=${KEY}`;
  try {
    const r = await fetch(target, { headers: { "Content-Type": "application/json" } });
    if (!r.ok) {
      const txt = await r.text();
      return new Response(JSON.stringify({ error: `Tiingo HTTP ${r.status}`, detail: txt.slice(0, 300) }), { status: r.status, headers: CORS });
    }
    const data = await r.json();
    if (!Array.isArray(data)) {
      return new Response(JSON.stringify({ error: "Tiingo вернул не массив", detail: JSON.stringify(data).slice(0, 300) }), { status: 502, headers: CORS });
    }
    return new Response(JSON.stringify(data), { status: 200, headers: { ...CORS, "Cache-Control": "public, max-age=3600" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "сбой запроса к Tiingo", detail: String(e).slice(0, 300) }), { status: 500, headers: CORS });
  }
}
