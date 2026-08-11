#!/usr/bin/env node
/**
 * Backfill das colunas Vencedor ID (K) e Participantes IDs (L) da aba Torneios.
 *
 * Resolve cada nome gravado em Vencedor/Participantes para o ID do jogador
 * correspondente na aba Jogadores. Aborta sem escrever nada se encontrar
 * qualquer problema: nome inexistente, nome ambíguo (dois jogadores com o mesmo
 * nome) ou linha já migrada com dados inválidos/parciais.
 *
 *   node scripts/backfill-tournament-ids.js --dry-run   relatório, zero escrita
 *   node scripts/backfill-tournament-ids.js --apply     executa
 *   node scripts/backfill-tournament-ids.js --verify    audita 100% das linhas
 *
 * Requer as mesmas variáveis de ambiente da aplicação:
 *   GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY
 */

const { getValues, updateValues } = require('../lib/sheets');

const APPLY = process.argv.includes('--apply');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');

const AMBIGUOUS = Symbol('ambiguous');

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

// Mesma normalização de lib/data.js: colapsa espaços internos e ignora caixa.
function nameKey(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Chave tolerante usada apenas para sugerir correções no relatório:
// ignora acentos, pontuação e espaços repetidos.
function loosely(value) {
  return nameKey(value)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '');
}

function splitList(value) {
  return String(value || '').split('|').map(x => x.trim()).filter(Boolean);
}

async function main() {
  const modes = [APPLY, DRY_RUN, VERIFY].filter(Boolean).length;
  if (modes === 0) {
    fail('Escolha um modo: --dry-run (relatório), --apply (executa) ou --verify (audita).');
  }
  if (modes > 1) {
    fail('Escolha apenas um modo: --dry-run, --apply ou --verify.');
  }

  const modeLabel = APPLY
    ? 'APPLY (escreve na planilha)'
    : VERIFY ? 'VERIFY (audita, não escreve)' : 'DRY-RUN (não escreve nada)';

  console.log(`Modo: ${modeLabel}`);
  console.log(`Planilha: ${process.env.GOOGLE_SHEET_ID || '(GOOGLE_SHEET_ID não definido)'}\n`);

  // ---- índice de jogadores -----------------------------------------------
  const playerRows = (await getValues('Jogadores!A2:F'))
    .map((r, index) => ({
      rowNumber: index + 2,
      id: String(r[0] || ''),
      name: String(r[1] || '')
    }))
    .filter(r => r.id && r.name);

  if (!playerRows.length) fail('Nenhum jogador encontrado na aba Jogadores.');

  const knownIds = new Set(playerRows.map(r => r.id));
  const nameById = new Map(playerRows.map(r => [r.id, r.name]));

  // nome -> id, ou AMBIGUOUS quando dois jogadores compartilham o nome.
  const idByName = new Map();
  const idsByName = new Map();
  const looseByName = new Map();

  for (const row of playerRows) {
    const key = nameKey(row.name);
    if (!key) continue;

    idByName.set(key, idByName.has(key) ? AMBIGUOUS : row.id);

    if (!idsByName.has(key)) idsByName.set(key, []);
    idsByName.get(key).push(row.id);

    const loose = loosely(row.name);
    if (loose && !looseByName.has(loose)) looseByName.set(loose, row);
  }

  // ---- leitura dos torneios ----------------------------------------------
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

  // ---- análise ------------------------------------------------------------
  const problems = [];
  const planned = [];
  let migrated = 0;
  let pending = 0;

  function problem(t, field, value, kind, reason) {
    problems.push({ rowNumber: t.rowNumber, tournamentId: t.id, field, value, kind, reason });
  }

  for (const t of tournaments) {
    const hasIds = t.participantIds.length > 0;
    const hasWinnerId = t.winnerId !== '';

    // --- linha já migrada: valida, nunca corrige automaticamente -----------
    if (hasIds || hasWinnerId) {
      migrated++;

      if (!hasIds) {
        problem(t, 'Participantes IDs (L)', '', 'INCONSISTENTE',
          `coluna K preenchida ("${t.winnerId}") mas L vazia — migração parcial`);
        continue;
      }

      for (const id of t.participantIds) {
        if (!knownIds.has(id)) {
          problem(t, 'Participantes IDs (L)', id, 'ID_INEXISTENTE',
            'não corresponde a nenhum jogador da aba Jogadores');
        }
      }

      if (new Set(t.participantIds).size !== t.participantIds.length) {
        problem(t, 'Participantes IDs (L)', t.participantIds.join(' | '), 'INCONSISTENTE',
          'o mesmo ID aparece mais de uma vez');
      }

      if (!hasWinnerId) {
        if (t.winner) {
          problem(t, 'Vencedor ID (K)', '', 'INCONSISTENTE',
            `coluna K vazia mas D indica vencedor "${t.winner}" — migração parcial`);
        }
      } else if (!knownIds.has(t.winnerId)) {
        problem(t, 'Vencedor ID (K)', t.winnerId, 'ID_INEXISTENTE',
          'não corresponde a nenhum jogador da aba Jogadores');
      } else if (!t.participantIds.includes(t.winnerId)) {
        problem(t, 'Vencedor ID (K)', t.winnerId, 'INCONSISTENTE',
          `vencedor (${nameById.get(t.winnerId)}) não está entre os participantes`);
      }

      continue;
    }

    // --- linha ainda não migrada: resolve nomes ---------------------------
    pending++;

    const participantIds = [];
    let rowOk = true;

    const describeName = (field, name) => {
      const resolved = idByName.get(nameKey(name));

      if (resolved === AMBIGUOUS) {
        const ids = idsByName.get(nameKey(name)) || [];
        problem(t, field, name, 'AMBIGUO', `corresponde a ${ids.join(' e ')}`);
        return null;
      }

      if (!resolved) {
        const guess = looseByName.get(loosely(name));
        const hint = guess && nameKey(guess.name) !== nameKey(name)
          ? `nenhum jogador com esse nome (parece "${guess.name}")`
          : 'nenhum jogador com esse nome na aba Jogadores';
        problem(t, field, name, 'INEXISTENTE', hint);
        return null;
      }

      return resolved;
    };

    for (const name of t.participants) {
      const id = describeName('Participantes (E)', name);
      if (!id) { rowOk = false; continue; }
      participantIds.push(id);
    }

    let winnerId = '';
    if (t.winner) {
      const id = describeName('Vencedor (D)', t.winner);
      if (!id) rowOk = false;
      else winnerId = id;
    }

    if (!rowOk) continue;

    if (new Set(participantIds).size !== participantIds.length) {
      problem(t, 'Participantes (E)', t.participants.join(' | '), 'INCONSISTENTE',
        'dois participantes resolvem para o mesmo jogador');
      continue;
    }

    if (winnerId && !participantIds.includes(winnerId)) {
      problem(t, 'Vencedor (D)', t.winner, 'INCONSISTENTE',
        'o vencedor não está entre os participantes');
      continue;
    }

    planned.push({
      rowNumber: t.rowNumber,
      tournamentId: t.id,
      winnerId,
      participantIds
    });
  }

  // ---- relatório de problemas --------------------------------------------
  if (problems.length) {
    console.log('='.repeat(70));
    console.log(`ABORTADO: ${problems.length} problema(s) encontrado(s)`);
    console.log('='.repeat(70));
    console.log('\nNenhuma escrita foi feita.\n');

    for (const p of problems) {
      console.log(
        `linha ${p.rowNumber} | torneio ${p.tournamentId} | ${p.field} ` +
        `"${p.value}" | ${p.kind} | ${p.reason}`
      );
    }

    console.log('\nComo corrigir:');
    console.log('  INEXISTENTE   corrija a grafia em Torneios, ou cadastre o jogador');
    console.log('                em Jogadores (pode ficar com Ativo=false).');
    console.log('  AMBIGUO       dois jogadores têm o mesmo nome. Renomeie um deles em');
    console.log('                Jogadores, ou preencha K/L dessa linha à mão.');
    console.log('  ID_INEXISTENTE / INCONSISTENTE');
    console.log('                K/L foram preenchidos à mão com dados inválidos.');
    console.log('                Corrija ou limpe as duas colunas para remigrar.');
    console.log('\nDepois rode o dry-run de novo.\n');
    process.exit(1);
  }

  // ---- modo verify --------------------------------------------------------
  if (VERIFY) {
    console.log(`Linhas migradas e íntegras: ${migrated}`);
    console.log(`Linhas ainda sem K/L:       ${pending}\n`);

    if (pending) {
      console.log('='.repeat(70));
      console.log(`INCOMPLETO: ${pending} torneio(s) ainda dependem do nome.`);
      console.log('='.repeat(70));
      console.log('\nRode --apply para migrar. O fallback por nome em lib/data.js');
      console.log('só pode ser removido quando este modo reportar 0 pendentes.\n');
      process.exit(1);
    }

    console.log('OK: 100% dos torneios têm K/L válidos.');
    console.log('Sem órfãos, ambiguidades ou inconsistências.');
    console.log('O fallback por nome pode ser removido com segurança.\n');
    return;
  }

  console.log(`Já migrados (ignorados): ${migrated}`);
  console.log(`A migrar: ${planned.length}\n`);

  if (!planned.length) {
    console.log('Nada a fazer.\n');
    return;
  }

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
  console.log('Confira o ranking no app: deve estar idêntico ao de antes.');
  console.log('Depois rode --verify para confirmar cobertura total.\n');
}

main().catch(err => {
  console.error('\nFALHOU:', err.message);
  process.exit(1);
});
