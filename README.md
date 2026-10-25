# Jungle Wagering

## O que é

Serviço de carteira para apostas. Provedores de jogos mandam transações (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) por HTTP ou por uma fila SQS FIFO, e o serviço debita ou credita a carteira do jogador registrando cada movimento num ledger. Dinheiro nunca é `number`: é inteiro em centavos no código, `numeric` no banco e string decimal (`"10.00"`) na API. A idempotência fica gravada no PostgreSQL, o consumo da fila usa inbox, a publicação de eventos usa outbox, e tudo roda com várias réplicas ao mesmo tempo. A autenticação é feita pelo Keycloak. As decisões, os trade-offs e as limitações estão no [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- Docker com o plugin Compose. Testado com Docker 29.7.2 e Docker Compose 5.5.0.
- Bun 1.4.4 (a versão de `.bun-version`), só para rodar lint e testes fora dos containers.
- `curl` e `jq` para os exemplos abaixo.

As portas 8080, 8081, 4566 e 5432 precisam estar livres no host.

## Subir

```sh
cp .env.example .env
docker compose up -d --wait
```

Na primeira vez o Compose constrói a imagem da aplicação; depois disso a subida leva por volta de um minuto. O `--wait` só devolve o terminal quando todos os serviços estão saudáveis. Antes da aplicação subir, o serviço `migrate` aplica as migrations e o `queues-init` cria as filas.

O que fica de pé:

| Serviço        | Réplicas | Papel                                                                    |
| -------------- | -------- | ------------------------------------------------------------------------ |
| `nginx`        | 1        | balanceia a API entre as réplicas                                        |
| `api`          | 3        | API HTTP                                                                 |
| `consumer`     | 3        | consome a fila `wager-transactions.fifo`                                 |
| `outbox`       | 2        | publica os eventos da outbox na fila `wallet-events.fifo`                |
| `scheduler`    | 2        | resolve transações pendentes de referência e roda a reconciliação global |
| `events-audit` | 1        | consome `wallet-events.fifo` e grava o que recebeu                       |
| `postgres`     | 1        | PostgreSQL 17                                                            |
| `ministack`    | 1        | emulador de SQS                                                          |
| `keycloak`     | 1        | Identity Provider                                                        |

Portas no host:

| Porta | Serviço                                                        |
| ----- | -------------------------------------------------------------- |
| 8080  | nginx, a porta de entrada da API                               |
| 8081  | Keycloak (console em `http://localhost:8081`, `admin`/`admin`) |
| 4566  | MiniStack (SQS)                                                |
| 5432  | PostgreSQL (`postgres`/`postgres`, banco `jungle`)             |

Para derrubar e apagar os dados:

```sh
docker compose down -v
```

Prometheus, Grafana e Jaeger ainda não fazem parte do Compose, então não existe o perfil `observability`. O [ARCHITECTURE.md](ARCHITECTURE.md) explica o que ficou de fora.

## Obter token

O realm `jungle` já vem importado com três clientes de client credentials:

| Cliente      | Segredo             | Papel      | `provider_id` |
| ------------ | ------------------- | ---------- | ------------- |
| `provider-a` | `provider-a-secret` | `provider` | `provider-a`  |
| `provider-b` | `provider-b-secret` | `provider` | `provider-b`  |
| `backoffice` | `backoffice-secret` | `operator` | —             |

O token do provedor:

```sh
curl -s -X POST http://localhost:8081/realms/jungle/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret
```

O do backoffice é o mesmo comando com `client_id=backoffice` e `client_secret=backoffice-secret`. Os exemplos daqui em diante usam duas variáveis:

```sh
export PROVIDER_TOKEN=$(curl -s -X POST http://localhost:8081/realms/jungle/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=provider-a -d client_secret=provider-a-secret | jq -r .access_token)
export OPERATOR_TOKEN=$(curl -s -X POST http://localhost:8081/realms/jungle/protocol/openid-connect/token \
  -d grant_type=client_credentials -d client_id=backoffice -d client_secret=backoffice-secret | jq -r .access_token)
```

O token vale 5 minutos. Se alguma chamada voltar 401, gere de novo.

## Usar

Quem cria carteira, lê o ledger e pede reconciliação é o `operator`. Quem manda transação é o `provider`, e o `providerId` do corpo precisa ser o mesmo do token.

### Criar carteira

```sh
export PLAYER_ID=$(uuidgen | tr 'A-Z' 'a-z')
WALLET=$(curl -s -X POST http://localhost:8080/wallets \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")
echo "$WALLET"
export WALLET_ID=$(echo "$WALLET" | jq -r .id)
```

A resposta é `201` com `{ "id", "playerId", "balance", "version" }`. Criar de novo para o mesmo jogador e moeda dá `409` `WALLET_ALREADY_EXISTS`. As moedas aceitas estão em `SUPPORTED_CURRENCIES` no `.env` (BRL, USD e EUR).

### Mandar transações

Toda transação vai para `POST /wagering/transactions` com o header `Idempotency-Key`. A chave e o `externalTransactionId` valem para o provedor inteiro, não por carteira: para repetir os exemplos numa carteira nova, troque os ids ou suba do zero com `docker compose down -v`. Para não repetir o `curl` inteiro, defina esta função; o primeiro argumento é a chave e o corpo entra pela entrada padrão:

```sh
wager() {
  curl -s -w '\nHTTP %{http_code}\n' -X POST http://localhost:8080/wagering/transactions \
    -H "Authorization: Bearer $PROVIDER_TOKEN" \
    -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $1" \
    --data @-
}
```

`BET` de 10,00 (debita):

```sh
wager key-bet-1 <<EOF
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-1",
  "playerId": "$PLAYER_ID",
  "walletId": "$WALLET_ID",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "10.00", "currency": "BRL" }
}
EOF
```

A resposta é `200` com o desfecho:

```json
{
  "transactionId": "01a171b2-2b17-72eb-be87-e4101a1f1e36",
  "status": "PROCESSED",
  "kind": "BET",
  "balance": { "amount": "90.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Quando a transação é rejeitada (saldo insuficiente, referência inválida e afins), a resposta é `422` com o mesmo formato mais `failureCode`, `retryable` e `action`, que diz ao provedor se deve corrigir, reenviar ou desistir.

`WIN` de 25,00 na mesma rodada, apontando para a aposta (credita):

```sh
wager key-win-1 <<EOF
{
  "providerId": "provider-a",
  "externalTransactionId": "win-1",
  "playerId": "$PLAYER_ID",
  "walletId": "$WALLET_ID",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "WIN",
  "money": { "amount": "25.00", "currency": "BRL" },
  "referenceExternalTransactionId": "bet-1"
}
EOF
```

`LOSS` fecha uma rodada perdida. Ela não mexe no saldo, só registra o desfecho:

```sh
wager key-bet-2 <<EOF
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-2",
  "playerId": "$PLAYER_ID",
  "walletId": "$WALLET_ID",
  "roundId": "round-2",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "10.00", "currency": "BRL" }
}
EOF
wager key-loss-2 <<EOF
{
  "providerId": "provider-a",
  "externalTransactionId": "loss-2",
  "playerId": "$PLAYER_ID",
  "walletId": "$WALLET_ID",
  "roundId": "round-2",
  "gameId": "game-1",
  "kind": "LOSS",
  "money": { "amount": "0.00", "currency": "BRL" },
  "referenceExternalTransactionId": "bet-2"
}
EOF
```

`REFUND` devolve uma aposta. Só vale para `BET` e o valor precisa ser o mesmo:

```sh
wager key-bet-3 <<EOF
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-3",
  "playerId": "$PLAYER_ID",
  "walletId": "$WALLET_ID",
  "roundId": "round-3",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "5.00", "currency": "BRL" }
}
EOF
wager key-refund-3 <<EOF
{
  "providerId": "provider-a",
  "externalTransactionId": "refund-3",
  "playerId": "$PLAYER_ID",
  "walletId": "$WALLET_ID",
  "roundId": "round-3",
  "gameId": "game-1",
  "kind": "REFUND",
  "money": { "amount": "5.00", "currency": "BRL" },
  "referenceExternalTransactionId": "bet-3"
}
EOF
```

`ROLLBACK` desfaz uma `BET`, `WIN` ou `REFUND`. Aqui ele desfaz o prêmio da primeira rodada:

```sh
wager key-rollback-1 <<EOF
{
  "providerId": "provider-a",
  "externalTransactionId": "rollback-1",
  "playerId": "$PLAYER_ID",
  "walletId": "$WALLET_ID",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "ROLLBACK",
  "money": { "amount": "25.00", "currency": "BRL" },
  "referenceExternalTransactionId": "win-1"
}
EOF
```

Uma reversão que chega antes da transação que ela referencia volta `202` com `status: "PENDING_REFERENCE"`. Quando a referência chega, o `scheduler` resolve a pendência sozinho:

```sh
wager key-refund-4 <<EOF
{
  "providerId": "provider-a",
  "externalTransactionId": "refund-4",
  "playerId": "$PLAYER_ID",
  "walletId": "$WALLET_ID",
  "roundId": "round-4",
  "gameId": "game-1",
  "kind": "REFUND",
  "money": { "amount": "7.00", "currency": "BRL" },
  "referenceExternalTransactionId": "bet-4"
}
EOF
wager key-bet-4 <<EOF
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-4",
  "playerId": "$PLAYER_ID",
  "walletId": "$WALLET_ID",
  "roundId": "round-4",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "7.00", "currency": "BRL" }
}
EOF
```

### Replay e conflito

Mandar a mesma requisição de novo, com a mesma chave e o mesmo corpo, não debita outra vez. A resposta é a original, com `idempotentReplay: true`:

```sh
wager key-bet-1 <<EOF
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-1",
  "playerId": "$PLAYER_ID",
  "walletId": "$WALLET_ID",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "10.00", "currency": "BRL" }
}
EOF
```

A mesma chave com outro corpo dá `409` `IDEMPOTENCY_KEY_CONFLICT`, em `application/problem+json`:

```sh
wager key-bet-1 <<EOF
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-1",
  "playerId": "$PLAYER_ID",
  "walletId": "$WALLET_ID",
  "roundId": "round-1",
  "gameId": "game-1",
  "kind": "BET",
  "money": { "amount": "99.00", "currency": "BRL" }
}
EOF
```

Uma chave nova com o mesmo `externalTransactionId` e corpo diferente dá `409` `EXTERNAL_TRANSACTION_ID_CONFLICT`.

### Consultar

Carteira. O `operator` vê tudo; o `provider` vê só saldo e versão:

```sh
curl -s http://localhost:8080/wallets/$WALLET_ID -H "Authorization: Bearer $OPERATOR_TOKEN"
curl -s http://localhost:8080/wallets/$WALLET_ID -H "Authorization: Bearer $PROVIDER_TOKEN"
```

Ledger, do lançamento mais novo para o mais antigo. `limit` vai de 1 a 200 (padrão 50) e a próxima página vem pelo `nextCursor`:

```sh
PAGE=$(curl -s "http://localhost:8080/wallets/$WALLET_ID/ledger?limit=3" \
  -H "Authorization: Bearer $OPERATOR_TOKEN")
echo "$PAGE"
curl -s "http://localhost:8080/wallets/$WALLET_ID/ledger?limit=3&cursor=$(echo "$PAGE" | jq -r .nextCursor)" \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

Transação pelo id interno ou pelo id do provedor. Um provedor só enxerga as próprias transações; as de outro provedor dão `404`:

```sh
export TRANSACTION_ID=$(curl -s http://localhost:8080/providers/provider-a/wagering/transactions/bet-1 \
  -H "Authorization: Bearer $PROVIDER_TOKEN" | jq -r .id)
curl -s http://localhost:8080/wagering/transactions/$TRANSACTION_ID -H "Authorization: Bearer $PROVIDER_TOKEN"
```

### Reconciliar

Recalcula o saldo a partir do ledger e confere a cadeia de lançamentos da carteira:

```sh
curl -s -X POST http://localhost:8080/wallets/$WALLET_ID/reconciliation \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
```

A resposta traz `storedBalance`, `calculatedBalance`, `difference` e `consistent: true` quando tudo bate. O `scheduler` também roda uma reconciliação global de tempos em tempos (`RECONCILIATION_INTERVAL_MS`).

### Pela fila

O mesmo pedido de transação pode chegar pela fila `wager-transactions.fifo`, que o `consumer` processa. O script `provider:simulate`, que publicaria cenários prontos nela, ainda não existe; esse canal está coberto pelos testes em `test/integration/sqs/`. O [ARCHITECTURE.md](ARCHITECTURE.md) traz os detalhes.

### Health e métricas

Rotas públicas, sem token:

```sh
curl -s http://localhost:8080/health/live
curl -s http://localhost:8080/health/ready
curl -s http://localhost:8080/metrics
```

## Testes

Instale as dependências uma vez:

```sh
bun install --frozen-lockfile
```

| Comando                    | Precisa de                    | Tempo aproximado |
| -------------------------- | ----------------------------- | ---------------- |
| `bun run lint`             | nada                          | 35 s             |
| `bun run typecheck`        | nada                          | 15 s             |
| `bun run format:check`     | nada                          | 3 s              |
| `bun run check:compliance` | nada                          | 1 s              |
| `bun run test:unit`        | nada                          | 15 s             |
| `bun run test:integration` | Docker                        | 4 min            |
| `bun run test:e2e`         | o Compose de pé (seção Subir) | 5 s              |

O `check:compliance` roda as checagens estáticas do projeto: dependências proibidas, comentários em arquivos que não são TypeScript, SQL com literal, migrations e mocks de PostgreSQL ou SQS nos testes.

O `test:integration` não usa o Compose. Ele sobe um PostgreSQL e um MiniStack próprios pelo testcontainers, aplica as migrations e roda contra eles de verdade, sem mock de banco nem de fila. Pode rodar com o Compose de pé ao mesmo tempo.

O `test:e2e` fala com o Compose pelo host: API em `localhost:8080`, Keycloak em `localhost:8081` e PostgreSQL em `localhost:5432` (usuário `postgres`). Ele confere que os tokens do Keycloak, pedidos de fora e de dentro da rede do Compose, são aceitos por todas as réplicas da API.

Os testes de concorrência e de conformidade dinâmica (`test:concurrency`, `test:compliance`) ainda não têm casos nesta versão, e o teste de carga (`test:load`) ainda não foi implementado. Por isso esses três scripts falham, e o `bun run test`, que encadeia unit, integration, concurrency e compliance, para no `test:concurrency`. O [ARCHITECTURE.md](ARCHITECTURE.md) registra isso nas limitações.

## Operação

O `.env` aponta para os nomes de host da rede do Compose (`postgres`, `ministack`), então os scripts de operação rodam dentro dos containers, que já têm a configuração certa.

Devolver para a fila principal as mensagens que foram para a DLQ (`wager-transactions-dlq.fifo`):

```sh
docker compose exec consumer bun run dlq:redrive
```

Mensagens com motivo terminal (`PROCESSING_FAILED`, `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `INBOX_PAYLOAD_MISMATCH`, `INVALID_PAYLOAD`) ficam na DLQ, porque reprocessar não muda o resultado. Para mandar essas também:

```sh
docker compose exec consumer bun run dlq:redrive --force
```

O script imprime um resumo como `dlq redrive: redriven=2 skipped=1 (INVALID_PAYLOAD=1) errors=0`. Ele só termina depois de uma leitura vazia na DLQ, então leva uns 20 segundos (`SQS_RECEIVE_WAIT_SECONDS`) mesmo quando não há nada para mover.

Antecipar os eventos da outbox que estão estacionados esperando a próxima tentativa:

```sh
docker compose exec outbox bun run outbox:requeue
```

Aplicar as migrations pendentes ou desfazer a última (o serviço `migrate` usa o papel dono do schema, `jungle_owner`):

```sh
docker compose run --rm migrate bun run db:migrate
docker compose run --rm migrate bun run db:migrate:down
```

Cuidado com o `down` com a aplicação de pé: a última migration é a dos grants, então desfazê-la tira o acesso do `jungle_app` e a API para de responder até você rodar o `db:migrate` de novo.

Criar as filas e a redrive policy de novo, se você apagou alguma:

```sh
docker compose run --rm queues-init bun run queues:init
```

## Observabilidade

Cada processo expõe métricas no formato do Prometheus em `/metrics`, todas com o prefixo `jungle_`. Pelo nginx você cai numa das réplicas da API a cada chamada. Para ver um processo específico, chame de dentro do container:

```sh
curl -s http://localhost:8080/metrics | grep '^jungle_wager'
docker compose exec consumer wget -qO- http://localhost:3000/metrics | grep '^jungle_outbox'
```

Os logs saem em JSON, uma linha por evento, e trazem `correlationId`, `requestId`, `transactionId`, `walletId`, `providerId`, `instanceId` e `component` quando fazem sentido. Valores monetários, corpos de requisição e tokens nunca vão para o log.

```sh
docker compose logs -f api consumer
```

Para seguir uma requisição, mande um `X-Correlation-Id`. A API devolve esse header, junto com um `X-Request-Id` gerado por ela, e o mesmo id aparece nos logs e nos eventos publicados:

```sh
curl -s -o /dev/null http://localhost:8080/wallets/$WALLET_ID \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'X-Correlation-Id: meu-id'
docker compose logs api | grep '"correlationId":"meu-id"'
```

Prometheus, o dashboard do Grafana e os traces no Jaeger ainda não estão no Compose; o [ARCHITECTURE.md](ARCHITECTURE.md) conta como isso ficou.

## CI

O pipeline está em `.github/workflows/ci.yml` e roda em todo push e pull request. Hoje são dois jobs:

| Job      | Roda                                                             | O que prova                                                                                  |
| -------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `static` | `lint`, `typecheck`, `build`, `check:compliance`, `format:check` | o código compila, segue as regras de lint e formatação e passa nas checagens de conformidade |
| `unit`   | `test:unit` (depois do `static`)                                 | as regras de domínio e de aplicação funcionam isoladas                                       |

Os jobs de integração, concorrência, conformidade dinâmica e e2e ainda não estão no pipeline; o [ARCHITECTURE.md](ARCHITECTURE.md) explica.

Recomendação: configure a branch protection da `main` exigindo os dois jobs (`static` e `unit`) antes do merge, e acrescente cada job novo à lista quando ele entrar no pipeline.
