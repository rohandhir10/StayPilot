const configuredBase = import.meta.env.VITE_API_BASE_URL || "";
const API_BASE = configuredBase.replace(/\/$/, "");

export async function apiRequest(path, options = {}) {
  if (!API_BASE) {
    throw new Error("The API is not configured. Set VITE_API_BASE_URL to the Railway API origin.");
  }
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);

  const response = await fetch(`${API_BASE}${path.startsWith("/") ? path : `/${path}`}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
    credentials: "omit",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || payload.message || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}
