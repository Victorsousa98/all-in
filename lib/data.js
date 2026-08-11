const crypto = require('crypto');
const {
  getValues,
  appendValues,
  updateValues
} = require('./sheets');

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function truthy(value) {
  if (value === true) return true;
  const x = String(value || '').trim().toLowerCase();
  return !['false', '0', 'não', 'nao', ''].includes(x);
}

function adminEmail() {
  return String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
}

async function getPlayerRows() {
  const rows = await getValues('Jogadores!A2:F');
  return rows.map((r, index) => ({
    rowNumber: index + 2,
    id: String(r[0] || ''),
    name: String(r[1] || ''),
    active: truthy(r[2]),
    email: String(r[3] || ''),
    photo: String(r[4] || ''),
    adminStored: truthy(r[5])
  })).filter(r => r.id || r.name);
}

function splitList(value) {
  return String(value || '').split('|').map(x => x.trim()).filter(Boolean);
}

async function getTournamentRows() {
  const rows = await getValues('Torneios!A2:L');
  return rows.map((r, index) => ({
    rowNumber: index + 2,
    id: String(r[0] || ''),
    date: String(r[1] || ''),
    buyIn: Number(String(r[2] || '0').replace(',', '.')) || 0,
    winner: String(r[3] || ''),
    participants: splitList(r[4]),
    playerCount: Number(r[5]) || 0,
    prize: Number(String(r[6] || '0').replace(',', '.')) || 0,
    createdAt: String(r[7] || ''),
    createdBy: String(r[8] || ''),
    creatorEmail: String(r[9] || ''),
    winnerId: String(r[10] || ''),
    participantIds: splitList(r[11])
  })).filter(r => r.id);
}

// Resolve um torneio para IDs de jogador. Linhas já migradas usam as colunas
// K/L; as demais caem no nome (D/E) até o backfill rodar.
function tournamentPlayerIds(tournament, idByName) {
  if (tournament.participantIds.length) {
    return {
      winnerId: tournament.winnerId,
      participantIds: tournament.participantIds,
      migrated: true
    };
  }

  return {
    winnerId: idByName.get(tournament.winner.trim().toLowerCase()) || '',
    participantIds: tournament.participants
      .map(name => idByName.get(name.toLowerCase()) || '')
      .filter(Boolean),
    migrated: false
  };
}

function indexPlayersByName(playerRows) {
  const map = new Map();
  for (const row of playerRows) {
    const key = row.name.trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, row.id);
  }
  return map;
}

async function currentUserContext(session) {
  const rows = await getPlayerRows();
  const email = session.email.toLowerCase();
  const row = rows.find(r => r.email.trim().toLowerCase() === email);

  if (!row) {
    return {
      email: session.email,
      googleName: session.name,
      photo: session.picture || '',
      linked: false,
      isAdmin: email === adminEmail(),
      playerId: '',
      playerName: ''
    };
  }

  return {
    email: session.email,
    googleName: session.name,
    photo: session.picture || row.photo || '',
    linked: true,
    isAdmin: email === adminEmail() || row.adminStored,
    playerId: row.id,
    playerName: row.name
  };
}

async function getPlayers() {
  const rows = await getPlayerRows();
  return rows
    .filter(r => r.name && r.active)
    .map(r => ({
      id: r.id,
      name: r.name,
      email: r.email,
      photo: r.photo,
      isAdmin: r.email.trim().toLowerCase() === adminEmail() || r.adminStored
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

async function getLinkablePlayers() {
  const rows = await getPlayerRows();
  return rows
    .filter(r => r.name && r.active && !r.email.trim())
    .map(r => ({ id: r.id, name: r.name, photo: r.photo }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

// Agrupa por ID de jogador; o nome vem da aba Jogadores só na exibição.
// Assim renomear alguém não fragmenta nem duplica o histórico.
async function getRanking() {
  const [tournaments, playerRows] = await Promise.all([
    getTournamentRows(),
    getPlayerRows()
  ]);

  const idByName = indexPlayersByName(playerRows);
  const byId = new Map(playerRows.map(r => [r.id, r]));
  const stats = {};

  for (const t of tournaments) {
    const { winnerId, participantIds } = tournamentPlayerIds(t, idByName);

    for (const playerId of participantIds) {
      if (!stats[playerId]) {
        const player = byId.get(playerId);
        stats[playerId] = {
          id: playerId,
          name: player?.name || '',
          games: 0,
          wins: 0,
          invested: 0,
          received: 0,
          balance: 0,
          winRate: 0,
          roi: 0,
          photo: player?.photo || ''
        };
      }

      const s = stats[playerId];
      s.games += 1;
      s.invested += t.buyIn;

      if (playerId === winnerId) {
        s.wins += 1;
        s.received += t.prize;
      }
    }
  }

  return Object.values(stats)
    .map(s => {
      s.balance = s.received - s.invested;
      s.winRate = s.games ? s.wins / s.games : 0;
      s.roi = s.invested ? s.balance / s.invested : 0;
      return s;
    })
    .sort((a, b) =>
      b.balance - a.balance ||
      b.wins - a.wins ||
      b.winRate - a.winRate ||
      a.name.localeCompare(b.name, 'pt-BR')
    )
    .map((s, index) => ({ ...s, position: index + 1 }));
}

function formatDateBR(value) {
  if (!value) return '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return value;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Fortaleza'
  }).format(parsed);
}

async function getRecentTournaments() {
  const [rows, playerRows] = await Promise.all([
    getTournamentRows(),
    getPlayerRows()
  ]);

  const idByName = indexPlayersByName(playerRows);
  const nameById = new Map(playerRows.map(r => [r.id, r.name]));

  return rows
    .slice()
    .sort((a, b) => {
      const ad = new Date(a.date).getTime() || 0;
      const bd = new Date(b.date).getTime() || 0;
      if (bd !== ad) return bd - ad;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    })
    .slice(0, 10)
    .map(t => {
      // Nomes resolvidos pelo ID: o histórico acompanha renomeações.
      const { winnerId, participantIds } = tournamentPlayerIds(t, idByName);

      return {
        id: t.id,
        date: formatDateBR(t.date),
        winner: nameById.get(winnerId) || t.winner,
        playerCount: t.playerCount,
        buyIn: t.buyIn,
        prize: t.prize,
        participants: participantIds.length
          ? participantIds.map(id => nameById.get(id)).filter(Boolean)
          : t.participants,
        createdBy: t.createdBy
      };
    });
}

async function getDashboard() {
  const ranking = await getRanking();
  const tournaments = await getTournamentRows();

  return {
    tournaments: tournaments.length,
    totalMoved: tournaments.reduce((acc, t) => acc + t.prize, 0),
    leader: ranking[0] || null,
    mostWins: [...ranking].sort((a, b) =>
      b.wins - a.wins ||
      b.winRate - a.winRate ||
      b.balance - a.balance
    )[0] || null
  };
}

async function getAppData(session) {
  return {
    currentUser: await currentUserContext(session),
    players: await getPlayers(),
    linkablePlayers: await getLinkablePlayers(),
    dashboard: await getDashboard(),
    recent: await getRecentTournaments(),
    ranking: await getRanking()
  };
}

// Reduz um nome às iniciais: "Victor Sousa" -> "V. S."
function toInitials(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '—';

  return parts
    .slice(0, 2)
    .map(part => `${[...part][0].toUpperCase()}.`)
    .join(' ');
}

// Visão pública, sem sessão. A anonimização acontece aqui, no servidor: nome
// real, foto e e-mail nunca chegam ao cliente anônimo.
async function getPublicAppData() {
  const [dashboard, recent, ranking] = await Promise.all([
    getDashboard(),
    getRecentTournaments(),
    getRanking()
  ]);

  const anonymize = entry => entry && ({
    ...entry,
    name: toInitials(entry.name),
    photo: ''
  });

  return {
    currentUser: null,
    players: [],
    linkablePlayers: [],
    anonymous: true,
    dashboard: {
      ...dashboard,
      leader: anonymize(dashboard.leader),
      mostWins: anonymize(dashboard.mostWins)
    },
    recent: recent.map(t => ({
      ...t,
      winner: toInitials(t.winner),
      participants: t.participants.map(toInitials),
      createdBy: t.createdBy ? toInitials(t.createdBy) : ''
    })),
    ranking: ranking.map(entry => ({
      ...anonymize(entry),
      id: ''
    }))
  };
}

async function completeOnboarding(session, payload = {}) {
  const existing = await currentUserContext(session);
  if (existing.linked) return getAppData(session);

  const rows = await getPlayerRows();
  const email = session.email.toLowerCase();
  const isAdmin = email === adminEmail();
  const playerId = String(payload.playerId || '').trim();
  const newName = normalizeName(payload.newName);

  if (!playerId && !newName) {
    throw new Error('Escolha seu jogador ou informe seu nome.');
  }

  if (playerId) {
    const target = rows.find(r => r.id === playerId);
    if (!target) throw new Error('Jogador não encontrado.');
    if (!target.active) throw new Error('Esse jogador está inativo.');

    const linkedEmail = target.email.trim().toLowerCase();
    if (linkedEmail && linkedEmail !== email) {
      throw new Error('Esse jogador já está vinculado a outra conta Google.');
    }

    const sameEmailElsewhere = rows.find(r =>
      r.id !== target.id &&
      r.email.trim().toLowerCase() === email
    );
    if (sameEmailElsewhere) {
      throw new Error('Sua conta já está vinculada a outro jogador.');
    }

    await updateValues(`Jogadores!D${target.rowNumber}:F${target.rowNumber}`, [[
      session.email,
      session.picture || '',
      isAdmin
    ]]);

    return getAppData(session);
  }

  const duplicate = rows.find(r =>
    r.active &&
    r.name.toLowerCase() === newName.toLowerCase()
  );
  if (duplicate) {
    throw new Error('Esse nome já existe. Use "Já estou cadastrado".');
  }

  await appendValues('Jogadores!A:F', [[
    crypto.randomUUID(),
    newName,
    true,
    session.email,
    session.picture || '',
    isAdmin
  ]]);

  return getAppData(session);
}

async function requireLinked(session) {
  const context = await currentUserContext(session);
  if (!context.linked) {
    const err = new Error('Configure seu perfil antes de continuar.');
    err.statusCode = 403;
    throw err;
  }
  return context;
}

async function requireAdmin(session) {
  const context = await requireLinked(session);
  if (!context.isAdmin) {
    const err = new Error('Somente o administrador pode fazer essa alteração.');
    err.statusCode = 403;
    throw err;
  }
  return context;
}

async function addPlayer(session, rawName) {
  await requireAdmin(session);
  const name = normalizeName(rawName);
  if (!name) throw new Error('Informe o nome do jogador.');

  const rows = await getPlayerRows();

  const active = rows.find(r =>
    r.active && r.name.toLowerCase() === name.toLowerCase()
  );
  if (active) throw new Error('Esse jogador já está cadastrado.');

  const inactive = rows.find(r =>
    !r.active && r.name.toLowerCase() === name.toLowerCase()
  );

  if (inactive) {
    await updateValues(`Jogadores!C${inactive.rowNumber}`, [[true]]);
  } else {
    await appendValues('Jogadores!A:F', [[
      crypto.randomUUID(), name, true, '', '', false
    ]]);
  }

  return getAppData(session);
}

async function removePlayer(session, playerId) {
  await requireAdmin(session);
  const rows = await getPlayerRows();
  const target = rows.find(r => r.id === String(playerId || ''));

  if (!target) throw new Error('Jogador não encontrado.');

  const active = rows.filter(r => r.active && r.name);
  if (active.length <= 2) {
    throw new Error('Mantenha pelo menos 2 jogadores ativos.');
  }

  await updateValues(`Jogadores!C${target.rowNumber}`, [[false]]);
  return getAppData(session);
}

async function renamePlayer(session, playerId, rawName) {
  // Cada jogador renomeia a si mesmo; o admin renomeia qualquer um.
  // A identidade do solicitante vem da sessão, nunca do payload.
  const actor = await requireLinked(session);

  const id = String(playerId || '').trim();
  const name = normalizeName(rawName);

  if (!id) throw new Error('Jogador não informado.');

  const canRename = actor.isAdmin || actor.playerId === id;
  if (!canRename) {
    const err = new Error('Você só pode editar o seu próprio nome.');
    err.statusCode = 403;
    throw err;
  }

  if (!name) throw new Error('Informe o nome do jogador.');
  if (name.length > 40) throw new Error('O nome pode ter no máximo 40 caracteres.');

  const rows = await getPlayerRows();
  const target = rows.find(r => r.id === id);
  if (!target) throw new Error('Jogador não encontrado.');

  const previousName = target.name;
  if (previousName === name) return getAppData(session);

  const duplicate = rows.find(r =>
    r.id !== target.id &&
    r.active &&
    r.name.toLowerCase() === name.toLowerCase()
  );
  if (duplicate) throw new Error('Já existe um jogador ativo com esse nome.');

  // Ranking e histórico são agrupados por ID, então renomear é uma escrita
  // única. ID, ativo, e-mail, foto e flag de admin ficam intactos.
  await updateValues(`Jogadores!B${target.rowNumber}`, [[name]]);

  // As colunas Vencedor/Participantes existem só para leitura humana da
  // planilha. Atualizá-las é cosmético: nenhum cálculo depende delas depois do
  // backfill. Linhas ainda não migradas dependem, então são corrigidas aqui.
  const tournaments = await getTournamentRows();
  const previous = previousName.toLowerCase();

  const affected = tournaments.filter(t =>
    t.winner.trim().toLowerCase() === previous ||
    t.participants.some(p => p.toLowerCase() === previous)
  );

  for (const t of affected) {
    const winner = t.winner.trim().toLowerCase() === previous ? name : t.winner;
    const participants = t.participants
      .map(p => (p.toLowerCase() === previous ? name : p))
      .join(' | ');

    await updateValues(`Torneios!D${t.rowNumber}:E${t.rowNumber}`, [[winner, participants]]);
  }

  return getAppData(session);
}

async function addTournament(session, payload = {}) {
  const actor = await requireLinked(session);

  const date = String(payload.date || '').trim();
  const buyIn = Number(payload.buyIn);
  const winnerId = String(payload.winner || '').trim();
  const participantIds = Array.isArray(payload.participants)
    ? payload.participants.map(x => String(x || '').trim()).filter(Boolean)
    : [];

  if (!date) throw new Error('Informe a data.');
  if (!Number.isFinite(buyIn) || buyIn <= 0) {
    throw new Error('O buy-in deve ser maior que zero.');
  }

  if (new Set(participantIds).size !== participantIds.length) {
    throw new Error('Há jogador duplicado na partida.');
  }

  if (participantIds.length < 2) {
    throw new Error('Selecione pelo menos 2 jogadores.');
  }

  if (!winnerId) throw new Error('Selecione o vencedor.');

  if (!participantIds.includes(winnerId)) {
    throw new Error('O vencedor precisa estar entre os participantes.');
  }

  const activeById = new Map(
    (await getPlayers()).map(p => [p.id, p])
  );

  const invalid = participantIds.find(id => !activeById.has(id));
  if (invalid) throw new Error(`Jogador inválido ou inativo: ${invalid}`);

  const prize = buyIn * participantIds.length;
  const names = participantIds.map(id => activeById.get(id).name);

  // D/E guardam nomes só para leitura humana da planilha; K/L são a referência.
  await appendValues('Torneios!A:L', [[
    crypto.randomUUID(),
    date,
    buyIn,
    activeById.get(winnerId).name,
    names.join(' | '),
    participantIds.length,
    prize,
    new Date().toISOString(),
    actor.playerName,
    actor.email,
    winnerId,
    participantIds.join(' | ')
  ]]);

  return getAppData(session);
}

module.exports = {
  getAppData,
  getPublicAppData,
  completeOnboarding,
  addPlayer,
  removePlayer,
  renamePlayer,
  addTournament
};
