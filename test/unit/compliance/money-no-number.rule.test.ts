import { describe, it } from 'bun:test';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import moneyNoNumber from '../../../eslint-rules/money-no-number.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: {
      projectService: { allowDefaultProject: ['src/*/*.ts', 'src/*/*/*.ts', 'scripts/*.ts'] },
      tsconfigRootDir: process.cwd(),
    },
  },
});

const domainFile = 'src/domain/sample.ts';
const interfacesFile = 'src/interfaces/sample.ts';
const applicationFile = 'src/application/sample.ts';
const persistenceFile = 'src/infrastructure/persistence/sample.ts';
const messagingFile = 'src/infrastructure/messaging/sample.ts';
const scriptFile = 'scripts/sample.ts';

const numberMoney = (name: string) => ({ messageId: 'numberMoney', data: { name } });
const numberMoneyReturn = (name: string) => ({ messageId: 'numberMoneyReturn', data: { name } });
const forbiddenCall = (callee: string) => ({ messageId: 'forbiddenCall', data: { callee } });
const forbiddenConversion = (callee: string) => ({
  messageId: 'forbiddenConversion',
  data: { callee },
});

ruleTester.run('jungle/money-no-number', moneyNoNumber, {
  valid: [
    { code: 'export const imbalanced: number = 1;\n', filename: domainFile },
    { code: 'export const count: number = 1;\n', filename: domainFile },
    { code: 'export const initialBalance = 1n;\n', filename: domainFile },
    { code: 'export function amount(): bigint {\n  return 1n;\n}\n', filename: domainFile },
    { code: "export const item = { price: '1.00' };\n", filename: domainFile },
    { code: 'export const timeoutMs = Number(process.env.TIMEOUT);\n', filename: interfacesFile },
    { code: "export const port = parseInt('80', 10);\n", filename: messagingFile },
    { code: 'export const ratio = Math.round(1.5);\n', filename: scriptFile },
    { code: 'export const value = parseFloat("1.5");\n', filename: scriptFile },
  ],
  invalid: [
    {
      code: 'export const initialBalance: number = 1;\n',
      filename: domainFile,
      errors: [numberMoney('initialBalance')],
    },
    {
      code: 'export function amount(): number {\n  return 1;\n}\n',
      filename: domainFile,
      errors: [numberMoneyReturn('amount')],
    },
    {
      code: 'export const item = { price: 1 };\n',
      filename: domainFile,
      errors: [numberMoney('price')],
    },
    {
      code: 'export const item: { price: number } = { price: 1 };\n',
      filename: domainFile,
      errors: [numberMoney('price'), numberMoney('price')],
    },
    {
      code: 'export function credit(stake: number, totalPayout?: number): void {\n  void stake;\n  void totalPayout;\n}\n',
      filename: interfacesFile,
      errors: [numberMoney('stake'), numberMoney('totalPayout')],
    },
    {
      code: 'export interface Report {\n  difference: number;\n  totalGgr: number | null;\n}\n',
      filename: applicationFile,
      errors: [numberMoney('difference'), numberMoney('totalGgr')],
    },
    {
      code: 'export class Wallet {\n  constructor(private readonly money: number) {}\n  get balance(): number {\n    return this.money;\n  }\n}\n',
      filename: domainFile,
      errors: [numberMoney('money'), numberMoney('balance')],
    },
    {
      code: 'export const { MAX_AMOUNT } = { MAX_AMOUNT: 10 };\n',
      filename: scriptFile,
      errors: [numberMoney('MAX_AMOUNT'), numberMoney('MAX_AMOUNT')],
    },
    {
      code: 'export const computeAmount = (): number => 1;\n',
      filename: scriptFile,
      errors: [numberMoneyReturn('computeAmount')],
    },
    {
      code: "export const value = parseFloat('1.5');\n",
      filename: interfacesFile,
      errors: [forbiddenCall('parseFloat')],
    },
    {
      code: "export const value = Number.parseFloat('1.5');\n",
      filename: interfacesFile,
      errors: [forbiddenCall('Number.parseFloat')],
    },
    {
      code: 'export const value = (1.5).toFixed(2);\n',
      filename: interfacesFile,
      errors: [forbiddenCall('.toFixed')],
    },
    {
      code: 'export const value = (1.5).toPrecision(2);\n',
      filename: messagingFile,
      errors: [forbiddenCall('.toPrecision')],
    },
    {
      code: 'export const value = Math.round(1.5);\n',
      filename: interfacesFile,
      errors: [forbiddenCall('Math.round')],
    },
    {
      code: 'declare const types: { setTypeParser(oid: number, parse: (raw: string) => string): void };\ntypes.setTypeParser(1700, (raw) => raw);\n',
      filename: messagingFile,
      errors: [forbiddenCall('.setTypeParser')],
    },
    {
      code: "export const value = Number('1');\n",
      filename: domainFile,
      errors: [forbiddenConversion('Number')],
    },
    {
      code: "export const value = parseInt('1', 10);\n",
      filename: applicationFile,
      errors: [forbiddenConversion('parseInt')],
    },
    {
      code: "export const value = Number('1') + parseInt('1', 10) + Number.parseInt('1', 10);\n",
      filename: persistenceFile,
      errors: [
        forbiddenConversion('Number'),
        forbiddenConversion('parseInt'),
        forbiddenConversion('Number.parseInt'),
      ],
    },
  ],
});
