const { ok, error, method } = require('../lib/http');

module.exports = async function handler(req, res) {
  try {
    method(req, ['GET']);
    ok(res, {
      googleClientId: process.env.GOOGLE_CLIENT_ID || ''
    });
  } catch (err) {
    error(res, err);
  }
};
