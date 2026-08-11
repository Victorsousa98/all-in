const { requireSession, assertSameOrigin } = require('../lib/auth');
const { addTournament } = require('../lib/data');
const { ok, error, method } = require('../lib/http');

module.exports = async function handler(req, res) {
  try {
    method(req, ['POST']);
    assertSameOrigin(req);
    const session = requireSession(req);
    ok(res, await addTournament(session, req.body || {}));
  } catch (err) {
    error(res, err);
  }
};
