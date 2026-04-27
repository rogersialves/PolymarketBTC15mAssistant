import { CONFIG } from "../config.js";

export async function fetchWithTimeout(url, options = {}, { timeoutMs = CONFIG.httpTimeoutMs, label = "fetch" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`${label} timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (err) {
    if (err?.name === "AbortError" || String(err?.message || "").includes("timeout after")) {
      throw new Error(`${label} timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
