const configuredApiBase = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const API_BASE_URL = configuredApiBase.endsWith('/api') ? configuredApiBase : `${configuredApiBase}/api`;

export class ApiError extends Error {
  status: number;
  code?: string;
  requestId?: string;
  data?: Record<string, unknown>;

  constructor(message: string, status: number, code?: string, requestId?: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.data = data;
  }
}

type RequestOptions = Omit<RequestInit, 'headers'> & {
  token?: string | null;
  headers?: HeadersInit;
};

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { token, headers: providedHeaders, ...init } = options;
  const headers = new Headers(providedHeaders);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path.startsWith('/') ? path : `/${path}`}`, {
      ...init,
      headers,
      cache: 'no-store'
    });
  } catch {
    throw new ApiError('StayPilot API could not be reached. Check the API URL and service status.', 0, 'network_error');
  }

  const requestId = response.headers.get('x-request-id') || undefined;
  const data: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const errorData = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const message = typeof errorData.error === 'string' ? errorData.error : `Request failed with status ${response.status}.`;
    const code = typeof errorData.code === 'string' ? errorData.code : undefined;
    if (response.status === 401) throw new ApiError('Your session is no longer valid. Sign in again.', 401, code, requestId, errorData);
    if (response.status === 403) throw new ApiError('Your account does not have permission to do that.', 403, code, requestId, errorData);
    throw new ApiError(message, response.status, code, requestId, errorData);
  }
  return data as T;
}

export function getApiBaseUrl(): string {
  return API_BASE_URL;
}
