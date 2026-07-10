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
  plus_code: string;
  manual_override: boolean;
}

export function getCells(): Promise<CellAggregate[]> {
  return apiFetch('/api/v1/cells');
}

export function updateCellScore(h3Index: string, scorePct: number) {
  return apiFetch(`/api/v1/admin/cells/${h3Index}/score`, {
    method: 'PATCH',
    body: JSON.stringify({ score_pct: scorePct }),
  });
}

export function revertCellScore(h3Index: string) {
  return apiFetch(`/api/v1/admin/cells/${h3Index}/score`, { method: 'DELETE' });
}

export function login(email: string, password: string) {
  return apiFetch('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function register(
  email: string,
  password: string,
  display_name: string,
  invite_code: string,
  website: string = '' // honeypot: siempre vacío en un envío humano real
) {
  return apiFetch('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, display_name, invite_code, website }),
  });
}

export function validateInviteCode(code: string): Promise<{ valid: boolean }> {
  return apiFetch('/api/v1/auth/invite-codes/validate', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export interface InviteCode {
  code: string;
  created_by: string;
  created_at: string;
  expires_at: string;
  used_by?: string;
  used_at?: string;
}

export function generateInviteCode(): Promise<InviteCode> {
  return apiFetch('/api/v1/admin/invite-codes', { method: 'POST' });
}

export function listInviteCodes(): Promise<InviteCode[]> {
  return apiFetch('/api/v1/admin/invite-codes');
}

export function createReport(input: {
  lat?: number;
  lon?: number;
  plus_code?: string;
  reporter_display_name?: string;
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

export function deleteCell(h3Index: string) {
  return apiFetch(`/api/v1/admin/cells/${h3Index}`, { method: 'DELETE' });
}

export interface CellOrigin {
  plus_code: string;
  lat_lo: number;
  lat_hi: number;
  lng_lo: number;
  lng_hi: number;
}

export function getCellOrigins(h3Index: string): Promise<CellOrigin[]> {
  return apiFetch(`/api/v1/cells/${h3Index}/origins`);
}
