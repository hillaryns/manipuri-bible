import "../src/env.mjs";

const API_BIBLE_BASE_URL = "https://rest.api.bible/v1";
const NKJV_BIBLE_ID = "63097d2a0a2f7db3-01";
const apiKey = process.env.API_BIBLE_KEY;

if (!apiKey) {
  console.error("API_BIBLE_KEY is not set. Add it to the server environment or project-root .env.local.");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`${API_BIBLE_BASE_URL}/bibles/${NKJV_BIBLE_ID}`, {
      headers: { "api-key": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 401) {
      console.error("API.Bible rejected the server credential (401).");
      process.exitCode = 1;
    } else if (response.status === 403) {
      console.error("The API.Bible account does not have access to NKJV (403).");
      process.exitCode = 1;
    } else if (response.status === 404) {
      console.error("The configured NKJV Bible ID was not found (404).");
      process.exitCode = 1;
    } else if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      console.error(`API.Bible rate limit reached (429).${retryAfter ? ` Retry after ${retryAfter}.` : ""}`);
      process.exitCode = 1;
    } else if (!response.ok) {
      console.error(`API.Bible access check failed with HTTP ${response.status}.`);
      process.exitCode = 1;
    } else {
      console.log("API.Bible access verified for the NKJV Bible ID. The API key was not displayed.");
    }
  } catch (error) {
    console.error(
      error?.name === "TimeoutError"
        ? "API.Bible access check timed out."
        : "Unable to reach API.Bible.",
    );
    process.exitCode = 1;
  }
}
