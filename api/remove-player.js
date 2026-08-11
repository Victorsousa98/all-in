const { requireSession, assertSameOrigin } = require('../lib/auth');
const { removePlayer } = require('../lib/data');
const { ok, error, method } = require('../lib/http');

module.exports = async function handler(req, res) {
  try {
    method(req, ['POST']);
    assertSameOrigin(req);
    const session = requireSession(req);
    ok(res, await removePlayer(session, req.body?.playerId));
  } catch (err) {
    error(res, err);
  }
};
