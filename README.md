# Dhruva Quote Desk: backend

**Live demo:** https://donnetta-regainable-nonmetallurgically.ngrok-free.dev (sign in with the six-digit access code sent by email). Walkthrough: [docs/PROFESSOR.md](docs/PROFESSOR.md). Server setup: `NGROK_URL=<your ngrok domain> bash scripts/deploy/setup-server.sh`; model, API key and access code go in `/etc/dhruva/ai.env` on the server (never in git).

Each request for quotation (RFQ) is one durable Temporal workflow, from the customer's first message to an order, a loss or an expiry. Five narrow AI agents do the reading and writing, and every output cites the code-built facts it used (section 14 of the design). Fixed code decides price, stock and sending. People approve through signals. The build contract is `docs/DESIGN.md`; the approved screens are `../quote-agent-mockup.html`; the web app is in `web/`. A step-by-step guide for reviewers, with no API key needed, is `docs/PROFESSOR.md`.

## Agents (`src/agents/`, prompts in `prompts.ts`)

| Agent | Module | Sees | Returns | If it fails |
|---|---|---|---|---|
| Intake | `intake.ts` | the request text, any question and reply, catalogue matches (read-only tool) | part, quantity, firm, account, asked price and reason, date, place | empty fields after 3 tries; the customer is asked |
| Clarification | `clarification.ts` | reason, own account name, catalogue options, quantity | one question | code template |
| Finance referral | `finance-referral.ts` | price facts from code | summary and considerations (no price or decision field) | code summary from the facts |
| Decline reader | `decline-reader.ts` | the reply and the quote's item, quantity, date | accept / decline / question, loss reason, evidence | `question` (Sales reads it) |
| Claim evidence | `evidence.ts` | the request's item, quantity, date and an attached rival quote, as sentences | up to 3 cited findings with exact quotes (never a verdict) | no findings; code signals alone set the alert level |

Agents see a numbered fact list and cite fact ids; `grounding.ts` verifies every call (cites exist, numbers and quotes come from cited facts, no verdicts, no prompt leaks) and falls back to code templates. Finance text is also refused if it judges ("late", "many", "good"), predicts, recommends or approves, mentions a rival or the buyer's claim, spells a number in words, or makes a comparison without stating both cited figures (or one the figures do not bear out). Every prompt carries a canary and a never-reveal rule; a leak in any output is replaced by the template and audited.

Every post-check is in `guardrails.ts`. Agents never set a price, reserve or release stock, or send anything: prices come from `domain.ts`, stock and sending from store transactions in `store.ts`.

## Money rules

- Per item: minimum margin 16% (a Sales rep can quote down to it, with a reason; code never grants a buyer's asked price above it, the quote is the contract or trade price; nothing above the contract price) and max discount 10% (only Finance can approve down to it; nothing below). The rep never sees the max-discount price or percentage, in any view, the audit trail included. Finance approval is rechecked and the quote goes out automatically. A Finance-approved price is single-use: it is never served again as a cached price.
- Stock: available = on hand − held − ordered; holds are conditional updates; a count backs a firm date only if it is at most 5 minutes old; holds last 10 minutes; everything is rechecked at send; only Inventory clears an old count. Short stock offers split or full delivery against the incoming PO.
- Win rate at a price: a 90% range from past quotes of the same part group within ±5%, last 12 months (under 20 quotes: not enough data); expected gross profit = profit × win rate. Nothing below cost unless the item is clearance. New customers (fewer than 3 paid orders) get a discount only on ₹10 lakh orders or a rep's yearly commitment. Finance cites the facts behind each decision (at least one win-rate, history or policy fact with a value; never the buyer's stated reason) and has 4 business hours. After that the rep may approve or reject the price on the case, nothing else, except on claim quotes and frozen groups, which keep the standing price. Item 16 is checked again at the deadline and at the rep's decision, so a claim or freeze that arrives during the wait counts. A Sales price change carries the rep's reason to Finance, and a yearly commitment must be at least the order quantity.
- One price to customers, no bargaining: counters get "We can't change this price. Our offer stands at ₹X." and the names of the trades that change a price (larger quantity, later date, faster payment), with no figures; a trade is a new request, priced by code from a published table (`TRADES`), and a buyer who never counters keeps stock priority; identical asks get the same price; 3 counters, re-quotes, reopens or prompt-leak attempts in 7 days freeze a buyer group's discounts (a probe sentence counts once per RFQ). Accounts sharing a GSTIN, PAN, bank account, delivery address or mail domain are one buyer group for freezes, probe counts, hold limits and the new-customer rule. Every request that names a price gets the same acknowledgement and the same API status (`pending_approval`, no price) whatever its band, so the minimum and the floor cannot be found by asking. A refusal names only the standing price. Rival prices are unverified claims, read from structured fields or from any customer text (request, replies, declines), with a code-computed alert that Finance marks Correct or Wrong; Dhruva never contacts the rival. A sent price is locked: lowering it goes to Finance.
- Holds per buyer group: 3 open requests, 2,000 units, ₹20 lakh; halved by repeated expiries; none for a group behind on payment or with a confirmed fake. Past the limit the quote goes out indicative.
- Each discount stores its condition (quantity, payment days, commitment, order value). A broken one raises a debit note for Finance: late payment, a commitment shortfall (10% off the rep's commission), or a partial cancel (the rest is repriced). Finance sees a per-rep report (discount rate, revisions to Finance, phone share, margin against peers).
- Nothing internal reaches a customer: every outbound message and every Sales question is scanned (`outboundProblem` in `guardrails.ts`) for internal words and for figures that are not the quote's own; a failing Sales question gets 422 `INTERNAL_INFO`. A delivery place must be a place name, or it is dropped.
- AI cost (section 13): every agent call records tokens and rupees; every quote shows AI ₹, compute ₹, total ₹ and the share of its gross margin. Hard cap 40,000 tokens per RFQ, then Sales takes over. Orders under ₹10,000 take the cheap path (cheapest model, the contract price or the sent price whatever the customer asks, at most one template question, no Finance referral).

## Roles (`x-demo-user` header, demo only)

`sales`, `finance`, `inventory`, `customer:<ACCOUNT>`, `professor` (everything). `POST /session` with `{}` or `{ "code": "DHRUVA-DEMO" }` signs in as professor.

## Endpoints (`src/api.ts`, port 3000)

`POST/GET /session` · `GET /quotes`, `GET /quotes/:rfqId`, `POST /quotes/:rfqId/actions`, `POST /phone-calls` · `GET /finance/queue`, `POST /finance/:rfqId/decision`, `GET /customers/:account/history` · `GET /inventory`, `GET /inventory/reservations`, `POST /inventory/:item/confirm`, `POST /inventory/:item/refresh` · `GET/POST /customer/:account/messages`, `POST /v1/rfq`, `GET /v1/rfq/:rfqId`, `POST /v1/quotes/:ref/accept|decline` · `GET /audit/:rfqId` (with usage and AI calls) · `GET /usage`, `GET /usage/:rfqId` · `GET /agents` (staff only) · `GET /quotes/:rfqId/win-rate?price=` · `GET /claims`, `GET /alerts/metrics`, `POST /alerts/:id/review`, `POST /claims/:id/verify` · `GET/POST /customers/:account/commitments`, `POST /customers/:account/commitments/:id/settle`, `GET /customers/:account/group` · `GET /orders`, `POST /orders/:ref/payment`, `POST /orders/:ref/cancel`, `GET /finance/debit-notes`, `GET /finance/reps` · `POST /v1/quotes/:ref/counter` · `GET /settings`, `POST /settings/clock/advance`, `PUT /settings/stale-stock`, `POST /settings/test-requests/:id/load`, `POST /settings/reset` · `GET /queue` · `GET /health`.

## Run

```
temporal server start-dev --headless                 # or --db-filename temporal.db to keep history
QUOTE_MODEL=mock pnpm dev                            # worker + API in one process, no API key
# or two processes sharing quote-agent.db:  QUOTE_MODEL=mock pnpm worker   and   pnpm api
pnpm --filter web dev                                # frontend on :5173
```

Environment: `PORT` (API, 3000), `TEMPORAL_ADDRESS` (`localhost:7233`), `QUOTE_DB` (`quote-agent.db`), `WEB_ORIGIN` (allowed browser origins, comma-separated; default the Vite dev server on 5173), `DEMO_ACCESS_CODE` (`DHRUVA-DEMO`), `DEMO_REQUIRE_CODE=1` (hosted demo: login needs the code and every API request must send it in `x-demo-code`; 10 wrong codes lock an address for 15 minutes), `RESET_ON_BOOT`, `API_URL` (for `pnpm demo`). Web: `VITE_API_URL` (default `http://localhost:3000`), `VITE_MOCK=1` (in-browser mock API, no backend).

`STAGE=prod` refuses the demo login (503). Models: `STAGE=dev` (default) uses the open-weight model `local:qwen3:8b` (`LOCAL_BASE_URL`, e.g. Ollama); `STAGE=prerelease|prod` uses `openai:gpt-5-mini` (`OPENAI_API_KEY`). `QUOTE_MODEL` overrides; `INTAKE_MODEL`, `CLARIFY_MODEL`, `FINANCE_MODEL`, `DECLINE_MODEL`, `EVIDENCE_MODEL`, `SMALL_ORDER_MODEL` override per agent; `CHEAP_MODEL` adds a candidate for the cheap path; `SHIP_MODEL` and `OPEN_WEIGHT_MODEL` rename the stage defaults; `LOCAL_API_KEY` for the local server. Prices: `AI_PRICE_SHIP_INR_PER_M` (410), `AI_PRICE_OPEN_INR_PER_M` (25), `AI_PRICE_MOCK_INR_PER_M` (0), `AI_PRICE_TABLE`, `COMPUTE_INR_PER_RFQ` (1), `ACTIONS_PER_RFQ` (40). The API resets the demo on first boot (`RESET_ON_BOOT=1` forces it). `pnpm demo …` is a small CLI (see `scripts/demo.ts`).

## Tests

`pnpm typecheck && pnpm test`. No server or key needed: `TestWorkflowEnvironment` with time skipping, the deterministic demo model, and AI SDK `MockLanguageModelV4` for the red-team cases. Covered: price bands, Finance approve and reject, short stock split and full, accept, decline, late accept, reopen, old count, hold expiry, clock signal, all 20 red-team cases of DESIGN 7.4, roles, CORS, `GET /agents`, the reset state, the AI budget (cap, small orders, cost math), the citation verifier, the buyer-side red team (`test/redteam.test.ts`: fake rival quotes, probing bots, shared-GSTIN groups, prompt-leak attempts, Finance deadline, price lock), the round-4 abuse cases (`test/abuse.test.ts`: no bargaining and trades, L2, linked accounts, hold limits, clawbacks, the rep report), and the review fixes (`test/fixes.test.ts`: uniform buyer status, single-use approvals, claims and freezes during the Finance wait, rival claims in free text, forged delivery text, Sales questions that coach the buyer, the floor absent from every Sales response, long rival documents, refusals and closing).

Shortcuts: the demo login is not real authentication; no real model runs in CI.
