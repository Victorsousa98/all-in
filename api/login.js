const {
  verifyGoogleCredential,
  setSession,
  assertSameOrigin
} = require('../lib/auth');
const { ok, error, method } = require('../lib/http');

module.exports = async function handler(req, res) {
  try {
    method(req, ['POST']);
    assertSameOrigin(req);

    const credential = req.body?.credential;
    if (!credential) {
      const err = new Error('Credencial Google ausente.');
      err.statusCode = 400;
      throw err;
    }

    const user = await verifyGoogleCredential(credential);
    setSession(res, user);

    ok(res, { ok: true });
  } catch (err) {
    error(res, err);
  }
};
