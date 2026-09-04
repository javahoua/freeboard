// functions/travels.js
//
// Cloudflare Pages Function — server-side proxy for the jsp5.ir Travels API.
// (Converted from the original Netlify Function; same behavior, different
// export shape.)
//
// Why this exists:
//  - Calling jsp5.ir directly from the browser can fail because of CORS.
//  - The previous fallback (a public CORS proxy) is unreliable and, combined
//    with the direct attempt, doubled the number of requests hitting jsp5.ir
//    from the same client — which is what triggered HTTP 429 (rate limited)
//    responses from jsp5.ir.
//
// This function calls jsp5.ir exactly once per cold cache window, from the
// server (no CORS issue), and caches the result briefly in memory so that
// many browser tabs/users polling every 10s don't each generate their own
// upstream request.

const UPSTREAM_URL = "https://jsp5.ir/onlineapi/Travels";
const CACHE_TTL_MS = 8000; // slightly under the 10s client poll interval
const UPSTREAM_TIMEOUT_MS = 6000;

// Module-level cache. Persists across invocations only while the underlying
// Worker isolate stays warm — best effort, not guaranteed, but it
// meaningfully cuts down repeated upstream calls in the common case.
let cache = {
  data: null,      // last successful JSON payload (raw, as string)
  fetchedAt: 0,     // timestamp (ms) of that successful fetch
};

// If an upstream call is already in flight, reuse its promise instead of
// starting a second one (avoids a stampede of parallel fetches).
let inFlight = null;

function jsonResponse(statusCode, bodyObj, extraHeaders) {
  return new Response(JSON.stringify(bodyObj), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

async function fetchUpstream() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(UPSTREAM_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const err = new Error("upstream_rate_limited");
      err.code = 429;
      err.retryAfter = retryAfter;
      throw err;
    }

    if (!res.ok) {
      const err = new Error("upstream_bad_status");
      err.code = res.status;
      throw err;
    }

    const text = await res.text();
    // Validate it's parseable JSON before caching it.
    JSON.parse(text);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Cloudflare Pages Functions routing: this file at /functions/travels.js
// is served at the path /travels on your Pages domain.

export async function onRequestOptions() {
  return jsonResponse(200, {});
}

export async function onRequestGet() {
  const now = Date.now();
  const cacheIsFresh = cache.data && now - cache.fetchedAt < CACHE_TTL_MS;

  if (cacheIsFresh) {
    return jsonResponse(200, JSON.parse(cache.data), {
      "X-Cache": "HIT",
    });
  }

  try {
    if (!inFlight) {
      inFlight = fetchUpstream().finally(() => {
        inFlight = null;
      });
    }
    const text = await inFlight;
    cache = { data: text, fetchedAt: Date.now() };
    return jsonResponse(200, JSON.parse(text), { "X-Cache": "MISS" });
  } catch (err) {
    // If upstream is rate-limiting or erroring but we still have a
    // (possibly slightly stale) cached copy, serve that instead of failing
    // the client outright.
    if (cache.data) {
      return jsonResponse(200, JSON.parse(cache.data), {
        "X-Cache": "STALE",
        "X-Upstream-Error": String(err.code || err.message || "unknown"),
      });
    }

    if (err.code === 429) {
      return jsonResponse(
        429,
        {
          error: "rate_limited",
          message: "سرویس سفرها موقتاً محدود شده (429). کمی بعد دوباره تلاش کنید.",
        },
        err.retryAfter ? { "Retry-After": err.retryAfter } : {}
      );
    }

    if (err.name === "AbortError") {
      return jsonResponse(504, {
        error: "upstream_timeout",
        message: "اتصال به سرویس سفرها بیش از حد طول کشید.",
      });
    }

    return jsonResponse(502, {
      error: "upstream_error",
      message: "خطا در دریافت اطلاعات از سرویس سفرها.",
      detail: String(err.message || err),
    });
  }
}
