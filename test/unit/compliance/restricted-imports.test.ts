import { describe, expect, it } from 'bun:test';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { restrictedImportBlocks } from '../../../eslint.config.js';

const linter = new Linter({ cwd: process.cwd(), configType: 'flat' });

const config: Linter.Config[] = [
  { files: ['**/*.ts'], languageOptions: { parser: tseslint.parser } },
  ...restrictedImportBlocks,
];

const restrictedImportMessages = (filePath: string, specifier: string) =>
  linter
    .verify(`import { value } from '${specifier}';\nexport { value };\n`, config, {
      filename: filePath,
    })
    .filter((message) => message.ruleId === 'no-restricted-imports');

const forbidden: [string, string][] = [
  ['src/domain/shared/money.ts', 'zod'],
  ['src/domain/shared/money.ts', 'node:crypto'],
  ['src/domain/shared/money.ts', '@application/ports/clock.port'],
  ['src/domain/shared/money.ts', '@infrastructure/system/system-clock'],
  ['src/domain/shared/money.ts', '../../application/ports/clock.port'],
  ['src/domain/money.ts', '../application/ports/clock.port'],
  ['src/domain/messaging/events/wallet-balance-changed.event.ts', '../../../bootstrap/api.module'],
  ['src/application/use-cases/create-wallet.use-case.ts', '@infrastructure/system/system-clock'],
  ['src/application/use-cases/create-wallet.use-case.ts', '@interfaces/http/auth.guard'],
  ['src/application/use-cases/create-wallet.use-case.ts', '@bootstrap/api.module'],
  [
    'src/application/use-cases/create-wallet.use-case.ts',
    '../../infrastructure/system/system-clock',
  ],
  ['src/application/use-cases/create-wallet.use-case.ts', '@mikro-orm/core'],
  ['src/application/use-cases/create-wallet.use-case.ts', '@aws-sdk/client-sqs'],
  ['src/application/use-cases/create-wallet.use-case.ts', '@nestjs/common'],
  ['src/application/use-cases/create-wallet.use-case.ts', 'zod'],
  ['src/application/use-cases/create-wallet.use-case.ts', 'pino'],
  ['src/application/use-cases/create-wallet.use-case.ts', 'nestjs-pino'],
  ['src/application/use-cases/create-wallet.use-case.ts', 'prom-client'],
  ['src/application/use-cases/create-wallet.use-case.ts', 'jose'],
  ['src/application/use-cases/create-wallet.use-case.ts', '@opentelemetry/api'],
  ['src/infrastructure/system/system-clock.ts', '@interfaces/http/auth.guard'],
  ['src/infrastructure/system/system-clock.ts', '@bootstrap/api.module'],
  ['src/infrastructure/system/system-clock.ts', '../../interfaces/http/auth.guard'],
  [
    'src/interfaces/http/controllers/wallets.controller.ts',
    '@infrastructure/messaging/sqs-event-publisher',
  ],
  ['src/bootstrap/api.module.ts', '@infrastructure/messaging/sqs-event-publisher'],
  [
    'src/application/use-cases/publish-outbox-batch.use-case.ts',
    '@infrastructure/messaging/sqs-event-publisher',
  ],
  ['src/infrastructure/messaging/sqs.client.ts', './sqs-event-publisher'],
  ['src/domain/shared/money.ts', '@infrastructure/messaging/sqs-event-publisher'],
];

const allowed: [string, string][] = [
  ['src/domain/shared/money.ts', '@domain/shared/currency'],
  ['src/domain/shared/money.ts', './currency'],
  ['src/domain/wallet/wallet.ts', '../shared/money'],
  ['src/domain/messaging/events/wallet-balance-changed.event.ts', '../../shared/money'],
  ['src/application/use-cases/create-wallet.use-case.ts', '@domain/wallet/wallet'],
  ['src/application/use-cases/create-wallet.use-case.ts', '@application/ports/clock.port'],
  ['src/application/use-cases/create-wallet.use-case.ts', '../../domain/wallet/wallet'],
  ['src/infrastructure/persistence/repositories/wallet.repository.ts', '@mikro-orm/core'],
  [
    'src/infrastructure/persistence/repositories/wallet.repository.ts',
    '@application/ports/clock.port',
  ],
  ['src/interfaces/http/controllers/wallets.controller.ts', '@nestjs/common'],
  ['src/interfaces/http/controllers/wallets.controller.ts', '@bootstrap/api.module'],
  [
    'src/interfaces/workers/outbox-publisher.worker.ts',
    '@infrastructure/messaging/sqs-event-publisher',
  ],
  ['src/bootstrap/outbox.module.ts', '@infrastructure/messaging/sqs-event-publisher'],
];

describe('no-restricted-imports layering', () => {
  it.each(forbidden)('rejects %s importing %s', (filePath, specifier) => {
    expect(restrictedImportMessages(filePath, specifier).length).toBeGreaterThan(0);
  });

  it.each(allowed)('accepts %s importing %s', (filePath, specifier) => {
    expect(restrictedImportMessages(filePath, specifier)).toHaveLength(0);
  });
});
