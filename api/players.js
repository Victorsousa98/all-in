const { requireSession, assertSameOrigin } = require('../lib/auth');
const { addPlayer } = require('../lib/data');
const { ok, error, method } = require('../lib/http');

module.exports = async function handler(req, res) {
  try {
    method(req, ['POST']);
    assertSameOrigin(req);
    const session = requireSession(req);
    ok(res, await addPlayer(session, req.body?.name));
  } catch (err) {
    error(res, err);
  }
};
