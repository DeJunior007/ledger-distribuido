import { beforeAll, describe, expect, it } from 'bun:test';
import { FailureCode } from '@domain/shared/failure-code';
import { PROBLEM_CONTENT_TYPE, problemBodyOf } from '@interfaces/http/http-status';
import { RETRY_AFTER_LONG_SECONDS } from '@interfaces/http/problem-details.filter';

interface ErrorPageCase {
  readonly status: number;
  readonly failureCode: FailureCode;
  readonly retryAfter: boolean;
}

const ERROR_PAGE_CASES: readonly ErrorPageCase[] = [
  { status: 413, failureCode: FailureCode.InvalidPayload, retryAfter: false },
  { status: 502, failureCode: FailureCode.InfrastructureUnavailable, retryAfter: true },
  { status: 503, failureCode: FailureCode.InfrastructureUnavailable, retryAfter: true },
  { status: 504, failureCode: FailureCode.InfrastructureUnavailable, retryAfter: true },
];

let conf: string;

const errorPageTarget = (status: number): string | undefined =>
  new RegExp(`error_page\\s+${String(status)}\\s+(@[a-z0-9_]+);`).exec(conf)?.[1];

const locationBlock = (name: string): string | undefined =>
  new RegExp(`location\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`).exec(conf)?.[1];

const returnedBody = (block: string, status: number): unknown => {
  const match = new RegExp(`return\\s+${String(status)}\\s+'([^']*)';`).exec(block);
  expect(match?.[1]).toBeDefined();
  return JSON.parse(match?.[1] ?? 'null');
};

beforeAll(async () => {
  conf = await Bun.file('infra/nginx/nginx.conf').text();
});

describe('nginx error pages', () => {
  for (const errorCase of ERROR_PAGE_CASES) {
    it(`answers ${String(errorCase.status)} with the api problem body`, () => {
      const target = errorPageTarget(errorCase.status);
      expect(target).toBeDefined();
      const block = locationBlock(target ?? '@missing');
      expect(block).toBeDefined();
      const content = block ?? '';
      expect(content).toContain(`default_type ${PROBLEM_CONTENT_TYPE};`);
      expect(returnedBody(content, errorCase.status)).toEqual({
        ...problemBodyOf(errorCase.failureCode),
        status: errorCase.status,
      });
      const retryAfter = `add_header Retry-After ${String(RETRY_AFTER_LONG_SECONDS)} always;`;
      if (errorCase.retryAfter) {
        expect(content).toContain(retryAfter);
      } else {
        expect(content).not.toContain('Retry-After');
      }
    });
  }

  it('leaves the problem bodies of the api untouched', () => {
    expect(conf).not.toContain('proxy_intercept_errors');
  });
});
