const { requireSession } = require('../lib/auth');
const { getAppData } = require('../lib/data');
const { ok, error, method } = require('../lib/http');

module.exports = async function handler(req, res) {
  try {
    method(req, ['GET']);
    const session = requireSession(req);
    ok(res, await getAppData(session));
  } catch (err) {
    error(res, err);
  }
};
