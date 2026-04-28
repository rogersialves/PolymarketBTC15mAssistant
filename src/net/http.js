import { CONFIG } from "../config.js";

export async function fetchWithTimeout(url, options = {}, { timeoutMs = CONFIG.httpTimeoutMs, label = "fetch" } = {}) {
  const controller = new AbortController();
  const timeoutToken = Symbol("timeout");
  const timer = setTimeout(() => {
    // Some DNS/connect paths may ignore abort promptly; Promise.race below
    // guarantees this helper returns within timeoutMs regardless.
    controller.abort(new Error(`${label} timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const raced = await Promise.race([
      fetch(url, {
        ...options,
        signal: controller.signal
      }).then(
        (res) => ({ ok: true, res }),
        (err) => ({ ok: false, err })
      ),
      new Promise((resolve) => setTimeout(() => resolve(timeoutToken), timeoutMs))
    ]);

    if (raced === timeoutToken) {
      throw new Error(`${label} timeout after ${timeoutMs}ms`);
    }

    if (!raced.ok) {
      throw raced.err;
    }

    return raced.res;
  } catch (err) {
    if (err?.name === "AbortError" || String(err?.message || "").includes("timeout after")) {
      throw new Error(`${label} timeout after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
