import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupEnv, teardownEnv, withWorker } from './harness';

beforeAll(setupEnv);
afterAll(teardownEnv);

describe('access code (DEMO_REQUIRE_CODE=1)', () => {
  beforeEach(() => { process.env.DEMO_REQUIRE_CODE = '1'; process.env.DEMO_ACCESS_CODE = '482913'; });
  afterEach(() => { delete process.env.DEMO_REQUIRE_CODE; delete process.env.DEMO_ACCESS_CODE; });
  it('needs the code to log in and on every request', async () => {
    await withWorker({}, async (ctx) => {
      expect((await ctx.api('', 'GET', '/health')).body).toMatchObject({ ok: true, codeRequired: true });
      expect((await ctx.api('', 'POST', '/session', {})).status).toBe(401);
      expect((await ctx.api('', 'POST', '/session', { code: '000000' })).status).toBe(401);
      expect((await ctx.api('', 'POST', '/session', { code: '482913' })).status).toBe(200);
      expect((await ctx.api('professor', 'GET', '/quotes')).status).toBe(401);
      expect((await ctx.api('professor', 'GET', '/quotes', undefined, { 'x-demo-code': '482913' })).status).toBe(200);
    });
  });
  it('locks an address after ten wrong codes', async () => {
    await withWorker({}, async (ctx) => {
      for (let i = 0; i < 10; i++) await ctx.api('', 'POST', '/session', { code: '111111' });
      expect((await ctx.api('', 'POST', '/session', { code: '482913' })).status).toBe(429);
    });
  });
});
