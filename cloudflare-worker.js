/**
 * Cloudflare Worker for SBS54 Telegram form notifications.
 * Required Cloudflare Secret: BOT_TOKEN.
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
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS",
    headers["Access-Control-Allow-Headers"] = "Content-Type";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function cleanText(value, maxLength) {
  return typeof value === "string"
    ? value.replace(/[\\u0000-\\u001F\\u007F]/g, " ").trim().slice(0, maxLength)
    : "";
}

async function isRateLimited(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key: ip });
    return !success;
  }
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

    // Simple health check: opening the Worker URL in a browser should not show 404.
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({
        ok: true,
        service: "SBS54 Telegram notifier",
        sendEndpoint: "/send",
        tokenConfigured: Boolean(env.BOT_TOKEN),
        recipientsConfigured: ALLOWED_CHAT_IDS.length,
      });
    }

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

    if (url.pathname !== "/send") return json({ ok: false, error: "Not found", hint: "Use GET /health or POST /send" }, 404, origin);
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405, origin);
    if (!ALLOWED_ORIGINS.has(origin)) return json({ ok: false, error: "Forbidden origin" }, 403);
    if (!env.BOT_TOKEN || typeof env.BOT_TOKEN !== "string") {
      return json({ ok: false, error: "Service is not configured", hint: "Cloudflare Secret BOT_TOKEN is missing" }, 503, origin);
    }

    const contentLength = Number(request.headers.get("Content-Length") || 0);
    if (contentLength > MAX_BODY_BYTES) return json({ ok: false, error: "Request too large" }, 413, origin);

    try {
      if (await isRateLimited(request, env)) return json({ ok: false, error: "Too many requests" }, 429, origin);
    } catch (error) {
      console.error("Rate limit check failed:", error);
      return json({ ok: false, error: "Rate limit check unavailable" }, 503, origin);
    }

    let data;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return json({ ok: false, error: "Request too large" }, 413, origin);
      data = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: "Invalid JSON" }, 400, origin);
    }

    if (cleanText(data.website, 200)) return json({ ok: true, ignored: true }, 200, origin);

    const name = cleanText(data.name, 80);
    const phone = cleanText(data.phone, 40);
    if (!name || !phone || name.length < 2 || phone.length < 5) {
      return json({ ok: false, error: "Please provide a valid name and phone" }, 400, origin);
    }

    const message = `🕺 НОВАЯ ЗАЯВКА С САЙТА!\\n\\n👤 Имя: ${name}\\n📞 Телефон: ${phone}\\n\\n✅ Согласия: Правила, Оферта, ПДн получены.`;

    const failures = [];
    for (let i = 0; i < ALLOWED_CHAT_IDS.length; i++) {
      try {
        const telegramResponse = await fetch(
          `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: ALLOWED_CHAT_IDS[i], text: message }),
            signal: AbortSignal.timeout(8000),
          }
        );
        const result = await telegramResponse.json().catch(() => ({}));
        if (!telegramResponse.ok || !result.ok) {
          console.error("Telegram delivery failed", {
            recipientIndex: i + 1,
            httpStatus: telegramResponse.status,
            telegramErrorCode: result.error_code || null,
            telegramDescription: result.description || "No description returned",
          });
          failures.push({
            recipient: i + 1,
            httpStatus: telegramResponse.status,
            telegramErrorCode: result.error_code || null,
            reason: result.description || "Telegram rejected the message",
          });
        }
      } catch (error) {
        console.error("Telegram request failed", { recipientIndex: i + 1, message: String(error) });
        failures.push({ recipient: i + 1, reason: "Network error or timeout" });
      }
    }

    if (failures.length) {
      return json({ ok: false, error: "Telegram delivery failed", failures }, 502, origin);
    }
    return json({ ok: true, deliveredTo: ALLOWED_CHAT_IDS.length }, 200, origin);
  },
};
