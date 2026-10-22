let csrfToken: string | undefined;

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (method !== 'GET' && !csrfToken) {
    const session = await api<{ token: string }>('/api/session');
    csrfToken = session.token;
  }
  const response = await fetch(path, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrfToken! }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let result: unknown;
  try { result = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`Server trả dữ liệu không hợp lệ (${response.status}).`); }
  if (!response.ok) {
    const error = result as { error?: string; message?: string };
    throw new Error(error.message || error.error || `Request thất bại (${response.status}).`);
  }
  return result as T;
}
