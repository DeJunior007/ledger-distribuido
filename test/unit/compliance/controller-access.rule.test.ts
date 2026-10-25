import { describe, it } from 'bun:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import controllerAccess from '../../../eslint-rules/controller-access.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it;

const ruleTester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

const walletsController = 'src/interfaces/http/controllers/wallets.controller.ts';
const healthController = 'src/interfaces/health/health.controller.ts';
const metricsController = 'src/interfaces/health/metrics.controller.ts';

const missingAccess = (name: string) => ({ messageId: 'missingAccess', data: { name } });
const publicNotAllowed = { messageId: 'publicNotAllowed' };

ruleTester.run('jungle/controller-access', controllerAccess, {
  valid: [
    {
      code: "export class WalletsController {\n  @Get(':id')\n  @Roles('provider')\n  find(): void {}\n\n  @Post()\n  @Roles('admin', 'provider')\n  create(): void {}\n\n  helper(): void {}\n}\n",
      filename: walletsController,
    },
    {
      code: "export class HealthController {\n  @Get('live')\n  @Public()\n  live(): void {}\n}\n",
      filename: healthController,
    },
    {
      code: "export class MetricsController {\n  @Get('metrics')\n  @Public()\n  metrics(): void {}\n}\n",
      filename: metricsController,
    },
  ],
  invalid: [
    {
      code: "export class WalletsController {\n  @Get(':id')\n  find(): void {}\n\n  @Post()\n  create(): void {}\n\n  @Put(':id')\n  replace(): void {}\n\n  @Patch(':id')\n  update(): void {}\n\n  @Delete(':id')\n  remove(): void {}\n}\n",
      filename: walletsController,
      errors: [
        missingAccess('find'),
        missingAccess('create'),
        missingAccess('replace'),
        missingAccess('update'),
        missingAccess('remove'),
      ],
    },
    {
      code: "export class WalletsController {\n  @Get(':id')\n  @Public()\n  find(): void {}\n}\n",
      filename: walletsController,
      errors: [publicNotAllowed],
    },
    {
      code: "@Public()\nexport class WalletsController {\n  @Get(':id')\n  find(): void {}\n}\n",
      filename: walletsController,
      errors: [publicNotAllowed, missingAccess('find')],
    },
    {
      code: "export class HealthController {\n  @Get('live')\n  live(): void {}\n}\n",
      filename: healthController,
      errors: [missingAccess('live')],
    },
  ],
});
