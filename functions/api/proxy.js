// Cloudflare Pages Function — универсальный прокси (CBOE/Yahoo/NAAIM/FRED/AAII).
// Путь: /api/proxy?url=...
// Перенесено с Netlify Functions (proxy.js), логика без изменений, кроме
// формата рантайма (Request/Response вместо event/callback, env вместо process.env).

const ALLOWED = new Set([
  "cdn.cboe.com",
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
  "naaim.org",
  "www.naaim.org",
  "fred.stlouisfed.org",
  "www.aaii.com",
  "aaii.com",
]);

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
                    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function headersFor(u) {
  const base = {
    "User-Agent": BROWSER_UA,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (u.hostname.includes("aaii.com")) {
    base["Accept"] = "application/vnd.ms-excel,application/octet-stream,*/*";
    base["Referer"] = "https://www.aaii.com/sentimentsurvey";
  }
  return base;
}

async function fetchFredViaApi(seriesId, apiKey) {
  const apiUrl = "https://api.stlouisfed.org/fred/series/observations" +
    "?series_id=" + encodeURIComponent(seriesId) +
    "&api_key=" + apiKey + "&file_type=json";
  const r = await fetch(apiUrl, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error("FRED API HTTP " + r.status);
  const data = await r.json();
  const obs = data.observations || [];
  const lines = ["DATE,VALUE"];
  for (const o of obs) lines.push(o.date + "," + o.value);
  return lines.join("\n");
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const reqUrl = new URL(request.url);
  const target = reqUrl.searchParams.get("url");

  let u;
  try { u = new URL(target); } catch (e) {
    return new Response("bad url", { status: 400 });
  }

  if (u.protocol !== "https:" || !ALLOWED.has(u.hostname)) {
    return new Response("forbidden host", { status: 403 });
  }

  if (u.hostname === "fred.stlouisfed.org" && u.pathname === "/graph/fredgraph.csv") {
    const seriesId = u.searchParams.get("id");
    const FRED_API_KEY = env.FRED_API_KEY;
    if (seriesId && FRED_API_KEY) {
      try {
        const csv = await fetchFredViaApi(seriesId, FRED_API_KEY);
        return new Response(csv, {
          status: 200,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "text/csv",
            "Cache-Control": "public, max-age=1800",
          },
        });
      } catch (e) {
        return new Response("fred api error: " + e.message, { status: 502 });
      }
    }
    if (!FRED_API_KEY) return new Response("FRED_API_KEY не задан", { status: 500 });
  }

  const reqHeaders = headersFor(u);
  try {
    const r = await fetch(u.toString(), { headers: reqHeaders, redirect: "follow" });
    const body = await r.arrayBuffer();
    return new Response(body, {
      status: r.status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": r.headers.get("content-type") || "application/octet-stream",
        "Cache-Control": "public, max-age=1800",
      },
    });
  } catch (e) {
    return new Response("proxy error: " + e.message, { status: 502 });
  }
}
