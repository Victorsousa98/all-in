const { google } = require('googleapis');

const PLAYER_HEADERS = [
  'ID', 'Jogador', 'Ativo', 'Email Google', 'Foto URL', 'Administrador'
];

// Vencedor e Participantes (D/E) guardam nomes apenas para leitura humana da
// planilha. A referência canônica é Vencedor ID / Participantes IDs (K/L).
const TOURNAMENT_HEADERS = [
  'ID', 'Data', 'Buy-in', 'Vencedor', 'Participantes',
  'Qtd. jogadores', 'Prêmio', 'Criado em', 'Criado por', 'Email criador',
  'Vencedor ID', 'Participantes IDs'
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável ${name} não configurada.`);
  return value;
}

function spreadsheetId() {
  return required('GOOGLE_SHEET_ID');
}

function auth() {
  const email = required('GOOGLE_SERVICE_ACCOUNT_EMAIL');
  const privateKey = required('GOOGLE_PRIVATE_KEY').replace(/\\n/g, '\n');

  return new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
}

function sheets() {
  return google.sheets({ version: 'v4', auth: auth() });
}

async function ensureInfrastructure() {
  const api = sheets();
  const id = spreadsheetId();

  const meta = await api.spreadsheets.get({
    spreadsheetId: id,
    fields: 'sheets.properties'
  });

  const existing = new Set(
    (meta.data.sheets || []).map(s => s.properties.title)
  );

  const requests = [];
  if (!existing.has('Jogadores')) {
    requests.push({ addSheet: { properties: { title: 'Jogadores' } } });
  }
  if (!existing.has('Torneios')) {
    requests.push({ addSheet: { properties: { title: 'Torneios' } } });
  }

  if (requests.length) {
    await api.spreadsheets.batchUpdate({
      spreadsheetId: id,
      requestBody: { requests }
    });
  }

  const current = await api.spreadsheets.values.batchGet({
    spreadsheetId: id,
    ranges: ['Jogadores!A1:F1', 'Torneios!A1:L1']
  });

  const playerHeader = current.data.valueRanges?.[0]?.values?.[0] || [];
  const tournamentHeader = current.data.valueRanges?.[1]?.values?.[0] || [];

  if (PLAYER_HEADERS.some((h, i) => playerHeader[i] !== h)) {
    await api.spreadsheets.values.update({
      spreadsheetId: id,
      range: 'Jogadores!A1:F1',
      valueInputOption: 'RAW',
      requestBody: { values: [PLAYER_HEADERS] }
    });
  }

  if (TOURNAMENT_HEADERS.some((h, i) => tournamentHeader[i] !== h)) {
    await api.spreadsheets.values.update({
      spreadsheetId: id,
      range: 'Torneios!A1:L1',
      valueInputOption: 'RAW',
      requestBody: { values: [TOURNAMENT_HEADERS] }
    });
  }
}

async function getValues(range) {
  await ensureInfrastructure();
  const response = await sheets().spreadsheets.values.get({
    spreadsheetId: spreadsheetId(),
    range
  });
  return response.data.values || [];
}

async function appendValues(range, values) {
  await ensureInfrastructure();
  await sheets().spreadsheets.values.append({
    spreadsheetId: spreadsheetId(),
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
}

async function updateValues(range, values) {
  await ensureInfrastructure();
  await sheets().spreadsheets.values.update({
    spreadsheetId: spreadsheetId(),
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values }
  });
}

module.exports = {
  PLAYER_HEADERS,
  TOURNAMENT_HEADERS,
  getValues,
  appendValues,
  updateValues
};
