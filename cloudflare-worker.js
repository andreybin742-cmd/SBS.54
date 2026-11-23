/**
 * Cloudflare Worker for SBS54 Telegram form notifications.
 * Cloudflare Secret required: BOT_TOKEN (current Telegram token).
 * Optional Rate Limiting binding: RATE_LIMITER (recommended: 5 requests / 10 minutes).
 *
 * Frontend: POST /send with JSON { "name": "...", "phone": "..." }.
 */

const ALLOWED_ORIGINS = new Set(["https://sbs54.ru", "https://www.sbs54.ru"]);
const ALLOWED_CHAT_IDS = ["8157246500", "1265008981"];
const MAX_BODY_BYTES = 4096;
const LOCAL_LIMITS = new Map();
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;

function json(data, status = 200, origin = "") {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function cleanText(value, maxLength) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, maxLength)
    : "";
}

async function isRateLimited(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // Preferred: Cloudflare Rate Limiting binding (shared across Worker instances).
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    return !success;
  }

  // Best-effort fallback only: isolate-local memory can reset or differ between instances.
  const now = Date.now();
  const entry = LOCAL_LIMITS.get(ip);
  if (!entry || now - entry.startedAt >= RATE_WINDOW_MS) {
    LOCAL_LIMITS.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (!ALLOWED_ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin",
        },
      });
    }

    if (url.pathname !== "/send") return json({ ok: false, error: "Not found" }, 404, origin);
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, 405, origin);
    }
    if (!ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: "Forbidden origin" }, 403);
    if (!env.BOT_TOKEN || typeof env.BOT_TOKEN !== "string") {
      return json({ ok: false, error: "Service is not configured" }, 503, origin);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: "Request too large" }, 413, origin);
    }

    try {
      if (await isRateLimited(request, env)) {
        return json({ ok: false, error: "Too many requests" }, 429, origin);
      }
    } catch {
      return json({ ok: false, error: "Rate limit check unavailable" }, 503, origin);
    }

    let data;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
        return json({ ok: false, error: "Request too large" }, 413, origin);
      }
      data = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400, origin);
    }

    // Honeypot field: legitimate form submissions leave it empty.
    if (cleanText(data.website, 200)) return json({ ok: true }, 200, origin);

    const name = cleanText(data.name, 80);
    const phone = cleanText(data.phone, 40);
    if (!name || !phone || name.length < 2 || phone.length < 5) {
      return json({ ok: false, error: "Please provide a valid name and phone" }, 400, origin);
    }

    const message = `🕺 НОВАЯ ЗАЯВКА С САЙТА!\n\n👤 Имя: ${name}\n📞 Телефон: ${phone}\n\n✅ Согласия: Правила, Оферта, ПДн получены.`;

    try {
      for (const chatId of ALLOWED_CHAT_IDS) {
        const telegramResponse = await fetch(
          `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: message }),
            signal: AbortSignal.timeout(8000),
          }
        );
        if (!telegramResponse.ok) {
          return json({ ok: false, error: "Notification delivery failed" }, 502, origin);
        }
        const result = await telegramResponse.json();
        if (!result.ok) {
          return json({ ok: false, error: "Notification delivery failed" }, 502, origin);
        }
      }
      return json({ ok: true }, 200, origin);
    } catch {
      return json({ ok: false, error: "Notification service unavailable" }, 502, origin);
    }
  },
};
