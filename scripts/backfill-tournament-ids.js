#!/usr/bin/env node
/**
 * Backfill das colunas Vencedor ID (K) e Participantes IDs (L) da aba Torneios.
 *
 * Resolve cada nome gravado em Vencedor/Participantes para o ID do jogador
 * correspondente na aba Jogadores. Aborta sem escrever nada se algum nome não
 * resolver, listando os órfãos para correção manual.
 *
 *   node scripts/backfill-tournament-ids.js --dry-run   relatório, zero escrita
 *   node scripts/backfill-tournament-ids.js --apply     executa
 *
 * Requer as mesmas variáveis de ambiente da aplicação:
 *   GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
 */

const { getValues, updateValues } = require('../lib/sheets');

const APPLY = process.argv.includes('--apply');
const DRY_RUN = process.argv.includes('--dry-run');

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

// Chave tolerante usada apenas para sugerir correções no relatório:
// ignora acentos, pontuação e espaços repetidos.
function loosely(value) {
  return normalizeKey(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '');
}

function splitList(value) {
  return String(value || '').split('|').map(x => x.trim()).filter(Boolean);
}

async function main() {
  if (!APPLY && !DRY_RUN) {
    fail('Escolha um modo: --dry-run (relatório) ou --apply (executa).');
  }
  if (APPLY && DRY_RUN) {
    fail('Use --dry-run OU --apply, não os dois.');
  }

  console.log(`Modo: ${APPLY ? 'APPLY (escreve na planilha)' : 'DRY-RUN (não escreve nada)'}`);
  console.log(`Planilha: ${process.env.GOOGLE_SHEET_ID || '(GOOGLE_SHEET_ID não definido)'}\n`);

  const playerRows = (await getValues('Jogadores!A2:F'))
    .map(r => ({ id: String(r[0] || ''), name: String(r[1] || '') }))
    .filter(r => r.id && r.name);

  if (!playerRows.length) fail('Nenhum jogador encontrado na aba Jogadores.');

  const idByName = new Map();
  const looseByName = new Map();
  const duplicateNames = [];

  for (const row of playerRows) {
    const key = normalizeKey(row.name);
    if (idByName.has(key)) {
      duplicateNames.push(row.name);
      continue;
    }
    idByName.set(key, row.id);

    const loose = loosely(row.name);
    if (loose && !looseByName.has(loose)) looseByName.set(loose, row);
  }

  if (duplicateNames.length) {
    console.log('AVISO: nomes repetidos em Jogadores (o primeiro vence na resolução):');
    duplicateNames.forEach(n => console.log(`  - ${n}`));
    console.log('');
  }

  const tournaments = (await getValues('Torneios!A2:L'))
    .map((r, index) => ({
      rowNumber: index + 2,
      id: String(r[0] || ''),
      winner: String(r[3] || ''),
      participants: splitList(r[4]),
      winnerId: String(r[10] || ''),
      participantIds: splitList(r[11])
    }))
    .filter(t => t.id);

  console.log(`Jogadores: ${playerRows.length}   Torneios: ${tournaments.length}\n`);

  const orphans = new Map();   // nome órfão -> Set de torneios
  const planned = [];
  let alreadyMigrated = 0;

  function noteOrphan(name, tournamentId) {
    if (!orphans.has(name)) orphans.set(name, new Set());
    orphans.get(name).add(tournamentId);
  }

  for (const t of tournaments) {
    if (t.participantIds.length) { alreadyMigrated++; continue; }

    const participantIds = [];
    let rowHasOrphan = false;

    for (const name of t.participants) {
      const id = idByName.get(normalizeKey(name));
      if (!id) { noteOrphan(name, t.id); rowHasOrphan = true; continue; }
      participantIds.push(id);
    }

    const winnerId = idByName.get(normalizeKey(t.winner));
    if (t.winner && !winnerId) { noteOrphan(t.winner, t.id); rowHasOrphan = true; }

    if (rowHasOrphan) continue;

    if (winnerId && !participantIds.includes(winnerId)) {
      fail(
        `Torneio ${t.id} (linha ${t.rowNumber}): o vencedor "${t.winner}" não está ` +
        `entre os participantes. Corrija na planilha antes de migrar.`
      );
    }

    if (new Set(participantIds).size !== participantIds.length) {
      fail(
        `Torneio ${t.id} (linha ${t.rowNumber}): dois participantes resolvem para ` +
        `o mesmo jogador. Corrija na planilha antes de migrar.`
      );
    }

    planned.push({
      rowNumber: t.rowNumber,
      tournamentId: t.id,
      winnerId: winnerId || '',
      participantIds
    });
  }

  if (orphans.size) {
    console.log('='.repeat(64));
    console.log('ABORTADO: nomes sem jogador correspondente na aba Jogadores');
    console.log('='.repeat(64));
    console.log('\nNenhuma escrita foi feita.\n');

    for (const [name, ids] of [...orphans].sort()) {
      const suggestion = looseByName.get(loosely(name));
      const hint = suggestion && normalizeKey(suggestion.name) !== normalizeKey(name)
        ? `   (parece "${suggestion.name}")`
        : '';
      console.log(`  "${name}"${hint}`);
      console.log(`      torneios: ${[...ids].join(', ')}`);
    }

    console.log('\nPara cada nome acima, escolha uma correção na planilha:');
    console.log('  a) corrigir a grafia em Torneios para bater com a aba Jogadores; ou');
    console.log('  b) cadastrar o jogador em Jogadores (pode ficar com Ativo=false).');
    console.log('\nDepois rode o dry-run de novo.\n');
    process.exit(1);
  }

  console.log(`Já migrados (ignorados): ${alreadyMigrated}`);
  console.log(`A migrar: ${planned.length}\n`);

  if (!planned.length) {
    console.log('Nada a fazer.\n');
    return;
  }

  const nameById = new Map(playerRows.map(r => [r.id, r.name]));
  const preview = planned.slice(0, 10);

  console.log('Prévia:');
  for (const p of preview) {
    const names = p.participantIds.map(id => nameById.get(id)).join(', ');
    console.log(`  linha ${p.rowNumber}  ${p.tournamentId}`);
    console.log(`    K = ${p.winnerId}  (${nameById.get(p.winnerId) || '—'})`);
    console.log(`    L = ${p.participantIds.join(' | ')}`);
    console.log(`        ${names}`);
  }
  if (planned.length > preview.length) {
    console.log(`  ... e mais ${planned.length - preview.length} linha(s).`);
  }
  console.log('');

  if (!APPLY) {
    console.log('DRY-RUN concluído. Nenhuma escrita feita.');
    console.log('Para aplicar: node scripts/backfill-tournament-ids.js --apply\n');
    return;
  }

  console.log('Escrevendo...');
  let done = 0;

  for (const p of planned) {
    await updateValues(`Torneios!K${p.rowNumber}:L${p.rowNumber}`, [[
      p.winnerId,
      p.participantIds.join(' | ')
    ]]);

    done++;
    if (done % 10 === 0 || done === planned.length) {
      console.log(`  ${done}/${planned.length}`);
    }
  }

  console.log(`\nConcluído: ${done} torneio(s) migrado(s).`);
  console.log('Confira o ranking no app: deve estar idêntico ao de antes.\n');
}

main().catch(err => {
  console.error('\nFALHOU:', err.message);
  process.exit(1);
});
