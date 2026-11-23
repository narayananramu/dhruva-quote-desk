// Tiny CLI over the HTTP API. Start `pnpm worker` and `pnpm api` (or `pnpm dev`) first.
//   pnpm demo reset                                   reset the demo (three seeded quotes)
//   pnpm demo quotes                                  Sales list
//   pnpm demo quote RFQ-8841                          one quote (stage, actions, usage)
//   pnpm demo act RFQ-8841 '{"type":"send","draftVersion":1}'
//   pnpm demo finance RFQ-8840 '{"action":"approve","unitPrice":900,"reason":"competitor match"}'
//   pnpm demo inbox ACC-104                           customer messages
//   pnpm demo reply ACC-104 <messageId> "We accept."  customer replies to a message
//   pnpm demo advance 11                              move the demo clock
//   pnpm demo usage [RFQ-8841]                        AI and compute cost in rupees
const base = process.env.API_URL ?? 'http://localhost:3000';
const call = async (user: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { 'x-demo-user': user, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};
const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));
const [cmd, a, b, c] = process.argv.slice(2);

switch (cmd) {
  case 'reset':
    show(await call('professor', 'POST', '/settings/reset'));
    break;
  case 'quotes':
    show(await call('sales', 'GET', '/quotes'));
    break;
  case 'quote':
    show(await call('sales', 'GET', `/quotes/${a}`));
    break;
  case 'act':
    show(await call('sales', 'POST', `/quotes/${a}/actions`, JSON.parse(b ?? '{}')));
    break;
  case 'finance':
    show(await call('finance', 'POST', `/finance/${a}/decision`, JSON.parse(b ?? '{}')));
    break;
  case 'inbox':
    show(await call(`customer:${a}`, 'GET', `/customer/${a}/messages`));
    break;
  case 'reply':
    show(await call(`customer:${a}`, 'POST', `/customer/${a}/messages`, { channel: 'mail', replyTo: b, text: c }));
    break;
  case 'advance':
    show(await call('professor', 'POST', '/settings/clock/advance', { minutes: Number(a) }));
    break;
  case 'usage':
    show(await call('finance', 'GET', a ? `/usage/${a}` : '/usage'));
    break;
  default:
    console.log('see the usage comment at the top of scripts/demo.ts');
}
export {};
