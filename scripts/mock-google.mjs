// Tiny fake of the Google endpoints EOD Log uses (OAuth device flow + token, Drive v3 files/permissions/about),
// for tests only. State is in memory. Control endpoints:
//   POST /mock/approve           approve the pending device code
//   POST /mock/deny              deny it
//   POST /mock/fail?n=2&status=500&reason=backendError   fail the next n Drive calls
//   GET  /mock/state             { files, permissions, calls, tokens }
//   POST /mock/reset
//   POST /mock/folder?name=X     make a folder (stands in for a Shared Drive folder)
//   POST /mock/trash?id=X        trash a file as if a user did it in Drive
// Usage: PORT=8090 node scripts/mock-google.mjs
import http from 'node:http';
import crypto from 'node:crypto';

export function startMock(port = Number(process.env.PORT || 8090)) {
  let st;
  const reset = () => { st = { files: {}, perms: {}, calls: [], device: null, access: new Set(), refresh: new Set(), fail: null, revoked: [], sessions: {}, n: 0 }; };
  reset();
  const id = (p) => p + (++st.n).toString(36) + crypto.randomBytes(3).toString('hex');
  const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json', ...headers }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
  const gErr = (res, code, reason, message) => send(res, code, { error: { code, message: message || reason, errors: [{ reason, message: message || reason }] } });
  const body = (req) => new Promise((r) => { const b = []; req.on('data', (c) => b.push(c)); req.on('end', () => r(Buffer.concat(b))); });
  const pick = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, trashed: !!f.trashed, webViewLink: `https://drive.google.com/mock/${f.id}` });
  const isTrashed = (f) => { for (let x = f; x; x = st.files[(x.parents || [])[0]]) if (x.trashed) return true; return false; };
  function parseMultipart(buf, ct) {
    const b = /boundary=([^;]+)/.exec(ct)[1];
    const parts = buf.toString('latin1').split('--' + b).slice(1, -1);
    const [metaPart, mediaPart] = parts;
    const meta = JSON.parse(metaPart.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim());
    const i = mediaPart.indexOf('\r\n\r\n');
    const head = mediaPart.slice(0, i); const media = Buffer.from(mediaPart.slice(i + 4, -2), 'latin1');
    return { meta, media, mime: (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] };
  }
  function create(meta, media, mime) {
    const parents = meta.parents || ['root'];
    if (parents[0] !== 'root' && !st.files[parents[0]]) return null;
    const f = { id: id('f'), name: meta.name, mimeType: meta.mimeType || mime, parents, size: media ? media.length : 0, sha: media ? crypto.createHash('sha1').update(media).digest('hex') : '', versions: 1 };
    st.files[f.id] = f; return f;
  }
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname; const buf = await body(req);
    const formB = () => Object.fromEntries(new URLSearchParams(buf.toString()));
    if (!p.startsWith('/mock/')) st.calls.push(`${req.method} ${p}${u.searchParams.get('uploadType') ? '?uploadType=' + u.searchParams.get('uploadType') : ''}`);
    // ---- control
    if (p === '/mock/state') return send(res, 200, { files: Object.values(st.files).map((f) => ({ ...pick(f), size: f.size, sha: f.sha, versions: f.versions, inTrash: isTrashed(f) })), perms: st.perms, calls: st.calls, revoked: st.revoked.length });
    if (p === '/mock/reset') { reset(); return send(res, 200, {}); }
    if (p === '/mock/approve' || p === '/mock/deny') { if (st.device) st.device.state = p.endsWith('approve') ? 'ok' : 'denied'; return send(res, 200, { ok: !!st.device }); }
    if (p === '/mock/fail') { st.fail = { n: Number(u.searchParams.get('n') || 1), status: Number(u.searchParams.get('status') || 500), reason: u.searchParams.get('reason') || 'backendError' }; return send(res, 200, {}); }
    if (p === '/mock/folder') { const f = create({ name: u.searchParams.get('name') || 'Shared', mimeType: 'application/vnd.google-apps.folder' }); return send(res, 200, { id: f.id }); }
    if (p === '/mock/trash') { const f = st.files[u.searchParams.get('id')]; if (f) f.trashed = true; return send(res, 200, { ok: !!f }); }
    // ---- oauth
    if (p === '/device/code') {
      const f = formB(); if (f.client_id !== 'test-client.apps.googleusercontent.com') return send(res, 401, { error: 'invalid_client', error_description: 'The OAuth client was not found.' });
      if (f.scope !== 'https://www.googleapis.com/auth/drive.file') return send(res, 400, { error: 'invalid_scope' });
      st.device = { code: id('dc'), user: 'MOCK-' + crypto.randomBytes(2).toString('hex').toUpperCase(), state: 'pending' };
      return send(res, 200, { device_code: st.device.code, user_code: st.device.user, verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 1 });
    }
    if (p === '/token') {
      const f = formB();
      if (f.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        if (f.client_secret !== 'test-secret') return send(res, 401, { error: 'invalid_client' });
        if (!st.device || f.device_code !== st.device.code) return send(res, 400, { error: 'invalid_grant' });
        if (st.device.state === 'pending') return send(res, 428, { error: 'authorization_pending', error_description: 'Precondition Required' });
        if (st.device.state === 'denied') return send(res, 403, { error: 'access_denied', error_description: 'Forbidden' });
        const a = id('at'), r = id('rt'); st.access.add(a); st.refresh.add(r); st.device = null;
        return send(res, 200, { access_token: a, refresh_token: r, expires_in: 3599, scope: f.scope, token_type: 'Bearer' });
      }
      if (f.grant_type === 'refresh_token') {
        if (!st.refresh.has(f.refresh_token)) return send(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        const a = id('at'); st.access.add(a); return send(res, 200, { access_token: a, expires_in: 3599, token_type: 'Bearer' });
      }
      if (f.grant_type === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        const [h, c, sig] = String(f.assertion).split('.');
        const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
        if (!h || !sig || !claims.iss || !/auth\/drive$/.test(claims.scope)) return send(res, 400, { error: 'invalid_grant' });
        const a = id('at'); st.access.add(a); return send(res, 200, { access_token: a, expires_in: 3599, token_type: 'Bearer' });
      }
      return send(res, 400, { error: 'unsupported_grant_type' });
    }
    if (p === '/revoke') { const f = formB(); st.refresh.delete(f.token); st.revoked.push(1); return send(res, 200, {}); }
    // ---- drive (auth required)
    const auth = String(req.headers.authorization || '');
    if (!st.access.has(auth.replace(/^Bearer /, ''))) return gErr(res, 401, 'authError', 'Invalid Credentials');
    if (st.fail && st.fail.n > 0) { st.fail.n--; return gErr(res, st.fail.status, st.fail.reason, 'Injected failure'); }
    if (p === '/drive/v3/about') return send(res, 200, { user: { emailAddress: 'jason@kpi.example', displayName: 'Jason' } });
    let m;
    if (req.method === 'POST' && p === '/drive/v3/files') { const f = create(JSON.parse(buf.toString())); return f ? send(res, 200, pick(f)) : gErr(res, 404, 'notFound', 'File not found (parent).'); }
    if ((m = /^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/.exec(p))) {
      const type = u.searchParams.get('uploadType');
      if (type === 'multipart') {
        const { meta, media, mime } = parseMultipart(buf, req.headers['content-type']);
        if (m[1]) { const f = st.files[m[1]]; if (!f) return gErr(res, 404, 'notFound'); if (meta.name) f.name = meta.name; f.size = media.length; f.sha = crypto.createHash('sha1').update(media).digest('hex'); f.versions++; return send(res, 200, pick(f)); }
        const f = create(meta, media, mime); return f ? send(res, 200, pick(f)) : gErr(res, 404, 'notFound', 'File not found (parent).');
      }
      if (type === 'resumable') {
        const sid = id('s'); st.sessions[sid] = { meta: JSON.parse(buf.toString() || '{}'), id: m[1], mime: req.headers['x-upload-content-type'] };
        const host = req.headers.host; return send(res, 200, undefined, { location: `http://${host}/upload/resumable/${sid}` });
      }
      return gErr(res, 400, 'badRequest', 'uploadType');
    }
    if ((m = /^\/upload\/resumable\/([^/]+)$/.exec(p)) && req.method === 'PUT') {
      const s = st.sessions[m[1]]; if (!s) return gErr(res, 404, 'notFound');
      delete st.sessions[m[1]];
      if (s.id) { const f = st.files[s.id]; f.size = buf.length; f.sha = crypto.createHash('sha1').update(buf).digest('hex'); f.versions++; if (s.meta.name) f.name = s.meta.name; return send(res, 200, pick(f)); }
      const f = create(s.meta, buf, s.mime); return f ? send(res, 200, pick(f)) : gErr(res, 404, 'notFound');
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/([^/]+))?$/.exec(p))) {
      const f = st.files[m[1]]; if (!f) return gErr(res, 404, 'notFound');
      st.perms[m[1]] = st.perms[m[1]] || [];
      if (req.method === 'POST') { const j = JSON.parse(buf.toString()); if (/@blocked\./.test(j.emailAddress)) return gErr(res, 403, 'invalidSharingRequest', 'Sharing outside the domain is not allowed.'); const pm = { id: id('p'), ...j }; st.perms[m[1]].push(pm); return send(res, 200, { id: pm.id }); }
      if (req.method === 'DELETE') { const before = st.perms[m[1]].length; st.perms[m[1]] = st.perms[m[1]].filter((x) => x.id !== m[2]); return before === st.perms[m[1]].length ? gErr(res, 404, 'notFound') : send(res, 204); }
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p))) {
      const f = st.files[m[1]]; if (!f) return gErr(res, 404, 'notFound', `File not found: ${m[1]}.`);
      if (req.method === 'GET') return send(res, 200, { ...pick(f), trashed: isTrashed(f) });
      if (req.method === 'PATCH') {
        const j = JSON.parse(buf.toString() || '{}');
        if (j.name) f.name = j.name; if (j.trashed) f.trashed = true;
        const add = u.searchParams.get('addParents'), rem = u.searchParams.get('removeParents');
        if (add || rem) f.parents = [...f.parents.filter((x) => x !== rem), ...(add ? [add] : [])];
        return send(res, 200, pick(f));
      }
      if (req.method === 'DELETE') { delete st.files[m[1]]; return send(res, 204); }
    }
    gErr(res, 404, 'notFound', 'mock: no route ' + req.method + ' ' + p);
  });
  return new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(server)));
}
if (import.meta.url === `file://${process.argv[1]}`) startMock().then((s) => console.log('mock google on', s.address().port));
