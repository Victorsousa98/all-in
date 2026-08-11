const { clearSession, assertSameOrigin } = require('../lib/auth');
const { ok, error, method } = require('../lib/http');

module.exports = async function handler(req, res) {
  try {
    method(req, ['POST']);
    assertSameOrigin(req);
    clearSession(res);
    ok(res, { ok: true });
  } catch (err) {
    error(res, err);
  }
};
