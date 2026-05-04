function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetriable(error) {
  const status = error?.response?.status;
  if (status === 429) return true;
  if (status >= 500) return true;

  const code = error?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNABORTED";
}

export async function withRetry(fn, { label, retries = 4, baseDelayMs = 1000, maxDelayMs = 12000 }) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const retriable = isRetriable(error);
      if (!retriable || attempt >= retries) break;

      const exponential = baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * 300);
      const waitMs = Math.min(maxDelayMs, exponential + jitter);
      console.warn(`[retry] ${label} failed (${attempt}/${retries}), status=${error?.response?.status ?? "n/a"}, wait=${waitMs}ms`);
      await sleep(waitMs);
    }
  }

  throw lastError;
}
