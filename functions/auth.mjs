// Server-only reader of Gateway-verified context, NOT a JWT verifier.
// Use only behind the platform's verified, non-bypassable Function ingress.
export class UserContextError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'UserContextError';
    this.code = code;
    this.status = status;
  }
}
const invalid = () => new UserContextError('invalid_user_context', 403);
const text = (value, max, required = false) => typeof value === 'string'
  && (!required || value.trim().length > 0)
  && new TextEncoder().encode(value).length <= max && !/[\u0000\r\n]/.test(value);

/** @returns {{user_id:string,name:string,picture:string,site_id:string,host_id:string,session_expires_at:number,org_id?:string}|null} */
export function getUser(request) {
  const raw = request.headers.get('x-qoder-user-context');
  if (raw === null) return null;
  try {
    if (!raw || raw.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw invalid();
    const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    if (btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') !== raw) throw invalid();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || !['user_id', 'site_id', 'host_id'].every(key => text(value[key], 128, true))
        || !text(value.name, 256) || !text(value.picture, 1024)
        || !Number.isSafeInteger(value.session_expires_at) || value.session_expires_at <= Date.now() / 1000
        || (value.org_id !== undefined && !text(value.org_id, 128, true))) throw invalid();
    // Return only public fields; never cache this projection across requests.
    return Object.freeze({ user_id: value.user_id, name: value.name, picture: value.picture,
      site_id: value.site_id, host_id: value.host_id, session_expires_at: value.session_expires_at,
      ...(value.org_id === undefined ? {} : { org_id: value.org_id }) });
  } catch { throw invalid(); }
}

export function requireUser(request) {
  const user = getUser(request);
  if (!user) throw new UserContextError('login_required', 401);
  return user;
}
