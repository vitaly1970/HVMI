// Cloudflare Pages Function — срез опционной цепочки CBOE (delayed 15 мин).
// Путь: /api/cboe?symbol=QQQ
// Перенесено с Netlify Functions (cboe.js), логика без изменений.

const INDEX = new Set(["SPX", "NDX", "RUT", "VIX", "DJX"]);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json",
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const sym = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!/^[A-Z]{1,6}$/.test(sym)) {
    return new Response(JSON.stringify({ error: "некорректный symbol" }), { status: 400, headers: CORS });
  }
  const cboeSym = INDEX.has(sym) ? "_" + sym : sym;
  const target = "https://cdn.cboe.com/api/global/delayed_quotes/options/" + cboeSym + ".json";

  try {
    const r = await fetch(target, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "*/*" }, redirect: "follow" });
    if (!r.ok) {
      const txt = await r.text();
      return new Response(JSON.stringify({ error: "CBOE HTTP " + r.status, detail: txt.slice(0, 200) }), { status: r.status, headers: CORS });
    }
    const j = await r.json();
    const d = j && j.data;
    if (!d || !Array.isArray(d.options)) {
      return new Response(JSON.stringify({ error: "CBOE вернул неожиданный формат" }), { status: 502, headers: CORS });
    }
    const options = [];
    for (const o of d.options) {
      const iv = +o.iv, oi = +o.open_interest;
      if (!o.option || !(iv > 0.01) || !(oi > 0)) continue;
      options.push({ option: o.option, iv, open_interest: oi });
    }
    const body = JSON.stringify({ data: { current_price: +d.current_price, options } });
    return new Response(body, { status: 200, headers: { ...CORS, "Cache-Control": "public, max-age=300" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: "сбой запроса к CBOE", detail: String(e).slice(0, 200) }), { status: 502, headers: CORS });
  }
}
