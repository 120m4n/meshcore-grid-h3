// Cliente API centralizado. La URL del backend se inyecta en build/runtime
// vía variable de entorno pública PUBLIC_API_URL (docker-compose la define).
const API_URL = import.meta.env.PUBLIC_API_URL || 'http://localhost:8080';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiFetch(path: string, options: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Error ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface CellAggregate {
  h3_index: string;
  score_pct: number;
  report_count: number;
  last_report_at: string;
}

export function getCells(): Promise<CellAggregate[]> {
  return apiFetch('/api/v1/cells');
}

export function login(email: string, password: string) {
  return apiFetch('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function register(email: string, password: string, display_name: string) {
  return apiFetch('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, display_name }),
  });
}

export function createReport(input: {
  lat?: number;
  lon?: number;
  plus_code?: string;
  signal_quality: string;
  message?: string;
}) {
  return apiFetch('/api/v1/reports', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function getPendingReports() {
  return apiFetch('/api/v1/admin/reports?status=pending');
}

export function reviewReport(id: string, status: 'approved' | 'rejected') {
  return apiFetch(`/api/v1/admin/reports/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}
