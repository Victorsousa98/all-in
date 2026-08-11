const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const COOKIE_NAME = 'allin_session';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável ${name} não configurada.`);
  return value;
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function signPayload(payload) {
  const secret = required('SESSION_SECRET');
  const body = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}

function verifySignedPayload(value) {
  if (!value || !value.includes('.')) return null;

  const secret = required('SESSION_SECRET');
  const [body, signature] = value.split('.');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('base64url');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw.split(';')
      .map(x => x.trim())
      .filter(Boolean)
      .map(x => {
        const i = x.indexOf('=');
        return [decodeURIComponent(x.slice(0, i)), decodeURIComponent(x.slice(i + 1))];
      })
  );
}

function getSession(req) {
  return verifySignedPayload(parseCookies(req)[COOKIE_NAME]);
}

function setSession(res, user) {
  const payload = {
    sub: user.sub,
    email: user.email,
    name: user.name,
    picture: user.picture || '',
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  };

  const value = signPayload(payload);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
  );
}

function clearSession(res) {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  );
}

async function verifyGoogleCredential(credential) {
  const clientId = required('GOOGLE_CLIENT_ID');
  const client = new OAuth2Client(clientId);

  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: clientId
  });

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload?.email || payload.email_verified !== true) {
    throw new Error('Conta Google inválida ou e-mail não verificado.');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    name: payload.name || payload.email.split('@')[0],
    picture: payload.picture || ''
  };
}

function requireSession(req) {
  const session = getSession(req);
  if (!session) {
    const err = new Error('Não autenticado.');
    err.statusCode = 401;
    throw err;
  }
  return session;
}

function assertSameOrigin(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;

  const origin = req.headers.origin;
  if (!origin) return;

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const expected = `${protocol}://${host}`;

  if (origin !== expected) {
    const err = new Error('Origem inválida.');
    err.statusCode = 403;
    throw err;
  }
}

module.exports = {
  verifyGoogleCredential,
  setSession,
  clearSession,
  getSession,
  requireSession,
  assertSameOrigin
};
