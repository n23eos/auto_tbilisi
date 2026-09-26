export async function fetchPriceCatalog(api, {fetchImpl = fetch, timeoutMs = 10000} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${api}/api/catalog`, {
      headers: {Accept: 'application/json'},
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`catalog_http_${response.status}`);
    // Ждём и тело ответа: иначе таймер снимется после заголовков и зависший JSON
    // оставит статические цены без предупреждения об их актуальности.
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
