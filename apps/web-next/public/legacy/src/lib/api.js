const configuredBase = "/api/backend";
const API_BASE = configuredBase.replace(/\/+$/, "");
const API_ROOT = API_BASE.endsWith("/api") ? API_BASE : API_BASE + "/api";

const ACTIVE_WORKSPACE_KEY = "staypilot.activeWorkspaceId";

export function getActiveWorkspaceId() {
  try { return sessionStorage.getItem(ACTIVE_WORKSPACE_KEY) || ""; }
  catch { return ""; }
}

export function setActiveWorkspaceId(workspaceId) {
  try {
    if (typeof workspaceId === "string" && workspaceId.trim()) {
      sessionStorage.setItem(ACTIVE_WORKSPACE_KEY, workspaceId.trim());
    } else {
      sessionStorage.removeItem(ACTIVE_WORKSPACE_KEY);
    }
  } catch {
    // Session storage can be unavailable in private browsing; API calls will
    // then require a single unambiguous workspace membership.
  }
}

export async function apiRequest(path, options = {}) {
  if (!API_BASE) {
    throw new Error("The API is not configured. Set VITE_API_BASE_URL to the Railway API origin.");
  }
  const headers = new Headers(options.headers || {});
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  const workspaceId = options.workspaceId || getActiveWorkspaceId();
  if (workspaceId) headers.set("X-StayPilot-Workspace-ID", workspaceId);

  const normalizedPath = String(path || "");
  const routePath = normalizedPath.startsWith("/api/")
    ? normalizedPath.slice(4)
    : normalizedPath.startsWith("/")
      ? normalizedPath
      : `/${normalizedPath}`;

  const response = await fetch(`${API_ROOT}${routePath}`, {
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
