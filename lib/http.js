function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function ok(res, body) {
  json(res, 200, body);
}

function error(res, err) {
  console.error(err);
  json(res, err.statusCode || 500, {
    error: err.message || 'Erro interno.'
  });
}

function method(req, allowed) {
  if (!allowed.includes(req.method)) {
    const err = new Error('Método não permitido.');
    err.statusCode = 405;
    throw err;
  }
}

module.exports = { json, ok, error, method };
