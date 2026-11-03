import "./env.mjs";
import { createServer } from "node:http";

const API_BIBLE_BASE_URL = "https://rest.api.bible/v1";
const NKJV_BIBLE_ID = "63097d2a0a2f7db3-01";
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const REQUEST_TIMEOUT_MS = 10_000;
const chapterCache = new Map();
const inFlightRequests = new Map();

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function errorResponse(status, code, message, headers = {}) {
  return { status, body: { error: { code, message } }, headers };
}

function translateUpstreamStatus(status, retryAfter) {
  if (status === 401) {
    return errorResponse(
      502,
      "upstream_unauthorized",
      "The Bible content service rejected its server credentials.",
    );
  }
  if (status === 403) {
    return errorResponse(
      403,
      "translation_access_denied",
      "The server is not authorized to access this translation.",
    );
  }
  if (status === 404) {
    return errorResponse(404, "chapter_not_found", "The requested NKJV chapter was not found.");
  }
  if (status === 429) {
    return errorResponse(
      429,
      "upstream_rate_limited",
      "The Bible content service is rate limiting requests. Please try again later.",
      retryAfter ? { "Retry-After": retryAfter } : {},
    );
  }
  if (status >= 500) {
    return errorResponse(502, "upstream_unavailable", "The Bible content service is unavailable.");
  }
  return errorResponse(502, "upstream_request_failed", "The Bible content request failed.");
}

function pruneCache(now) {
  for (const [key, entry] of chapterCache) {
    if (entry.expiresAt <= now) chapterCache.delete(key);
  }
  while (chapterCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = chapterCache.keys().next().value;
    if (oldestKey === undefined) break;
    chapterCache.delete(oldestKey);
  }
}

async function getChapter(bibleKey, chapterId) {
  const now = Date.now();
  const cached = chapterCache.get(chapterId);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) chapterCache.delete(chapterId);

  const existingRequest = inFlightRequests.get(chapterId);
  if (existingRequest) return existingRequest;

  const request = (async () => {
    const url = new URL(
      `bibles/${NKJV_BIBLE_ID}/chapters/${encodeURIComponent(chapterId)}`,
      `${API_BIBLE_BASE_URL}/`,
    );
    url.searchParams.set("include-verse-numbers", "true");
    url.searchParams.set("include-verse-spans", "true");

    let upstream;
    try {
      upstream = await fetch(url, {
        headers: { "api-key": bibleKey, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        return errorResponse(504, "upstream_timeout", "The Bible content request timed out.");
      }
      return errorResponse(502, "upstream_unavailable", "The Bible content service could not be reached.");
    }

    if (!upstream.ok) {
      return translateUpstreamStatus(upstream.status, upstream.headers.get("retry-after"));
    }

    let payload;
    try {
      payload = await upstream.json();
    } catch {
      return errorResponse(502, "invalid_upstream_response", "The Bible content service returned invalid data.");
    }

    if (
      !payload ||
      typeof payload.data !== "object" ||
      payload.data === null ||
      Array.isArray(payload.data)
    ) {
      return errorResponse(502, "invalid_upstream_response", "The Bible content service returned invalid chapter data.");
    }

    const result = {
      status: 200,
      body: {
        bibleId: NKJV_BIBLE_ID,
        chapterId,
        chapter: payload.data,
      },
    };
    pruneCache(Date.now());
    chapterCache.set(chapterId, {
      value: result,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return result;
  })();

  inFlightRequests.set(chapterId, request);
  try {
    return await request;
  } finally {
    inFlightRequests.delete(chapterId);
  }
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET") {
    sendJson(response, 405, { error: { code: "method_not_allowed", message: "Use GET for this endpoint." } }, {
      Allow: "GET",
    });
    return;
  }

  if (requestUrl.pathname === "/health") {
    sendJson(response, 200, { status: "ok", apiBibleConfigured: Boolean(process.env.API_BIBLE_KEY) });
    return;
  }

  const chapterMatch = requestUrl.pathname.match(/^\/api\/nkjv\/chapters\/([A-Z0-9]{3}\.\d{1,3})$/);
  if (!chapterMatch) {
    sendJson(response, 404, { error: { code: "not_found", message: "Endpoint not found." } });
    return;
  }

  const bibleKey = process.env.API_BIBLE_KEY;
  if (!bibleKey) {
    sendJson(
      response,
      503,
      { error: { code: "server_not_configured", message: "NKJV content is not configured on this server." } },
    );
    return;
  }

  const result = await getChapter(bibleKey, chapterMatch[1]);
  sendJson(response, result.status, result.body, result.headers);
});

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const host = process.env.HOST ?? "0.0.0.0";
server.listen(port, host, () => {
  console.log(`NKJV API proxy listening on ${host}:${port}`);
});
