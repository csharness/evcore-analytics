// Sign-in for the analytics page (decision 0021): email and password, then the authenticator-app
// code (Supabase Auth TOTP, which raises the session to aal2). The session lives in memory only:
// nothing is written to the browser, so closing or reloading the tab signs out. The access token is
// refreshed shortly before it expires, which keeps the second factor (aal2).
//
// `fetchImpl` is replaceable for tests. Every call goes to the account server named in config.json.
const REFRESH_MARGIN_MS = 120000;

// The QR code as an image address. The Auth server sends the bare SVG ("<?xml …><svg …>"; its
// JavaScript library adds "data:image/svg+xml;utf-8," in front, unescaped). Its colours ("#000000")
// would end a data address at the "#", so the SVG is always percent-encoded. Anything that is not
// an SVG gives ''.
export function svgDataUrl(value) {
  const text = String(value ?? '').trim();
  if (/^<(\?xml|svg|!--)/.test(text)) return /<svg[\s>]/.test(text) ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}` : '';
  const comma = text.indexOf(',');
  if (!/^data:image\/svg\+xml[;,]/.test(text) || comma < 0) return '';
  const header = text.slice(0, comma);
  let svg = text.slice(comma + 1);
  if (/;base64$/.test(header)) return text;
  try { if (!svg.includes('<')) svg = decodeURIComponent(svg); } catch { return ''; }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function createSession({serverUrl, anonKey, fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now()}) {
  let tokens = null; // {access, refresh, expires}

  async function call(path, {method = 'POST', body, auth = true} = {}) {
    const headers = {apikey: anonKey, 'Content-Type': 'application/json'};
    if (auth && tokens) headers.Authorization = `Bearer ${tokens.access}`;
    let res;
    try { res = await fetchImpl(`${serverUrl}${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)}); }
    catch { return {status: 0, data: null}; }
    let data = null;
    try { data = await res.json(); } catch { /* empty body */ }
    return {status: res.status, data};
  }
  const keep = data => {
    tokens = {access: data.access_token, refresh: data.refresh_token, expires: now() + Math.min(Number(data.expires_in) || 3600, 86400) * 1000};
  };
  const message = (r, fallback) => (r.status === 0 ? 'The account server could not be reached.' : r.status === 429 ? 'Too many attempts. Wait a few minutes.' : fallback);

  async function fresh() {
    if (!tokens) return false;
    if (now() < tokens.expires - REFRESH_MARGIN_MS) return true;
    const r = await call('/auth/v1/token?grant_type=refresh_token', {body: {refresh_token: tokens.refresh}, auth: false});
    if (r.status !== 200 || !r.data?.access_token) { tokens = null; return false; }
    keep(r.data);
    return true;
  }

  return {
    get signedIn() { return Boolean(tokens); },
    // The session's assurance level from the access token: 'aal1' (password) or 'aal2' (second factor).
    get level() {
      try { return JSON.parse(atob(tokens.access.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).aal ?? 'aal1'; } catch { return null; }
    },
    async signIn(email, password) {
      const r = await call('/auth/v1/token?grant_type=password', {body: {email, password}, auth: false});
      if (r.status === 200 && r.data?.access_token) { keep(r.data); return {ok: true}; }
      return {ok: false, message: message(r, 'The email or password is not correct.')};
    },
    // The account's authenticator factors: {verified: [...], unverified: [...]} (TOTP only).
    async factors() {
      if (!await fresh()) return {ok: false};
      const r = await call('/auth/v1/user', {method: 'GET'});
      if (r.status !== 200) return {ok: false};
      const totp = (r.data?.factors ?? []).filter(f => f.factor_type === 'totp');
      return {ok: true, verified: totp.filter(f => f.status === 'verified'), unverified: totp.filter(f => f.status !== 'verified')};
    },
    // Starts adding an authenticator: {ok, id, qr (an SVG data address), secret}. An earlier
    // unfinished one is removed first.
    async enroll(existing = []) {
      if (!await fresh()) return {ok: false, message: 'Sign in again.'};
      for (const f of existing) await call(`/auth/v1/factors/${encodeURIComponent(f.id)}`, {method: 'DELETE'});
      const r = await call('/auth/v1/factors', {body: {factor_type: 'totp', friendly_name: `EVCore analytics ${new Date(now()).toISOString().slice(0, 10)}`, issuer: 'EVCore analytics'}});
      if (r.status !== 200 || !r.data?.id || !r.data?.totp) return {ok: false, message: message(r, r.data?.msg || 'The authenticator could not be added.')};
      return {ok: true, id: r.data.id, qr: svgDataUrl(r.data.totp.qr_code), secret: r.data.totp.secret};
    },
    // Checks a 6-digit code for a factor; on success the session is aal2.
    async verify(factorId, code) {
      const digits = String(code).replace(/\s+/g, '');
      if (!/^\d{6}$/.test(digits)) return {ok: false, message: 'Enter the 6 digits from your authenticator app.'};
      if (!await fresh()) return {ok: false, message: 'Sign in again.'};
      const challenge = await call(`/auth/v1/factors/${encodeURIComponent(factorId)}/challenge`, {body: {}});
      if (challenge.status !== 200 || !challenge.data?.id) return {ok: false, message: message(challenge, 'The code could not be checked.')};
      const r = await call(`/auth/v1/factors/${encodeURIComponent(factorId)}/verify`, {body: {challenge_id: challenge.data.id, code: digits}});
      if (r.status === 200 && r.data?.access_token) { keep(r.data); return {ok: true}; }
      return {ok: false, message: message(r, 'That code is not correct. Codes change every 30 seconds.')};
    },
    // Calls a database function: {ok, data} or {ok: false, ended|message}.
    async rpc(name, body = {}) {
      if (!await fresh()) return {ok: false, ended: true};
      const r = await call(`/rest/v1/rpc/${name}`, {body});
      if (r.status === 200) return {ok: true, data: r.data};
      if (r.status === 401) { tokens = null; return {ok: false, ended: true}; }
      return {ok: false, message: message(r, 'The account server refused the request.')};
    },
    async signOut() {
      if (tokens) await call('/auth/v1/logout', {body: {}});
      tokens = null;
    }
  };
}
