# Ledger Distribuído

Esta é a minha solução para o desafio técnico da Jungle Gaming: uma carteira com ledger de dupla entrada para provedores de jogos.

## O que é

Provedores de jogos mandam transações (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) por HTTP ou por uma fila SQS FIFO. O serviço debita ou credita a carteira do jogador e registra cada movimento no ledger.

Algumas escolhas que valem para o projeto inteiro:

- dinheiro nunca é `number`: é inteiro em centavos no código, `numeric` no banco e string decimal (`"10.00"`) na API;
- a idempotência fica gravada no PostgreSQL, o consumo da fila usa inbox e a publicação de eventos usa outbox;
- tudo roda com várias réplicas ao mesmo tempo;
- a autenticação é do Keycloak.

O porquê de cada decisão, o que eu descartei, os bugs que os testes pegaram e as limitações estão no [ARCHITECTURE.md](ARCHITECTURE.md).

## Pré-requisitos

- Docker com o plugin Compose. Testei com Docker 29.7.2 e Docker Compose 5.5.0.
- Bun 1.4.4 (a versão de `.bun-version`), só para rodar lint, testes e os scripts fora dos containers.
- `curl` e `jq` para os exemplos abaixo.

As portas 8080, 8081, 4566 e 5432 precisam estar livres no host. Com o perfil `observability`, também 9090, 3001, 16686 e 4318.

## Subir

```sh
cp .env.example .env
docker compose up -d --wait
```

Na primeira vez o Compose constrói a imagem da aplicação. Depois disso a subida leva por volta de um minuto. O `--wait` só devolve o terminal quando todos os serviços estão saudáveis. Antes da aplicação subir, o serviço `migrate` aplica as migrations e o `queues-init` cria as filas.

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

## Obter token

O realm `jungle` já vem importado com três clientes de client credentials:

| Cliente      | Segredo             | Papel      | `provider_id` |
| ------------ | ------------------- | ---------- | ------------- |
| `provider-a` | `provider-a-secret` | `provider` | `provider-a`  |
| `provider-b` | `provider-b-secret` | `provider` | `provider-b`  |
| `backoffice` | `backoffice-secret` | `operator` | —             |

Esses segredos, a senha `admin` do Keycloak e as senhas do `.env.example` existem só para rodar na sua máquina sem passo manual. Não use nada disso em produção; lá eles viriam de um cofre.

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

O token vale 5 minutos. Se alguma chamada voltar 401, gere de novo. Token sem `exp` também volta 401: a API não aceita token que nunca vence.

## Usar

Quem cria carteira, lê o ledger e pede reconciliação é o `operator`. Quem manda transação é o `provider`, e o `providerId` do corpo precisa ser o mesmo do token.

### Criar carteira

```sh
export PLAYER_ID=$(cat /proc/sys/kernel/random/uuid)
WALLET=$(curl -s -X POST http://localhost:8080/wallets \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"playerId\":\"$PLAYER_ID\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")
echo "$WALLET"
export WALLET_ID=$(echo "$WALLET" | jq -r .id)
```

A resposta é `201` com `{ "id", "playerId", "balance", "version" }`. Criar de novo para o mesmo jogador e moeda dá `409` `WALLET_ALREADY_EXISTS`. As moedas aceitas estão em `SUPPORTED_CURRENCIES` no `.env` (BRL, USD e EUR).

### Mandar transações

Toda transação vai para `POST /wagering/transactions` com o header `Idempotency-Key`. A chave e o `externalTransactionId` valem para o provedor inteiro, não por carteira. Para repetir os exemplos numa carteira nova, troque os ids ou suba do zero com `docker compose down -v`.

Para não repetir o `curl` inteiro, defina esta função. O primeiro argumento é a chave e o corpo entra pela entrada padrão:

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

Quando a transação é rejeitada (saldo insuficiente, referência inválida e afins), a resposta é `422` com o mesmo formato mais `failureCode`, `retryable` e `action`. O `action` diz ao provedor se ele deve corrigir, reenviar ou desistir.

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

`LOSS` fecha uma rodada perdida. Não mexe no saldo, só registra o desfecho:

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

`REFUND` devolve uma aposta. Só vale para `BET`, e o valor precisa ser o mesmo:

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

Uma chave nova com o mesmo `externalTransactionId` dá `409` `EXTERNAL_TRANSACTION_ID_CONFLICT`.

Alguns detalhes do contrato que costumam pegar quem integra:

- espaço nas pontas da `Idempotency-Key` é cortado, então `" key-bet-1 "` é a mesma chave que `key-bet-1`;
- o header `Idempotency-Key` repetido na mesma requisição dá `400` `MISSING_IDEMPOTENCY_KEY`;
- corpo JSON com chave repetida (`{"kind":"BET","kind":"WIN"}`, inclusive escrita com escape unicode) dá `400` `INVALID_PAYLOAD`;
- o corpo precisa estar em UTF-8; outro `charset` dá `400` `INVALID_PAYLOAD`.

### Consultar

Carteira. O `operator` vê tudo; o `provider` vê só saldo e versão:

```sh
curl -s http://localhost:8080/wallets/$WALLET_ID -H "Authorization: Bearer $OPERATOR_TOKEN"
curl -s http://localhost:8080/wallets/$WALLET_ID -H "Authorization: Bearer $PROVIDER_TOKEN"
```

Ledger, do lançamento mais novo para o mais antigo. `limit` vai de 1 a 200 (padrão 50) e a próxima página vem pelo `nextCursor`. O cursor é amarrado à carteira: usar o cursor de uma carteira no ledger de outra dá `400` `INVALID_PAYLOAD`.

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

O mesmo pedido de transação pode chegar pela fila `wager-transactions.fifo`, que o `consumer` processa. Para ver isso funcionando sem escrever mensagem na mão, eu fiz um simulador de provedor:

```sh
bun run provider:simulate --scenario mixed
```

Ele cria as carteiras pela API com o token do `backoffice`, publica as mensagens na fila em nome do `provider-a`, espera tudo assentar, reconcilia cada carteira e imprime um resumo. Sai com código 1 se alguma transação não terminar `PROCESSED`, se a fila não esvaziar, se algum saldo não for o esperado ou se alguma carteira não reconciliar.

Os cenários:

| `--scenario`   | O que publica em cada carteira                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------- |
| `duplicates`   | a mesma `BET` várias vezes, metade com o mesmo `messageId` e metade com `messageId` novo          |
| `out-of-order` | `REFUND` e `ROLLBACK` antes da `BET` que eles referenciam                                         |
| `concurrent`   | `BET`s de todas as carteiras ao mesmo tempo                                                       |
| `mixed`        | rodadas variadas: `BET` + `WIN`, `BET` + `LOSS`, `BET` + `REFUND`, `ROLLBACK` de `WIN` e de `BET` |

As opções:

| Opção             | Padrão                                                              |
| ----------------- | ------------------------------------------------------------------- |
| `--wallets N`     | 3 (máximo 100)                                                      |
| `--count N`       | 5 (máximo 500); rodadas ou cópias por carteira, conforme o cenário  |
| `--api-url`       | `http://localhost:8080`                                             |
| `--token-url`     | `http://localhost:8081/realms/jungle/protocol/openid-connect/token` |
| `--sqs-endpoint`  | `http://localhost:4566`                                             |
| `--client-id`     | `backoffice`                                                        |
| `--client-secret` | `backoffice-secret`                                                 |

Se preferir rodar de dentro da rede do Compose:

```sh
docker compose run --rm api bun scripts/provider-simulate.ts --scenario mixed \
  --api-url http://nginx \
  --token-url http://keycloak:8080/realms/jungle/protocol/openid-connect/token \
  --sqs-endpoint http://ministack:4566
```

O formato da mensagem e o que o consumer faz com cada erro estão no [ARCHITECTURE.md](ARCHITECTURE.md).

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

| Comando                    | Precisa de                    | Tempo aproximado                    |
| -------------------------- | ----------------------------- | ----------------------------------- |
| `bun run lint`             | nada                          | 35 s                                |
| `bun run typecheck`        | nada                          | 15 s                                |
| `bun run format:check`     | nada                          | 3 s                                 |
| `bun run check:compliance` | nada                          | 1 s                                 |
| `bun run test:unit`        | nada                          | 15 s                                |
| `bun run test:integration` | Docker                        | 5 min                               |
| `bun run test:concurrency` | Docker                        | 1 min                               |
| `bun run test:compliance`  | Docker                        | 15 s                                |
| `bun run test`             | Docker                        | soma dos quatro                     |
| `bun run test:e2e`         | o Compose de pé (seção Subir) | alguns minutos                      |
| `bun run test:load`        | Docker                        | 60 s por cenário, mais a preparação |

O `check:compliance` roda as checagens estáticas do projeto: dependências proibidas, comentários em arquivos que não são TypeScript, SQL com literal, migrations e mocks de PostgreSQL ou SQS nos testes.

O `test:integration` não usa o Compose. Ele sobe um PostgreSQL, um MiniStack e um Keycloak próprios pelo testcontainers, aplica as migrations e roda contra eles de verdade, sem mock de banco nem de fila. Pode rodar com o Compose de pé ao mesmo tempo. O Keycloak entra só no `test/integration/auth/auth-keycloak.test.ts`, que importa o realm real, pede tokens de client credentials e confere a API com eles; o resto usa um issuer de teste com o mesmo código de validação.

O `test:concurrency` sobe processos reais de cada serviço (`bun src/bootstrap/main-<serviço>.ts`, três APIs e três consumers na maioria dos cenários) sobre o mesmo PostgreSQL e MiniStack. Ele dispara carga concorrente pelo HTTP e pela fila, mata processos no meio com `SIGKILL` e confere saldo, lançamentos, idempotência e outbox no banco. Os cenários estão descritos no [ARCHITECTURE.md](ARCHITECTURE.md).

O `test:compliance` reúne uma prova curta e direta para cada restrição do desafio. São 11 arquivos em `test/compliance/`: de `r5-1` a `r5-9`, um por restrição inviolável (dinheiro sem `number`, idempotência persistente, não depender só do FIFO, publicar depois do commit, ledger imutável, sem lock global, sem ler-calcular-gravar, várias instâncias e garantias no schema), mais `r2-auth` para a autenticação e `e14-eliminatory` para as falhas eliminatórias.

O `bun run test` encadeia unit, integration, concurrency e compliance.

O `test:e2e` fala com o Compose pelo host: API em `localhost:8080`, Keycloak em `localhost:8081`, MiniStack em `localhost:4566` e PostgreSQL em `localhost:5432` (usuário `postgres`). Ele confere os tokens do Keycloak contra todas as réplicas, a distribuição pelo nginx, o simulador nos quatro cenários e a queda de uma réplica da api e de um consumer no meio da carga. A parte de observabilidade (`test/e2e/observability.e2e.test.ts`) só roda se o Prometheus estiver de pé; sem o perfil `observability`, ela aparece como pulada.

### Teste de carga

O teste de carga usa k6 (imagem `grafana/k6:1.8.1`) dentro da rede do Compose, batendo no nginx:

```sh
bun run test:load
```

Se a API não estiver respondendo em `localhost:8080`, o script sobe o Compose com o perfil `observability` sozinho. Os dois cenários:

- `hot-wallet`: uma carteira só, 50 usuários virtuais mandando `BET` de 0,01 o tempo todo. Mede a disputa pelo lock da mesma carteira.
- `distributed`: 1.000 carteiras, 200 usuários virtuais com rampa nos primeiros 20% do tempo. Cada rodada é uma `BET` seguida de `WIN` (40%) ou `LOSS` (60%), e 10% dos pedidos são reenviados com a mesma chave para medir o replay.

As opções:

| Opção                      | Padrão                                                              |
| -------------------------- | ------------------------------------------------------------------- |
| `--duration`               | `60s` (aceita `2m`, `1m30s` e afins)                                |
| `--scenario`               | `all`; ou `hot-wallet`, ou `distributed`                            |
| `--api-url`                | `http://localhost:8080`                                             |
| `--token-url`              | `http://localhost:8081/realms/jungle/protocol/openid-connect/token` |
| `--prometheus-url`         | `http://localhost:9090`                                             |
| `--k6-api-url`             | `http://nginx`                                                      |
| `--k6-token-url`           | `http://keycloak:8080/realms/jungle/protocol/openid-connect/token`  |
| `--operator-client-id`     | `backoffice`                                                        |
| `--operator-client-secret` | `backoffice-secret`                                                 |
| `--provider-client-id`     | `provider-a`                                                        |
| `--provider-client-secret` | `provider-a-secret`                                                 |
| `--provider-id`            | `provider-a`                                                        |
| `--no-up`                  | desligado; ligado, falha em vez de subir o Compose                  |

No fim ele imprime uma tabela por cenário com requisições, req/s, p50, p95 e p99, taxa de erro e o maior lag do outbox, mais os conflitos de lock lidos do Prometheus. Depois reconcilia todas as carteiras usadas. O relatório completo, com o ambiente (CPU, memória, versões de Docker e Bun), vai para `load-test-results/<data>.json`, que fica fora do git. O script sai com 1 se o k6 falhar, se alguma carteira não reconciliar ou se algum saldo ficar negativo. Os números que medi estão na seção 19 do [ARCHITECTURE.md](ARCHITECTURE.md).

## Operação

O `.env` aponta para os nomes de host da rede do Compose (`postgres`, `ministack`). Por isso os scripts de operação rodam dentro dos containers, que já têm a configuração certa.

Devolver para a fila principal as mensagens que foram para a DLQ (`wager-transactions-dlq.fifo`):

```sh
docker compose exec consumer bun run dlq:redrive
```

Mensagens com motivo terminal (`PROCESSING_FAILED`, `IDEMPOTENCY_KEY_CONFLICT`, `EXTERNAL_TRANSACTION_ID_CONFLICT`, `INBOX_PAYLOAD_MISMATCH`, `INVALID_PAYLOAD`) ficam na DLQ, porque reprocessar não muda o resultado. Para mandar essas também:

```sh
docker compose exec consumer bun run dlq:redrive --force
```

O script imprime um resumo como `dlq redrive: redriven=2 skipped=1 (INVALID_PAYLOAD=1) errors=0`. Ele trata no máximo a quantidade de mensagens que a DLQ tinha quando começou, e para antes se uma leitura voltar vazia (nesse caso espera os 20 segundos do `SQS_RECEIVE_WAIT_SECONDS`). Com `--force`, uma mensagem terminal reenviada falha de novo e volta para a DLQ. O script reconhece a volta pelo `originalMessageId`, não mexe nela outra vez e conta no resumo como `reappeared=N`.

Antecipar os eventos da outbox que estão estacionados esperando a próxima tentativa:

```sh
docker compose exec outbox bun run outbox:requeue
```

Aplicar as migrations pendentes ou desfazer a última (o serviço `migrate` usa o papel dono do schema, `jungle_owner`):

```sh
docker compose run --rm migrate bun run db:migrate
docker compose run --rm migrate bun run db:migrate:down
```

Cuidado com o `down` com a aplicação de pé. A última migration é a dos grants, então desfazê-la tira o acesso do `jungle_app`, e a API para de responder até você rodar o `db:migrate` de novo.

Criar as filas e a redrive policy de novo, se você apagou alguma:

```sh
docker compose run --rm queues-init bun run queues:init
```

## Observabilidade

Cada processo expõe métricas no formato do Prometheus em `/metrics`, todas com o prefixo `jungle_`. Pelo nginx você cai numa das réplicas da API a cada chamada. Para ver um processo específico, chame de dentro do container:

```sh
curl -s http://localhost:8080/metrics | grep '^jungle_wager'
docker compose exec scheduler wget -qO- http://localhost:3000/metrics | grep '^jungle_outbox'
```

Os logs saem em JSON, uma linha por evento, e trazem `correlationId`, `requestId`, `messageId`, `transactionId`, `walletId`, `providerId`, `instanceId` e `component` quando fazem sentido. Valores monetários, corpos de requisição e tokens nunca vão para o log.

```sh
docker compose logs -f api consumer
```

Para seguir uma requisição, mande um `X-Correlation-Id`. A API devolve esse header junto com um `X-Request-Id` gerado por ela, e o mesmo id aparece nos logs e nos eventos publicados:

```sh
curl -s -o /dev/null http://localhost:8080/wallets/$WALLET_ID \
  -H "Authorization: Bearer $OPERATOR_TOKEN" -H 'X-Correlation-Id: meu-id'
docker compose logs api | grep '"correlationId":"meu-id"'
```

### Prometheus, Grafana e Jaeger

Ficam num perfil separado do Compose, para a subida normal continuar leve:

```sh
OTEL_ENABLED=true docker compose --profile observability up -d --wait
```

| Endereço                 | O que tem                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `http://localhost:9090`  | Prometheus (`prom/prometheus:v3.0.0`). Em Status > Targets aparecem as 11 réplicas no job `jungle`                    |
| `http://localhost:3001`  | Grafana (`grafana/grafana:11.4.0`), `admin`/`admin`, com o dashboard `jungle-overview` já provisionado                |
| `http://localhost:16686` | Jaeger (`jaegertracing/all-in-one:1.76.0`), com os serviços `api`, `consumer`, `outbox`, `scheduler` e `events-audit` |

O Prometheus acha as réplicas pelo DNS do Compose e lê o `/metrics` de cada uma a cada 5 s. O dashboard mostra transações por status e canal, latência p50/p95/p99, replays e conflitos de idempotência, conflitos de lock, lag e estado da outbox, DLQ e pendentes.

Os traces vão por OTLP HTTP para o Jaeger (porta 4318). Sem `--profile observability`, sobe só o núcleo. Sem `OTEL_ENABLED=true`, o Jaeger sobe mas não recebe nada, porque o tracer fica desligado. Os spans que aparecem são `http.request`, `sqs.process`, `outbox.publish`, `db.transaction` e um `usecase.*` por caso de uso. A API aceita um `traceparent` de quem chama, e os eventos levam o `traceparent` nos atributos da mensagem SQS, então dá para seguir um evento do `outbox` até o `events-audit`. Health e métricas não geram span.

## CI

O pipeline está em `.github/workflows/ci.yml` e roda em todo push e pull request. São seis jobs em fila, cada um depois do anterior:

| Job           | Roda                                                                                           | O que prova                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `static`      | `lint`, `typecheck`, `build`, `check:compliance`, `format:check`                               | o código compila, segue as regras de lint e formatação e passa nas checagens estáticas de conformidade                                    |
| `unit`        | `test:unit`                                                                                    | as regras de domínio e de aplicação funcionam isoladas                                                                                    |
| `compliance`  | `check:compliance`, a suíte `test/compliance` com saída JUnit e `scripts/compliance/report.ts` | provas dedicadas das restrições do enunciado, da autenticação e das falhas eliminatórias, com a tabela de resultado no resumo da execução |
| `integration` | `test:integration`                                                                             | tudo contra PostgreSQL e SQS reais (testcontainers): repositórios, guardas do banco, HTTP, consumer, outbox                               |
| `concurrency` | `test:concurrency`                                                                             | os 12 cenários de concorrência (os 8 do desafio e 4 extras) com processos reais de cada serviço                                           |
| `e2e`         | `OTEL_ENABLED=true docker compose --profile observability up -d --build --wait` e `test:e2e`   | o Compose inteiro de pé com o perfil de observabilidade: Keycloak real, nginx, todas as réplicas, Prometheus, Grafana e Jaeger            |

O relatório de conformidade roda mesmo quando a suíte falha, para a tabela sempre aparecer, e o job fica vermelho se qualquer linha falhar. Os jobs com testcontainers terminam removendo os containers, mesmo quando falham. O `e2e` copia o `.env.example` para `.env`, mostra os logs do Compose quando algo falha e sempre termina com `docker compose --profile observability down -v`.

Recomendação: configure a branch protection da `main` exigindo os seis jobs antes do merge.
