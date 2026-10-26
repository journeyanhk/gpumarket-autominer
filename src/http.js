// 统一的 HTTP 请求：超时、JSON 解析、可读的中文错误
export class HttpError extends Error {
  constructor(msg, status, body) { super(msg); this.status = status; this.body = body; }
}

export async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 30000, meta } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131 Safari/537.36',
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(t);
    const why = e.name === 'AbortError' ? `超时(${timeoutMs / 1000}s)` : (e.cause?.code || e.message);
    throw new HttpError(`网络错误：${why}`, 0, null);
  }
  const text = await res.text();
  clearTimeout(t);
  if (meta) { meta.status = res.status; meta.headers = Object.fromEntries(res.headers); }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const detail = data?.msg || data?.error || data?.detail || text.slice(0, 200);
    const err = new HttpError(`HTTP ${res.status}：${detail}`, res.status, data ?? text);
    err.headers = Object.fromEntries(res.headers);
    throw err;
  }
  if (data === null && text) throw new HttpError(`返回的不是 JSON：${text.slice(0, 120)}`, res.status, text);
  return data;
}
