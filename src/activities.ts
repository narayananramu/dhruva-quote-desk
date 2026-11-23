import { ApplicationFailure, WorkflowExecutionAlreadyStartedError, type Client } from '@temporalio/client';
import { runClarificationAgent } from './agents/clarification';
import { runDeclineReader, type DeclineInput } from './agents/decline-reader';
import { runEvidenceAgent } from './agents/evidence';
import { referralFrom, runFinanceReferralAgent, type FinanceReferral } from './agents/finance-referral';
import { financeFactList, templateFinanceCase, type ClaimFactInput } from './agents/grounding';
import { cutCustomerText, outboundProblem, templateQuestion, type ClarificationInput, type DeclineOutput, type OutboundRules } from './agents/guardrails';
import { runIntakeAgent } from './agents/intake';
import { AGENT_PROMPTS, type AgentId, type PriceReason } from './agents/prompts';
import type { AgentMeta, CallUsage } from './agents/types';
import { ALERT_THRESHOLDS, alertLevel, claimSignals, promptProbe, withFindings, type AlertLevel } from './claims';
import { BUDGET, TRADES } from './config';
import type { DeliveryOffer, DeliveryOption } from './contract';
import {
  buildOffer,
  discountRule,
  evaluate,
  istDate,
  namesOtherAccount,
  stockDeliveryDate,
  type Evaluation,
  type FinanceApproval,
  financeFacts,
  type PriceFacts,
  type RfqRequest,
  type TradeInputs,
} from './domain';
import { acceptOnHold, ackFinance, ackShort, ackStock, counterReply, lostAck, messageText, priceRefused, questionMessage, quoteExpired, type Outbound, type QuestionTopic, type ShortFacts } from './messages';
import { createHash } from 'node:crypto';
import { modelLabel, type AgentModels } from './models';
import type { QueueEntry } from './queue';
import type { QuoteState } from './state';
import type { HoldResult, IssueArgs, IssueResult, Provenance, Store } from './store';
import { callCostInr, costConfig, pricePerM, type CostConfig } from './usage';

export interface ActivityDeps {
  store: Store;
  models: AgentModels;
  costs?: CostConfig;
  /** Where to mirror review-queue updates. Optional so activities can be unit-tested alone. */
  queue?: { client: Client; workflowId: string; taskQueue: string };
}

export interface Totals {
  calls: number;
  input: number;
  output: number;
  reasoning: number;
  aiInr: number;
}

/** What every agent activity returns besides its output: provenance and the RFQ's running AI totals. */
export interface AgentStep<T> {
  output: T;
  meta: AgentMeta;
  totals: Totals;
}

export type Notice =
  | { kind: 'question'; topic: QuestionTopic; text: string; by: Provenance }
  | { kind: 'ack_stock'; quantity: number; item: string }
  | { kind: 'ack_finance'; quantity: number; item: string }
  | { kind: 'ack_short'; facts: ShortFacts }
  | { kind: 'price_refused'; itemCode: string; unitPrice: number; quantity: number }
  | { kind: 'quote_expired'; quoteRef: string; validUntil: number }
  | { kind: 'lost_ack'; quoteRef: string; poArrivesOn: string | null }
  | { kind: 'counter_reply'; quoteRef: string; unitPrice: number }
  | { kind: 'accept_on_hold'; quoteRef: string };

export interface ClaimArgs {
  rival: string | null;
  rivalGstin: string | null;
  claimedPrice: number | null;
  attachmentText: string | null;
  source: 'rfq_text' | 'reply_text' | 'api' | 'attachment';
}

export interface StockCheck {
  itemCode: string;
  available: number;
  enough: boolean;
  offer: DeliveryOffer | null;
  options: DeliveryOption[];
  stockDate: string;
}

/**
 * All I/O lives here: the four agents, the rules, the store. The workflow passes `now` (its demo
 * clock), so time-skipping tests and the Settings clock control every time check.
 */
export function createActivities({ store, models, costs = costConfig(), queue }: ActivityDeps) {
  function caller(code: string) {
    const c = store.account(code);
    if (!c) throw ApplicationFailure.nonRetryable(`unknown account ${code}`);
    return c;
  }

  /** Records one model call (success or failure) with its rupee cost. */
  function sink(rfqId: string, agent: AgentId, model: string, now: number) {
    const rate = pricePerM(costs, model);
    return (u: CallUsage, ok: boolean) =>
      store.recordAiCall({
        rfqId,
        at: now,
        agent,
        model,
        promptVersion: AGENT_PROMPTS[agent].promptVersion,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        reasoningTokens: u.reasoningTokens,
        inrPerM: rate,
        inr: callCostInr(u.inputTokens, u.outputTokens, rate),
        ok,
      });
  }

  /**
   * Section 13: tokens left in the RFQ's budget, or null once it is used up. Checked before every
   * model call, so Temporal retries of a failing agent cannot run past the cap: at most the one call
   * that crossed it is spent. The rest is also each call's output limit.
   */
  function budgetLeft(rfqId: string): number | null {
    const t = store.aiTotals(rfqId);
    const left = BUDGET.tokenCapPerRfq - (t.input + t.output);
    return left > 0 ? left : null;
  }
  const budgetUsedUp = () => ApplicationFailure.nonRetryable('AI budget for this request is used up', 'AI_BUDGET');

  /**
   * P1: an output that repeated a canary or prompt words was replaced by code; a customer text that
   * asks for the agents' instructions is data. Both are audited and count toward the group's probing
   * score, once per text: an intake run that reads the same request again does not count it again.
   */
  function promptEvents(rfqId: string, account: string, agent: string, meta: AgentMeta | null, texts: string[], now: number) {
    const key = (kind: string, t: string) => `${kind}:${createHash('sha256').update(t).digest('hex').slice(0, 16)}`;
    if (meta?.promptLeak) {
      store.audit(now, rfqId, 'prompt_leak_attempt', { agent, leaked: meta.promptLeak, action: 'template fallback' }, { actor: 'rules' });
      store.recordProbe(account, rfqId, 'prompt_leak', key(`leak-${agent}`, texts.join('\n')), now);
    }
    for (const text of texts) {
      const probe = promptProbe(text);
      if (!probe) continue;
      const before = store.probeCounts(store.groupOf(account), now).prompt_leak;
      const after = store.recordProbe(account, rfqId, 'prompt_leak', key('ask', text), now).counts.prompt_leak;
      if (after > before) store.audit(now, rfqId, 'prompt_probe', { agent, phrase: probe.phrase.slice(0, 80), encoded: probe.encoded, action: 'treated as data' }, { actor: 'rules' });
    }
  }

  /** The outbound scan (DECISIONS 11) on a message about to go to a customer. A failing message is replaced by a fixed notice and audited. */
  function checked(rfqId: string, account: string, m: Outbound, rules: OutboundRules, now: number): Outbound {
    const bad = outboundProblem(messageText(m), { ...rules, otherAccountNames: store.otherAccountNames(account) });
    if (!bad) return m;
    store.audit(now, rfqId, 'outbound_blocked', { kind: m.kind, problem: bad, action: 'fixed notice sent' }, { actor: 'rules' });
    const t = 'Our sales team will reply to your request shortly.';
    return { kind: m.kind, mail: m.mail ? { ...m.mail, paragraphs: [t], rows: [] } : null, chat: t, text: t };
  }

  /** The Finance case facts: prices, win rates and expected profit at both prices, customer facts, the rule. */
  function financeCaseFacts(account: string, price: PriceFacts, requestedBy: 'customer' | 'sales', priceReason: PriceReason | null, now: number) {
    const item = store.item(price.itemCode);
    const group = item?.partGroup ?? 'general';
    const life = store.lifetime(account);
    return financeFacts(caller(account).name, price, requestedBy, priceReason, {
      atRequested: store.winRate(group, price.target, price.contractPrice, now),
      atContract: store.winRate(group, price.contractPrice, price.contractPrice, now),
      customer: store.customerFacts(account),
      rule: discountRule(life.paidOrders, price.target * price.quantity, store.hasCommitment(account, price.itemCode, now)),
    });
  }

  return {
    // ---- Agents ----

    /** Agent 1: free text to fields, with the read-only catalogue tool. Throws on failure (Temporal retries). */
    async intakeAgent(
      rfqId: string,
      a: { text: string; clarifications: { question: string; reply: string }[]; small: boolean; account?: string },
      now: number,
    ): Promise<AgentStep<RfqRequest>> {
      const left = budgetLeft(rfqId);
      if (left === null) throw budgetUsedUp();
      const model = a.small ? models.smallOrderIntake : models.intake;
      const label = modelLabel(model);
      const cut = cutCustomerText(a.text);
      if (cut.truncated) store.audit(now, rfqId, 'input_truncated', { agent: 'intake', originalChars: cut.originalChars, keptChars: cut.text.length });
      const clar = a.clarifications.map((c) => ({ question: c.question, reply: cutCustomerText(c.reply).text }));
      const r = await runIntakeAgent(
        model,
        { today: istDate(now), request: cut.text, clarifications: clar },
        { findParts: (q) => store.findParts(q, q), exactPart: (pn) => store.exactPart(pn) },
        sink(rfqId, 'intake', label, now),
        left,
      );
      store.audit(now, rfqId, 'extracted', { ...r.output, cites: r.meta.cites ?? {}, ...(r.meta.problem && { postCheck: r.meta.problem }), smallOrder: a.small }, r.meta);
      if (a.account) promptEvents(rfqId, a.account, 'intake', r.meta, [cut.text, ...clar.map((c) => c.reply)], now);
      return { output: r.output, meta: stripFacts(r.meta), totals: store.aiTotals(rfqId) };
    },

    /** Agent 2: one question to the customer. `template` skips the model (small order). */
    async clarificationAgent(rfqId: string, account: string, input: Omit<ClarificationInput, 'ownAccountName'>, template: boolean, now: number): Promise<AgentStep<{ question: string }>> {
      const full: ClarificationInput = { ...input, ownAccountName: caller(account).name };
      const left = template ? null : budgetLeft(rfqId);
      if (template || left === null) {
        const meta: AgentMeta = { actor: 'code', model: 'template', promptVersion: 'template', fallback: true, problem: template ? 'SMALL_ORDER' : 'AI_BUDGET' };
        const question = templateQuestion(full);
        store.audit(now, rfqId, 'clarification_asked', { reason: input.reason, question, template: true });
        return { output: { question }, meta, totals: store.aiTotals(rfqId) };
      }
      const label = modelLabel(models.clarification);
      const r = await runClarificationAgent(models.clarification, full, store.otherAccountNames(account), sink(rfqId, 'clarify', label, now), left);
      store.audit(now, rfqId, 'clarification_asked', { reason: input.reason, question: r.output.question, cites: r.meta.cites ?? {}, fallback: r.meta.fallback ?? false, problem: r.meta.problem ?? null }, r.meta);
      promptEvents(rfqId, account, 'clarify', r.meta, [], now);
      return { output: r.output, meta: stripFacts(r.meta), totals: store.aiTotals(rfqId) };
    },

    /**
     * Agent 3: drafts the Finance case from facts built here by code: prices, win rate and expected
     * gross profit ranges, the customer's lifetime figures, the new-customer rule, and any buyer
     * claims as X facts. `template` skips the model (AI budget used up); `seeded` writes the case
     * from the facts with no model call (seeded workflow).
     */
    async financeReferralAgent(
      rfqId: string,
      account: string,
      price: PriceFacts,
      requestedBy: 'customer' | 'sales',
      priceReason: PriceReason | null,
      seeded: boolean,
      template: boolean,
      now: number,
    ): Promise<AgentStep<FinanceReferral>> {
      const facts = financeCaseFacts(account, price, requestedBy, priceReason, now);
      const claims: ClaimFactInput[] = store.claims({ rfqId }).map((c) => ({ rival: c.rival, rivalPrice: c.claimedPrice, status: c.status }));
      if (seeded || template) {
        const factList = financeFactList(facts, claims);
        const output = referralFrom(facts, factList, templateFinanceCase(factList));
        const meta: AgentMeta = seeded
          ? { actor: AGENT_PROMPTS.finance.actor, model: 'seed', promptVersion: AGENT_PROMPTS.finance.promptVersion }
          : { actor: 'code', model: 'template', promptVersion: 'template', fallback: true, problem: 'AI_BUDGET' };
        store.audit(now, rfqId, 'finance_referral', { dataStatus: output.dataStatus, missing: output.missing, summary: output.summary, factList: output.factList, ...(seeded ? { seeded: true } : { template: true }) }, meta);
        return { output, meta, totals: store.aiTotals(rfqId) };
      }
      const left = budgetLeft(rfqId);
      if (left === null) return this.financeReferralAgent(rfqId, account, price, requestedBy, priceReason, false, true, now);
      const label = modelLabel(models.financeReferral);
      const r = await runFinanceReferralAgent(models.financeReferral, facts, claims, sink(rfqId, 'finance', label, now), left);
      store.audit(
        now,
        rfqId,
        'finance_referral',
        { dataStatus: r.output.dataStatus, missing: r.output.missing, summary: r.output.summary, considerations: r.output.considerations, factList: r.output.factList, fallback: r.meta.fallback ?? false, problem: r.meta.problem ?? null },
        r.meta,
      );
      promptEvents(rfqId, account, 'finance', r.meta, [], now);
      return { output: r.output, meta: stripFacts(r.meta), totals: store.aiTotals(rfqId) };
    },

    /** Agent 4: reads a reply to a sent quote. Throws on failure; the workflow falls back to `question`. */
    async declineReader(rfqId: string, input: DeclineInput, now: number, account?: string): Promise<AgentStep<DeclineOutput>> {
      const left = budgetLeft(rfqId);
      if (left === null) throw budgetUsedUp();
      const cut = cutCustomerText(input.reply);
      if (cut.truncated) store.audit(now, rfqId, 'input_truncated', { agent: 'decline', originalChars: cut.originalChars, keptChars: cut.text.length });
      const label = modelLabel(models.declineReader);
      const r = await runDeclineReader(models.declineReader, { quote: input.quote, reply: cut.text }, sink(rfqId, 'decline', label, now), left);
      store.audit(now, rfqId, 'reply_read', { ...r.output, cites: r.meta.cites ?? {}, gated: !!r.meta.problem?.includes('gated'), problem: r.meta.problem ?? null }, r.meta);
      if (account) promptEvents(rfqId, account, 'decline', r.meta, [cut.text], now);
      return { output: r.output, meta: stripFacts(r.meta), totals: store.aiTotals(rfqId) };
    },

    /**
     * A buyer's claim (a rival price, a rival's document). Recorded as unverified; code computes the
     * signals and the level; the optional evidence agent can only add one cited weak reason. Nothing
     * here reads or changes a price: the caller's reply to the customer is the same at every level.
     */
    async recordClaim(rfqId: string, account: string, c: ClaimArgs, rfq: { itemCode: string | null; quantity: number | null; deliverBy: string | null }, now: number): Promise<{ claimId: string; alertId: string; level: AlertLevel }> {
      const item = rfq.itemCode ? store.item(rfq.itemCode) : undefined;
      const partGroup = item?.partGroup ?? 'general';
      // Code signals read the whole document (up to the 20,000 characters the API accepts); only the
      // evidence agent gets the cut text. Padding cannot push an instruction past the signals.
      const full = c.attachmentText ? c.attachmentText.slice(0, 20_000) : null;
      const cut = full ? cutCustomerText(full) : null;
      if (cut?.truncated) store.audit(now, rfqId, 'input_truncated', { agent: 'evidence', originalChars: cut.originalChars, keptChars: cut.text.length, note: 'code signals read the full document' }, { actor: 'rules' });
      const ctx = {
        unitCost: item?.unitCost ?? 0,
        lowestPastPrice: item ? store.lowestPastPrice(partGroup, item.itemCode, now) : null,
        competitors: store.competitors(partGroup),
        rfq: { itemCode: rfq.itemCode, quantity: rfq.quantity },
        groupConfirmedFakes: store.group(store.groupOf(account))?.confirmedFakes ?? 0,
      };
      let signals = claimSignals({ ...c, attachmentText: full }, ctx);
      let findings: { text: string; quote: string; cites: string[] }[] = [];
      const left = cut ? budgetLeft(rfqId) : null;
      if (cut && left !== null) {
        const label = modelLabel(models.evidence);
        const r = await runEvidenceAgent(models.evidence, { rfq, attachment: cut.text }, sink(rfqId, 'evidence', label, now), left);
        findings = r.output.findings;
        store.audit(now, rfqId, 'evidence_read', { findings, dropped: r.output.dropped, problem: r.meta.problem ?? null }, r.meta);
        signals = withFindings(signals, findings);
        promptEvents(rfqId, account, 'evidence', r.meta, [full!], now);
      }
      const level = alertLevel(signals);
      const ids = store.addClaim({ rfqId, account, rival: c.rival, rivalGstin: c.rivalGstin, claimedPrice: c.claimedPrice, attachmentText: full, source: c.source }, { level, signals, findings, thresholdVersion: ALERT_THRESHOLDS.version }, now);
      return { ...ids, level };
    },

    /**
     * A counter-offer on a sent quote: counted per buyer group, answered with the uniform reply that
     * restates the offered price. Never changes the price. Returns whether the group is now frozen.
     */
    async counter(rfqId: string, account: string, quoteRef: string, unitPrice: number, itemCode: string, now: number): Promise<{ frozen: boolean; newlyFrozen: boolean }> {
      const p = store.recordProbe(account, rfqId, 'counter', itemCode, now);
      const m = checked(rfqId, account, counterReply({ quoteRef, unitPrice }), { numbers: [unitPrice] }, now);
      store.addMessage(account, rfqId, now, 'out', m, 'mail', null, { event: 'message_counter_reply', by: { actor: 'code' } });
      return { frozen: p.frozen, newlyFrozen: p.newlyFrozen };
    },

    async probe(rfqId: string, account: string, kind: 'reopen', itemCode: string | null, now: number): Promise<{ frozen: boolean }> {
      return { frozen: store.recordProbe(account, rfqId, kind, itemCode, now).frozen };
    },

    /** Is the buyer group's discount frozen now? Read at decision time (ADVERSARIAL 16), not when the case opened. */
    async isFrozen(account: string, now: number): Promise<boolean> {
      return store.frozen(account, now);
    },

    /** The rep's one-year volume commitment, recorded once the workflow has accepted the change it came with. */
    async addCommitment(c: { account: string; itemCode: string; annualQty: number; rep: string; rfqId: string }, now: number): Promise<void> {
      store.addCommitment(c, now);
    },

    async aiTotals(rfqId: string): Promise<Totals> {
      return store.aiTotals(rfqId);
    },

    // ---- Rules ----

    /**
     * Small-order pre-check (section 13), code only: an exact item code and a quantity in the text,
     * valued at the item's minimum price. It reads no account data (the request may name another
     * account). It only picks the intake model; the rules decide the path from the real price.
     */
    async estimateValue(text: string): Promise<number | null> {
      const pn = text.match(/\b[A-Z]{2,5}-\d{2,3}(?:-[A-Z]{2})?\b/)?.[0];
      const item = pn ? store.exactPart(pn) : null;
      const qty = text.match(/(\d[\d,]*)\s*(?:units?|pcs|pieces|nos|×|x\s)/i) ?? text.match(/(?:×|\bx)\s*(\d[\d,]*)/i);
      if (!item || !qty) return null;
      const price = store.minPrice(item);
      return price === null ? null : Number(qty[1]!.replace(/,/g, '')) * price;
    },

    /** Account, part, quantity, contract price, price band. No model. Another account's data is never read. */
    async evaluate(rfqId: string, account: string, req: RfqRequest, approval: FinanceApproval | null, salesPrice: number | null, now: number, lockedPrice: number | null = null, standing = false, trade: TradeInputs | null = null): Promise<Evaluation> {
      const me = caller(account);
      const base = { caller: me, matches: [], item: null, contractPrice: null, approval, salesPrice, lockedPrice, trade };
      let ev: Evaluation;
      if (namesOtherAccount(req, me)) ev = evaluate(req, base);
      else {
        const matches = store.findParts(req.partNumber, req.partNumber ? null : req.partDescription);
        const item = matches.length === 1 ? (store.item(matches[0]!.partNumber) ?? null) : null;
        // Probe counters (re-quotes per buyer group) and the freeze; an identical live quote returns its price.
        if (item && req.quantity) store.recordProbe(me.code, rfqId, 'rfq', item.itemCode, now);
        const cached = item && req.quantity && !approval && salesPrice === null ? store.cachedQuote(me.code, item.itemCode, req.quantity, req.deliverBy, now, rfqId, trade?.paymentDays != null && trade.paymentDays <= TRADES.fastPayment.maxDays ? trade.paymentDays : null) : null;
        ev = evaluate(req, { ...base, matches, item, contractPrice: item ? store.contractPrice(me.code, item.itemCode) : null, cachedPrice: cached?.unitPrice ?? null, frozen: standing || store.frozen(me.code, now) });
        if (cached && ev.kind === 'ok') store.audit(now, rfqId, 'cached_price', { quoteRef: cached.quoteRef, unitPrice: cached.unitPrice, validUntil: cached.validUntil }, { actor: 'rules' });
      }
      const detail =
        ev.kind === 'clarify'
          ? { result: 'clarify', reason: ev.reason, options: ev.options.map((o) => o.partNumber) }
          : ev.kind === 'blocked'
            ? { result: 'blocked', reason: ev.reason }
            : { result: ev.kind === 'ok' ? 'pass' : 'to_finance', price: ev.price };
      store.audit(now, rfqId, 'price_check', detail, { actor: 'rules', promptVersion: null });
      return ev;
    },

    /** Firm requests: enough on hand, or the split/full offer against the earliest PO. Nothing is reserved. */
    async stockCheck(rfqId: string, itemCode: string, quantity: number, deliverBy: string | null, now: number): Promise<StockCheck> {
      const available = store.availableFor(itemCode, rfqId);
      const enough = available >= quantity;
      const built = enough ? null : buildOffer(quantity, available, store.earliestPo(itemCode), deliverBy, now);
      store.audit(now, rfqId, 'stock_check', { itemCode, quantity, available, result: enough ? 'ok' : 'short', options: built?.options.map((o) => o.id) ?? [] }, { actor: 'rules' });
      return { itemCode, available, enough, offer: built?.offer ?? null, options: built?.options ?? [], stockDate: stockDeliveryDate(deliverBy, now) };
    },

    async placeHold(rfqId: string, itemCode: string, quantity: number, now: number): Promise<HoldResult> {
      return store.placeHold(rfqId, itemCode, quantity, now);
    },

    async expireHold(rfqId: string, now: number): Promise<boolean> {
      return store.expireHold(rfqId, now);
    },

    async releaseReservations(rfqId: string, status: 'released' | 'expired', now: number) {
      return store.releaseReservations(rfqId, status, now);
    },

    async issueQuote(a: IssueArgs): Promise<IssueResult> {
      return store.issueQuote(a);
    },

    async bookOrder(rfqId: string, quoteRef: string, revision: number, now: number, place: string | null) {
      return store.bookOrder(rfqId, quoteRef, revision, now, place);
    },

    async markRevision(quoteRef: string, revision: number, status: 'declined' | 'expired'): Promise<void> {
      store.markRevision(quoteRef, revision, status);
    },

    async recordLoss(rfqId: string, revision: number, l: { reason: DeclineOutput['reason']; evidence: string | null; words: string | null; taggedBy: string | null }, by: Provenance, now: number) {
      store.recordLoss(rfqId, revision, l, now, by);
    },

    // ---- Messages and audit ----

    /** Every outbound customer message is a code template (section 9). Returns the message id. */
    async notify(rfqId: string, account: string, n: Notice, now: number): Promise<string> {
      let m: Outbound;
      let by: Provenance = { actor: 'code' };
      let rules: OutboundRules;
      switch (n.kind) {
        case 'question':
          m = questionMessage(n.topic, n.text);
          by = n.by;
          rules = {}; // free text: no rupee figure at all
          break;
        case 'ack_stock':
          m = ackStock(n.quantity, n.item);
          rules = { numbers: [n.quantity] };
          break;
        case 'ack_finance':
          m = ackFinance(n.quantity, n.item);
          rules = { numbers: [n.quantity] };
          break;
        case 'ack_short':
          m = ackShort(n.facts);
          rules = { numbers: [n.facts.quantity, n.facts.availableNow, n.facts.quantity - n.facts.availableNow, n.facts.po?.quantity ?? n.facts.quantity] };
          break;
        case 'price_refused':
          m = priceRefused(n);
          rules = { numbers: [n.unitPrice, n.unitPrice * n.quantity, n.quantity] };
          break;
        case 'quote_expired':
          m = quoteExpired(n.quoteRef, n.validUntil);
          rules = { numbers: [] };
          break;
        case 'lost_ack':
          m = lostAck(n.quoteRef, n.poArrivesOn);
          rules = { numbers: [] };
          break;
        case 'counter_reply':
          m = counterReply(n);
          rules = { numbers: [n.unitPrice] };
          break;
        case 'accept_on_hold':
          m = acceptOnHold(n.quoteRef);
          rules = { numbers: [] };
          break;
      }
      m = checked(rfqId, account, m, rules, now);
      return store.addMessage(account, rfqId, now, 'out', m, 'mail', null, { event: `message_${m.kind}`, by });
    },

    async record(rfqId: string, event: string, detail: object, by: Provenance, now: number): Promise<void> {
      store.audit(now, rfqId, event, detail, by);
    },

    /** Snapshot for the API, plus a review-queue update when the status changes. */
    async publish(state: QuoteState, now: number): Promise<number> {
      const { seq, statusChanged } = store.publish(state, now);
      if (queue && statusChanged) {
        const waitingOn: QueueEntry['waitingOn'] =
          state.status === 'needs_customer'
            ? 'customer'
            : state.status === 'awaiting_finance'
              ? 'finance'
              : state.status === 'awaiting_inventory'
                ? 'inventory'
                : ['awaiting_sales', 'blocked', 'finance_rejected', 'expired', 'lost'].includes(state.status)
                  ? 'sales'
                  : null;
        const entry: QueueEntry = { rfqId: state.rfqId, account: state.account, status: state.status, waitingOn, version: state.draftVersion, updatedAt: now };
        try {
          await queue.client.workflow.signalWithStart('reviewQueueWorkflow', { workflowId: queue.workflowId, taskQueue: queue.taskQueue, args: [[]], signal: 'queueUpdate', signalArgs: [entry] });
        } catch (e) {
          if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
          await queue.client.workflow.getHandle(queue.workflowId).signal('queueUpdate', entry);
        }
      }
      return seq;
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;

/** The fact list holds customer sentences: kept on the audit row, not in workflow history. */
const stripFacts = (m: AgentMeta): AgentMeta => {
  const { facts: _f, ...rest } = m;
  return rest;
};
