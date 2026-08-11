# All-in Poker — Vercel + Google Sheets

Esta versão NÃO usa Apps Script para exibir o app.

## Arquitetura

- Vercel: frontend + API
- Google Identity Services: login
- Google Sheets: banco de dados
- Service Account: acesso privado da API ao Sheets
- Cookie HttpOnly assinado: sessão do usuário

Os amigos não precisam ter acesso direto à planilha.

## 1. Google Cloud

Use um projeto no Google Cloud.

Ative:

- Google Sheets API

### OAuth

Crie um OAuth Client ID do tipo "Web application".

Em "Authorized JavaScript origins", adicione:

- http://localhost:3000 (opcional para desenvolvimento)
- https://SEU-PROJETO.vercel.app

Copie o Client ID para `GOOGLE_CLIENT_ID`.

### Service Account

Crie uma Service Account e uma chave JSON.

Você precisará de:

- `client_email` -> `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `private_key` -> `GOOGLE_PRIVATE_KEY`

Abra sua planilha no Google Sheets e compartilhe-a como **Editor** com o e-mail da Service Account.

## 2. ID da planilha

Na URL:

`https://docs.google.com/spreadsheets/d/ESTE_E_O_ID/edit`

Copie o trecho entre `/d/` e `/edit` para `GOOGLE_SHEET_ID`.

A API usa as abas:

- `Jogadores`
- `Torneios`

Se elas não existirem, são criadas automaticamente. Os cabeçalhos também são normalizados sem apagar os dados.

Em `Torneios`, as colunas `Vencedor ID` (K) e `Participantes IDs` (L) são a
referência canônica dos jogadores. `Vencedor` (D) e `Participantes` (E) guardam
nomes apenas para leitura humana da planilha — nenhum cálculo depende deles.
Assim, renomear um jogador não exige alterar nenhum torneio antigo.

### Migrando uma planilha antiga

Planilhas criadas antes das colunas K/L precisam de um backfill único:

```bash
node scripts/backfill-tournament-ids.js --dry-run   # relatório, não escreve
node scripts/backfill-tournament-ids.js --apply     # executa
node scripts/backfill-tournament-ids.js --verify    # audita, não escreve
```

O script resolve cada nome em `Vencedor`/`Participantes` para o ID do jogador
correspondente. Ele aborta sem escrever nada se encontrar qualquer problema, e
o relatório traz linha, torneio, campo, valor e motivo:

| Categoria | Significado | Como corrigir |
|---|---|---|
| `INEXISTENTE` | nome não existe em `Jogadores` | corrija a grafia em `Torneios`, ou cadastre o jogador (pode ficar com `Ativo=false`) |
| `AMBIGUO` | dois jogadores têm o mesmo nome | renomeie um deles em `Jogadores`, ou preencha K/L dessa linha à mão |
| `ID_INEXISTENTE` | K/L referenciam um ID que não existe | corrija ou limpe as duas colunas para remigrar |
| `INCONSISTENTE` | migração parcial (só K ou só L), ID repetido, ou vencedor fora dos participantes | corrija na planilha |

Nomes ambíguos nunca são resolvidos escolhendo um jogador arbitrário — nem no
script, nem em tempo de execução.

Rodar duas vezes é seguro: linhas já migradas são ignoradas (mas continuam
sendo validadas). Faça uma cópia da planilha antes de usar `--apply`.

`--verify` audita 100% das linhas sem escrever nada e sai com código diferente
de zero se houver qualquer pendência. O fallback por nome em `lib/data.js` só
deve ser removido quando esse modo reportar cobertura total.

### Rollback

As colunas A:J nunca são alteradas pelo backfill, e o código anterior lê apenas
`Torneios!A2:J` — então voltar para uma versão antiga continua funcionando mesmo
com K/L preenchidos.

Uma ressalva: depois da migração, renomear um jogador passa a alterar somente a
aba `Jogadores`, e `Vencedor`/`Participantes` viram um snapshot histórico do nome
na data da partida. Por isso, um rollback feito **após uma renomeação** exibiria
o nome antigo no ranking e no histórico daquelas partidas, separando-o do nome
novo. Antes da primeira renomeação pós-migração, o rollback é transparente.

## 3. Variáveis da Vercel

Na Vercel:

Project > Settings > Environment Variables

Crie:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_PRIVATE_KEY`
- `ADMIN_EMAIL`
- `SESSION_SECRET`

Para `SESSION_SECRET`, use uma string aleatória longa.

Exemplo no terminal:

`openssl rand -base64 48`

Para `GOOGLE_PRIVATE_KEY`, copie exatamente a `private_key` do JSON da Service Account.
A Vercel aceita os `\n`; o código converte corretamente.

## 4. GitHub

Crie um repositório, por exemplo:

`allin-poker`

Envie todos os arquivos desta pasta.

## 5. Vercel

1. Add New > Project
2. Importe `allin-poker`
3. Framework Preset: Other
4. Adicione as variáveis de ambiente
5. Deploy

Sua URL ficará parecida com:

`https://allin-poker.vercel.app`

## 6. IMPORTANTE após o primeiro deploy

Volte ao OAuth Client ID no Google Cloud e confirme que a URL exata da Vercel está em:

**Authorized JavaScript origins**

Exemplo:

`https://allin-poker.vercel.app`

Se você mudar o nome do projeto/domínio, atualize essa origem.

## Segurança

- O navegador nunca recebe a chave da Service Account.
- O ID token do Google é verificado no backend.
- A sessão fica em cookie `HttpOnly`, `Secure` e `SameSite=Lax`.
- Apenas `ADMIN_EMAIL` pode cadastrar/remover jogadores manualmente.
- Jogadores comuns podem registrar partidas após vincular o perfil.
- Ações de escrita verificam a origem da requisição.
# all-in
