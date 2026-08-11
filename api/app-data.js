const { getSession } = require('../lib/auth');
const { getAppData, getPublicAppData } = require('../lib/data');
const { ok, error, method } = require('../lib/http');

module.exports = async function handler(req, res) {
  try {
    method(req, ['GET']);

    // Sem sessão: visão pública anonimizada, para o visitante ver o ranking.
    const session = getSession(req);
    ok(res, session ? await getAppData(session) : await getPublicAppData());
  } catch (err) {
    error(res, err);
  }
};
