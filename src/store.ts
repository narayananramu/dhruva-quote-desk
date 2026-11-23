import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { alertMetrics, type AlertLevel, type Signal, type SignalId } from './claims';
import { CLAWBACK, DAY, DEMO_START, HOLDS, POLICY, PROBE, WIN_RATE } from './config';
import { withGstinCheck } from './claims';
import type { Account, Channel, CustomerHistory, DeliveryOption, LossReason, MessageKind, StockRow } from './contract';
import {
  addDays,
  closeOfBusiness,
  istDate,
  marginPct,
  monthName,
  minPriceOf,
  priceFacts,
  tradePrice,
  winRateAt,
  type TradeApplied,
  type TradeInputs,
  type CustomerFacts,
  type FinanceApproval,
  type OutcomeRow,
  type WinRate,
  type ItemRules,
  type Part,
  type PoFacts,
} from './domain';
import { figuresIn, messageText, orderChanged, orderConfirmed, quoteMessage, type Mail, type Outbound } from './messages';
import { outboundProblem, placeOrNull } from './agents/guardrails';
import type { QuoteState } from './state';

const TABLES = [
  'accounts', 'items', 'contract_prices', 'stock', 'purchase_orders', 'reservations', 'rfqs', 'quote_revisions', 'loss_reasons', 'orders', 'messages', 'settings', 'audit', 'ai_calls',
  'buyer_group', 'quote_outcomes', 'rep_commitments', 'competitors', 'buyer_claim', 'claim_alert', 'alert_review', 'claim_verification', 'probe_events',
  'account_links', 'discount_conditions', 'debit_notes',
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (code TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, owner TEXT NOT NULL, payment_terms_days INTEGER NOT NULL,
  gstin TEXT, group_id TEXT, pan TEXT, bank_account TEXT, address TEXT);
CREATE TABLE IF NOT EXISTS account_links (a TEXT NOT NULL, b TEXT NOT NULL, via TEXT NOT NULL, PRIMARY KEY (a, b, via));
CREATE TABLE IF NOT EXISTS items (item_code TEXT PRIMARY KEY, description TEXT NOT NULL, unit_cost INTEGER NOT NULL, min_margin_pct REAL NOT NULL, max_discount_pct REAL NOT NULL,
  part_group TEXT NOT NULL DEFAULT 'general', clearance INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS contract_prices (account TEXT NOT NULL, item_code TEXT NOT NULL, price INTEGER NOT NULL, PRIMARY KEY (account, item_code));
CREATE TABLE IF NOT EXISTS stock (item_code TEXT PRIMARY KEY, location TEXT NOT NULL, on_hand INTEGER NOT NULL, held INTEGER NOT NULL DEFAULT 0,
  allocated INTEGER NOT NULL DEFAULT 0, counted_at INTEGER NOT NULL, feed_live INTEGER NOT NULL,
  CHECK (held >= 0 AND allocated >= 0 AND on_hand - held - allocated >= 0));
CREATE TABLE IF NOT EXISTS purchase_orders (po_id TEXT PRIMARY KEY, item_code TEXT NOT NULL, quantity INTEGER NOT NULL, reserved INTEGER NOT NULL DEFAULT 0,
  arrives_on TEXT NOT NULL, supplier_tat_days INTEGER NOT NULL, CHECK (reserved >= 0 AND reserved <= quantity));
CREATE TABLE IF NOT EXISTS reservations (id INTEGER PRIMARY KEY AUTOINCREMENT, rfq_id TEXT NOT NULL, revision INTEGER, item_code TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('stock','po')), po_id TEXT, quantity INTEGER NOT NULL, deliver_on TEXT, expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','ordered','released','expired')));
CREATE TABLE IF NOT EXISTS rfqs (rfq_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, quote_ref TEXT UNIQUE NOT NULL, account TEXT NOT NULL, channel TEXT NOT NULL,
  received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, state_json TEXT, client_key TEXT);
CREATE TABLE IF NOT EXISTS quote_revisions (quote_ref TEXT NOT NULL, revision INTEGER NOT NULL, rfq_id TEXT NOT NULL, item_code TEXT NOT NULL, quantity INTEGER NOT NULL,
  unit_price INTEGER NOT NULL, total INTEGER NOT NULL, firm INTEGER NOT NULL, delivery_json TEXT NOT NULL, finance_price INTEGER, finance_reason TEXT,
  sent_at INTEGER NOT NULL, valid_until INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent','accepted','declined','expired','superseded')), account TEXT, deliver_by TEXT,
  base_price INTEGER, trades_json TEXT, payment_days INTEGER, lead_days INTEGER, priority INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (quote_ref, revision));
CREATE TABLE IF NOT EXISTS loss_reasons (rfq_id TEXT NOT NULL, revision INTEGER NOT NULL, reason TEXT, evidence TEXT, customer_words TEXT, tagged_by TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (rfq_id, revision));
CREATE TABLE IF NOT EXISTS orders (order_ref TEXT PRIMARY KEY, account TEXT NOT NULL, item_code TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL, ordered_on TEXT NOT NULL, note TEXT NOT NULL, discounted INTEGER NOT NULL, paid_days INTEGER, rfq_id TEXT,
  contract_price INTEGER, base_price INTEGER, trades_json TEXT, terms_days INTEGER, lead_days INTEGER, cancelled_qty INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS discount_conditions (id INTEGER PRIMARY KEY AUTOINCREMENT, order_ref TEXT NOT NULL, rfq_id TEXT, account TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('quantity','order_value','commitment','payment_days')), required INTEGER NOT NULL, granted_inr INTEGER NOT NULL,
  source TEXT NOT NULL, commitment_id INTEGER, status TEXT NOT NULL CHECK (status IN ('open','met','broken')), created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS debit_notes (note_ref TEXT PRIMARY KEY, account TEXT NOT NULL, order_ref TEXT, condition_id INTEGER, kind TEXT NOT NULL,
  amount_inr INTEGER NOT NULL, detail TEXT NOT NULL, rep TEXT, commission_inr INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, rfq_id TEXT, at INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')), kind TEXT NOT NULL, channel TEXT NOT NULL, text TEXT NOT NULL, mail_json TEXT, chat_text TEXT, reply_to INTEGER);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, rfq_id TEXT NOT NULL, event TEXT NOT NULL, detail TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'code', model TEXT, prompt_version TEXT);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TABLE IF NOT EXISTS ai_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, rfq_id TEXT NOT NULL, at INTEGER NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL,
  prompt_version TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
  inr_per_m REAL NOT NULL, inr REAL NOT NULL, ok INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ai_calls_rfq ON ai_calls (rfq_id);
CREATE TABLE IF NOT EXISTS buyer_group (group_id TEXT PRIMARY KEY, name TEXT NOT NULL, confirmed_fakes INTEGER NOT NULL DEFAULT 0, frozen_until INTEGER, frozen_reason TEXT);
CREATE TABLE IF NOT EXISTS quote_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, account TEXT, part_group TEXT NOT NULL, item_code TEXT NOT NULL,
  unit_price INTEGER NOT NULL, list_price INTEGER NOT NULL, won INTEGER NOT NULL, closed_on TEXT NOT NULL, rfq_id TEXT, revision INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS quote_outcomes_rfq ON quote_outcomes (rfq_id, revision) WHERE rfq_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS quote_outcomes_group ON quote_outcomes (part_group, closed_on);
CREATE TABLE IF NOT EXISTS rep_commitments (id INTEGER PRIMARY KEY AUTOINCREMENT, account TEXT NOT NULL, item_code TEXT NOT NULL, annual_qty INTEGER NOT NULL,
  rep TEXT NOT NULL, rfq_id TEXT, start_on TEXT NOT NULL, created_at INTEGER NOT NULL, note TEXT, settled_at INTEGER);
CREATE TABLE IF NOT EXISTS competitors (name TEXT NOT NULL, gstin TEXT, part_group TEXT NOT NULL, PRIMARY KEY (name, part_group));
CREATE TABLE IF NOT EXISTS buyer_claim (claim_id TEXT PRIMARY KEY, rfq_id TEXT NOT NULL, group_id TEXT NOT NULL, account TEXT NOT NULL, rival TEXT, rival_gstin TEXT,
  claimed_price INTEGER, attachment_hash TEXT, attachment_text TEXT, source TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS claim_alert (alert_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, level TEXT NOT NULL CHECK (level IN ('likely_fake','check','no_concern')),
  signals_json TEXT NOT NULL, findings_json TEXT NOT NULL, threshold_version TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS alert_review (alert_id TEXT PRIMARY KEY, verdict TEXT NOT NULL CHECK (verdict IN ('correct','wrong')), reviewer TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS claim_verification (claim_id TEXT PRIMARY KEY, result TEXT NOT NULL CHECK (result IN ('genuine','fake')), channel TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS probe_events (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, account TEXT NOT NULL, rfq_id TEXT, kind TEXT NOT NULL,
  item_code TEXT, at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS probe_events_once ON probe_events (rfq_id, kind) WHERE kind IN ('rfq','requote');
CREATE UNIQUE INDEX IF NOT EXISTS probe_events_prompt ON probe_events (rfq_id, kind, item_code) WHERE kind = 'prompt_leak';
CREATE INDEX IF NOT EXISTS audit_rfq ON audit (rfq_id);
CREATE INDEX IF NOT EXISTS reservations_rfq ON reservations (rfq_id);
`;

/** 4.1 accounts: code, name, mail, owner (the rep), GSTIN without its check character, bank account, delivery address. */
const SEED_ACCOUNTS: [string, string, string, string, string, string, string][] = [
  ['ACC-104', 'Acme Pumps', 'purchase@acmepumps.example', 'Priya N.', '27AAACA1234A1Z', 'HDFC 50100011112222', 'Plot 7, Chakan MIDC, Pune'],
  ['ACC-211', 'Shakti Motors', 'purchase@shaktimotors.example', 'Priya N.', '27AAACS9012S1Z', 'SBIN 30012345678', 'Plot 14, MIDC Bhosari, Pune'],
  ['ACC-212', 'Shakti Auto Parts', 'orders@shaktimotors.example', 'Priya N.', '27AAFCS4455P1Z', 'SBIN 30012345678', 'Plot 14, MIDC Bhosari, Pune'],
  ['ACC-318', 'Kaveri Engineering', 'purchase@kaveriengineering.example', 'Arjun K.', '33AAACK5678K1Z', 'ICIC 000405006789', 'SIDCO Estate, Guindy, Chennai'],
  ['ACC-405', 'Nilgiri Pumps', 'buy@nilgiripumps.example', 'Arjun K.', '33AAFCN7788N1Z', 'UTIB 917020045566', 'Peelamedu, Coimbatore'],
];
/** Items tagged clearance: the only ones that may be sold below cost. */
const CLEARANCE_ITEMS = ['VLV-25'];
const DEMO_ROLES = new Set(['sales', 'finance', 'inventory', 'professor']);
/** The PAN is characters 3 to 12 of a GSTIN. */
const panOf = (gstin: string | null) => (gstin && gstin.length >= 12 ? gstin.slice(2, 12) : null);
/** Mail domains many unrelated buyers share: they never link accounts. */
const PUBLIC_MAIL = new Set(['gmail.com', 'yahoo.com', 'yahoo.co.in', 'outlook.com', 'hotmail.com', 'rediffmail.com', 'icloud.com', 'proton.me']);
const norm = (v: string | null | undefined) => (v ? v.toLowerCase().replace(/[^a-z0-9]/g, '') : '');
export type LinkVia = 'gstin' | 'pan' | 'bank_account' | 'address' | 'email_domain';

export type HoldResult =
  | { ok: true; expiresAt: number; onHand: number; location: string; countedAt: number }
  | { ok: false; reason: 'INSUFFICIENT_STOCK' | 'STALE_STOCK' | 'HOLD_LIMIT' | 'NOT_IN_GOOD_STANDING' };

export type IssueResult =
  | { kind: 'sent'; revision: number; at: number; validUntil: number; fromStock: number; fromPo: number; poId: string | null; messageId: string; to: string; replay: boolean }
  | { kind: 'terms_changed'; unitPrice: number | null }
  | { kind: 'failed'; reason: 'STALE_STOCK' | 'HOLD_EXPIRED' | 'INSUFFICIENT_STOCK' | 'NO_CONTRACT_PRICE' | 'UNKNOWN_ACCOUNT' };

export type BookResult = { ok: true; orderRef: string; replay: boolean } | { ok: false; reason: 'QUOTE_EXPIRED' };

export interface IssueArgs {
  rfqId: string;
  quoteRef: string;
  revision: number; // the revision this send creates
  account: string;
  itemCode: string;
  quantity: number;
  draftPrice: number;
  firm: boolean;
  delivery: DeliveryOption;
  place: string | null;
  approval: FinanceApproval | null;
  salesPrice: number | null;
  askedPrice: number | null;
  /** The live price of an identical quote, the group freeze and the sent-price lock: rechecked as the draft was built. */
  cachedPrice?: number | null;
  frozen?: boolean;
  lockedPrice?: number | null;
  deliverBy?: string | null;
  /** H1: the trades the request carries (later date, faster payment). */
  trade?: TradeInputs | null;
  /** H1: false once the buyer has countered on this RFQ (stock priority is for buyers who accept the first price). */
  priority?: boolean;
  now: number;
}

/** Who produced an audited step: code, a person, or an agent with its model and prompt version. */
export interface Provenance {
  actor: string;
  model?: string | null;
  promptVersion?: string | null;
}

export interface StoredMessage {
  id: string;
  account: string;
  rfqId: string | null;
  at: number;
  direction: 'in' | 'out';
  kind: MessageKind;
  channel: string;
  text: string;
  mail: Mail | null;
  chat: string | null;
  replyTo: string | null;
}

export interface RfqRow {
  rfqId: string;
  workflowId: string;
  quoteRef: string;
  account: string;
  channel: Channel;
  receivedAt: number;
  updatedAt: number;
  seq: number;
  status: string;
  state: QuoteState | null;
  clientKey: string | null;
}

export interface AiCallInput {
  rfqId: string;
  at: number;
  agent: 'intake' | 'clarify' | 'finance' | 'decline' | 'evidence';
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  inrPerM: number;
  inr: number;
  ok: boolean;
}

const MIN = 60_000;

/** SQLite store. Every state change and its audit row are one IMMEDIATE transaction. */
export class Store {
  readonly db: Database.Database;

  constructor(path = ':memory:') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
    this.db.exec(SCHEMA);
  }

  /** Adds columns introduced after a database file was created. A reset rebuilds everything anyway. */
  private migrate(): void {
    const add: [string, string, string][] = [
      ['accounts', 'gstin', 'TEXT'],
      ['accounts', 'group_id', 'TEXT'],
      ['items', 'part_group', "TEXT NOT NULL DEFAULT 'general'"],
      ['items', 'clearance', 'INTEGER NOT NULL DEFAULT 0'],
      ['quote_revisions', 'account', 'TEXT'],
      ['quote_revisions', 'deliver_by', 'TEXT'],
      ['accounts', 'pan', 'TEXT'],
      ['accounts', 'bank_account', 'TEXT'],
      ['accounts', 'address', 'TEXT'],
      ['quote_revisions', 'base_price', 'INTEGER'],
      ['quote_revisions', 'trades_json', 'TEXT'],
      ['quote_revisions', 'payment_days', 'INTEGER'],
      ['quote_revisions', 'lead_days', 'INTEGER'],
      ['quote_revisions', 'priority', 'INTEGER NOT NULL DEFAULT 1'],
      ['orders', 'contract_price', 'INTEGER'],
      ['orders', 'base_price', 'INTEGER'],
      ['orders', 'trades_json', 'TEXT'],
      ['orders', 'terms_days', 'INTEGER'],
      ['orders', 'lead_days', 'INTEGER'],
      ['orders', 'cancelled_qty', 'INTEGER NOT NULL DEFAULT 0'],
      ['orders', 'priority', 'INTEGER NOT NULL DEFAULT 1'],
      ['rep_commitments', 'settled_at', 'INTEGER'],
    ];
    for (const [table, col, decl] of add) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (cols.length && !cols.some((c) => c.name === col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
  }

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  // ---- Settings and counters ----

  isEmpty(): boolean {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM settings').get() as { n: number }).n === 0;
  }
  setting(key: string): string | null {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }
  setSetting(key: string, value: string | number): void {
    this.db.prepare('INSERT INTO settings VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }
  clockOffset(): number {
    return Number(this.setting('clock_offset_ms') ?? 0);
  }
  epoch(): number {
    return Number(this.setting('epoch') ?? 1);
  }
  staleStock(): boolean {
    return this.setting('stale_stock') === '1';
  }

  /** Allocates the RFQ id and quote reference together (quote ref at intake, not at send). */
  allocateRfq(): { rfqId: string; quoteRef: string } {
    return this.tx(() => {
      const r = Number(this.setting('next_rfq') ?? 8843);
      const q = Number(this.setting('next_quote') ?? 420);
      this.setSetting('next_rfq', r + 1);
      this.setSetting('next_quote', q + 1);
      return { rfqId: `RFQ-${r}`, quoteRef: `Q-2026-${String(q).padStart(5, '0')}` };
    });
  }
  workflowIdFor(rfqId: string): string {
    const e = this.epoch();
    return `${rfqId.toLowerCase()}${e > 1 ? `.${e}` : ''}`;
  }

  // ---- Reset and seed (section 4) ----

  /** Drops and recreates every table in one transaction (DROP TABLE does not fire the row triggers), then seeds. */
  resetAll(now: number, epoch: number): void {
    this.tx(() => {
      for (const t of TABLES) this.db.exec(`DROP TABLE IF EXISTS ${t}`);
      this.db.exec(SCHEMA);
      this.seedBase(now);
      this.setSetting('epoch', epoch);
    });
  }

  /** 4.1 to 4.5. Count times and PO dates are placed relative to `now` as they are to 23 Nov 2026 10:00. */
  seedBase(now: number): void {
    const run = () => {
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n > 0) return;
      const acct = this.db.prepare('INSERT INTO accounts (code, name, email, owner, payment_terms_days, gstin, group_id, pan, bank_account, address) VALUES (?, ?, ?, ?, 30, ?, ?, ?, ?, ?)');
      const group = this.db.prepare('INSERT INTO buyer_group (group_id, name) VALUES (?, ?)');
      // code, name, email, owner, GSTIN (14 characters; the check character is added), bank account, delivery address
      for (const [code, name, email, owner, gstin14, bank, address] of SEED_ACCOUNTS) {
        const gstin = withGstinCheck(gstin14);
        acct.run(code, name, email, owner, gstin, `GRP-${code.slice(4)}`, panOf(gstin), bank, address);
        group.run(`GRP-${code.slice(4)}`, name);
      }
      // A1: Shakti Auto Parts shares Shakti Motors' bank account, delivery address and mail domain: one buyer group.
      this.relink(now);
      // CRM competitor list per part group (rival names and GSTINs on record).
      const comp = this.db.prepare('INSERT INTO competitors VALUES (?, ?, ?)');
      comp.run('Deccan Bearings', withGstinCheck('27AABCD1111D1Z'), 'bearings');
      comp.run('Western Bearing Co', withGstinCheck('24AABCW2222W1Z'), 'bearings');
      comp.run('Coastal Valves', withGstinCheck('33AABCC4321C1Z'), 'valves');
      comp.run('Sahyadri Flow', withGstinCheck('27AABCS3333S1Z'), 'valves');
      const at = (hhmm: string) => now - (DEMO_START - Date.parse(`2026-11-23T${hhmm}:00+05:30`));
      // item, description, location, cost, contract, on hand, held, allocated, counted, feed live
      const items: [string, string, string, number, number, number, number, string, number][] = [
        ['BRG-25-SS', 'Sealed 25mm bearing', 'Pune', 820, 1000, 340, 0, '09:57', 1],
        ['BRG-25-OP', 'Open 25mm bearing', 'Pune', 738, 900, 120, 0, '09:57', 1],
        ['BRG-30-SS', 'Sealed 30mm bearing', 'Ahmedabad', 984, 1200, 35, 10, '09:30', 1],
        ['VLV-40', 'Valve, 40mm', 'Chennai', 820, 1000, 180, 0, '09:50', 1],
        ['VLV-50', 'Valve, 50mm', 'Chennai', 1200, 1500, 60, 40, '09:50', 1],
        ['SEAL-12', 'O-ring seal kit', 'Pune', 205, 250, 900, 150, '09:57', 1],
        ['GSK-80', 'Flange gasket', 'Ahmedabad', 328, 400, 42, 0, '08:12', 0],
        ['VLV-25', 'Valve, 25mm, clearance', 'Chennai', 560, 700, 400, 0, '09:50', 1],
      ];
      const item = this.db.prepare("INSERT INTO items VALUES (?, ?, ?, 16, 10, ?, ?)");
      const groupOf = (code: string) => (code.startsWith('BRG') ? 'bearings' : code.startsWith('VLV') ? 'valves' : code.startsWith('SEAL') ? 'seals' : 'gaskets');
      const stock = this.db.prepare('INSERT INTO stock VALUES (?, ?, ?, 0, ?, ?, ?)');
      const price = this.db.prepare('INSERT INTO contract_prices VALUES (?, ?, ?)');
      for (const [code, desc, loc, cost, contract, onHand, allocated, counted, live] of items) {
        // Seed invariant: unitCost < floorPrice <= contractPrice.
        if (!(cost < Math.round(contract * 0.9) && Math.round(contract * 0.9) <= contract)) throw new Error(`seed invariant fails for ${code}`);
        item.run(code, desc, cost, groupOf(code), CLEARANCE_ITEMS.includes(code) ? 1 : 0);
        stock.run(code, loc, onHand, allocated, at(counted), live);
        for (const [a] of SEED_ACCOUNTS) price.run(a, code, contract);
      }
      const shift = Math.round((Date.parse(`${istDate(now)}T00:00:00Z`) - Date.parse('2026-11-23T00:00:00Z')) / DAY);
      const po = this.db.prepare('INSERT INTO purchase_orders VALUES (?, ?, ?, 0, ?, ?)');
      po.run('PO-7781', 'VLV-50', 200, addDays('2026-12-02', shift), 9);
      po.run('PO-7779', 'BRG-30-SS', 50, addDays('2026-11-28', shift), 7);
      const order = this.db.prepare(
        'INSERT INTO orders (order_ref, account, item_code, quantity, unit_price, unit_cost, ordered_on, note, discounted, paid_days, rfq_id, contract_price, terms_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 30)',
      );
      const hist: [string, string, string, number, number, number, string, number, number][] = [
        ['ACC-211', 'VLV-40', '2026-11-02', 300, 1000, 820, 'Paid', 0, 20],
        ['ACC-211', 'VLV-40', '2026-08-14', 400, 920, 820, 'Discount, competitor match', 1, 30],
        ['ACC-211', 'VLV-40', '2026-06-06', 250, 1000, 820, 'Paid', 0, 28],
        ['ACC-211', 'VLV-40', '2026-03-19', 300, 950, 820, 'Discount, volume', 1, 29],
        ['ACC-211', 'VLV-40', '2026-01-10', 150, 1000, 820, 'Paid', 0, 28],
        ['ACC-104', 'BRG-25-SS', '2026-10-12', 250, 1000, 820, 'Paid', 0, 24],
        ['ACC-104', 'BRG-25-SS', '2026-08-03', 200, 1000, 820, 'Paid', 0, 26],
        ['ACC-104', 'BRG-25-SS', '2026-05-18', 300, 1000, 820, 'Paid', 0, 25],
        ['ACC-104', 'BRG-25-SS', '2026-02-09', 150, 1000, 820, 'Paid', 0, 25],
        ['ACC-318', 'VLV-50', '2026-09-21', 200, 1500, 1200, 'Paid', 0, 31],
        ['ACC-318', 'VLV-50', '2026-07-07', 150, 1500, 1200, 'Paid', 0, 29],
        ['ACC-318', 'VLV-50', '2026-04-15', 100, 1500, 1200, 'Paid', 0, 30],
        ['ACC-405', 'VLV-25', '2026-09-18', 100, 700, 560, 'Paid', 0, 32],
      ];
      const listOf: Record<string, number> = Object.fromEntries(items.map((i) => [i[0], i[4]]));
      hist.forEach(([a, i, d, q, p, c, note, disc, paid], n) => order.run(`SO-2025-${String(900 + n)}`, a, i, q, p, c, d, note, disc, paid, listOf[i] ?? p));
      this.seedOutcomes(now);
      for (const [k, v] of Object.entries({ next_rfq: 8843, next_quote: 420, next_order: 1142, stale_stock: 0 })) {
        this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?, ?)').run(k, String(v));
      }
      this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('epoch', '1')").run();
      this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('clock_offset_ms', '0')").run();
    };
    this.db.inTransaction ? run() : this.tx(run);
  }

  /**
   * Closed quotes of the last 12 months for the bearings and valves groups (DECISIONS 1 and 9), so the
   * win-rate ranges have data: 8 past buyer groups quote at 86% to 102% of list price; the share won
   * falls as the price rises. Seals and gaskets have no history ("not enough data").
   */
  private seedOutcomes(now: number): void {
    const today = istDate(now);
    const ins = this.db.prepare('INSERT INTO quote_outcomes (group_id, account, part_group, item_code, unit_price, list_price, won, closed_on, rfq_id, revision) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL)');
    const ratios = [0.86, 0.88, 0.9, 0.92, 0.94, 0.96, 0.98, 1.0, 1.02];
    let n = 0;
    for (const [pg, item, list] of [
      ['valves', 'VLV-40', 1000],
      ['valves', 'VLV-50', 1500],
      ['bearings', 'BRG-25-SS', 1000],
    ] as const) {
      ratios.forEach((r) => {
        const wins = Math.round(8 * (0.75 - (r - 0.86) * 2.5));
        for (let g = 0; g < 8; g++) {
          n += 1;
          // Valves split across two items: each past group appears under one of them.
          if (pg === 'valves' && (g % 2 === 0) !== (item === 'VLV-40')) continue;
          ins.run(`HIST-${pg.slice(0, 1).toUpperCase()}${g + 1}`, pg, item, Math.round(list * r), list, g < wins ? 1 : 0, addDays(today, -(5 + ((n * 37) % 330))));
        }
      });
    }
  }

  // ---- Accounts and catalogue ----

  account(code: string): (Account & { owner: string; termsDays: number }) | undefined {
    return this.db.prepare('SELECT code, name, email, owner, payment_terms_days AS termsDays FROM accounts WHERE code = ?').get(code) as
      | (Account & { owner: string; termsDays: number })
      | undefined;
  }
  accounts(): Account[] {
    return this.db.prepare('SELECT code, name, email FROM accounts ORDER BY code').all() as Account[];
  }
  otherAccountNames(code: string): string[] {
    return (this.db.prepare('SELECT name FROM accounts WHERE code <> ?').all(code) as { name: string }[]).map((r) => r.name);
  }

  exactPart(partNumber: string): string | null {
    const r = this.db.prepare('SELECT item_code AS c FROM items WHERE lower(item_code) = lower(?)').get(partNumber.trim()) as { c: string } | undefined;
    return r?.c ?? null;
  }

  /** Exact item code, else items whose description contains every word of the query. */
  findParts(partNumber: string | null, description: string | null): Part[] {
    const all = this.db.prepare('SELECT item_code AS partNumber, description FROM items ORDER BY item_code').all() as Part[];
    for (const q of [partNumber, description]) {
      if (!q) continue;
      const exact = this.exactPart(q);
      if (exact) return all.filter((p) => p.partNumber === exact);
    }
    if (!description) return [];
    const words = description
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter((w) => w.length > 1 && !['the', 'of', 'and', 'for', 'a', 'an', 'one', 'units', 'unit', 'pcs'].includes(w))
      .map((w) => (w.length > 3 ? w.replace(/s$/, '') : w));
    if (!words.length) return [];
    return all.filter((p) => {
      const d = p.description.toLowerCase();
      return words.every((w) => d.includes(w));
    });
  }

  /** The item's minimum price (no account data): used only to spot small orders before intake. */
  minPrice(code: string): number | null {
    const r = this.db.prepare('SELECT unit_cost, min_margin_pct FROM items WHERE item_code = ?').get(code) as { unit_cost: number; min_margin_pct: number } | undefined;
    return r ? Math.round(r.unit_cost / (1 - r.min_margin_pct / 100)) : null;
  }

  item(code: string): ItemRules | undefined {
    const r = this.db
      .prepare(
        'SELECT i.item_code AS itemCode, i.description, s.location, i.unit_cost AS unitCost, i.min_margin_pct AS minMarginPct, i.max_discount_pct AS maxDiscountPct, i.part_group AS partGroup, i.clearance FROM items i JOIN stock s ON s.item_code = i.item_code WHERE i.item_code = ?',
      )
      .get(code) as (Omit<ItemRules, 'clearance'> & { clearance: number }) | undefined;
    return r ? { ...r, clearance: r.clearance === 1 } : undefined;
  }

  contractPrice(account: string, itemCode: string): number | null {
    const r = this.db.prepare('SELECT price FROM contract_prices WHERE account = ? AND item_code = ?').get(account, itemCode) as { price: number } | undefined;
    return r?.price ?? null;
  }

  // ---- Stock ----

  stockRaw(itemCode: string): { onHand: number; held: number; allocated: number; countedAt: number; feedLive: boolean; location: string } {
    const r = this.db.prepare('SELECT on_hand, held, allocated, counted_at, feed_live, location FROM stock WHERE item_code = ?').get(itemCode) as {
      on_hand: number;
      held: number;
      allocated: number;
      counted_at: number;
      feed_live: number;
      location: string;
    };
    return { onHand: r.on_hand, held: r.held, allocated: r.allocated, countedAt: r.counted_at, feedLive: r.feed_live === 1, location: r.location };
  }

  available(itemCode: string): number {
    const s = this.stockRaw(itemCode);
    return s.onHand - s.held - s.allocated;
  }

  /** Available to this RFQ: its own active stock hold counts as available, since placing a new hold releases it first. */
  availableFor(itemCode: string, rfqId: string): number {
    const own = this.db.prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM reservations WHERE rfq_id = ? AND item_code = ? AND source = 'stock' AND status = 'active'").get(rfqId, itemCode) as { n: number };
    return this.available(itemCode) + own.n;
  }

  /** The earliest incoming PO for the item that still has free quantity. */
  earliestPo(itemCode: string): PoFacts | null {
    const r = this.db
      .prepare('SELECT po_id, quantity, reserved, arrives_on, supplier_tat_days FROM purchase_orders WHERE item_code = ? AND quantity > reserved ORDER BY arrives_on LIMIT 1')
      .get(itemCode) as { po_id: string; quantity: number; reserved: number; arrives_on: string; supplier_tat_days: number } | undefined;
    return r ? { poId: r.po_id, quantity: r.quantity, reserved: r.reserved, arrivesOn: r.arrives_on, supplierTatDays: r.supplier_tat_days } : null;
  }

  stockRow(itemCode: string, now: number): StockRow {
    const i = this.db.prepare('SELECT description FROM items WHERE item_code = ?').get(itemCode) as { description: string };
    const s = this.stockRaw(itemCode);
    const available = s.onHand - s.held - s.allocated;
    const po = this.db.prepare('SELECT po_id, quantity, arrives_on FROM purchase_orders WHERE item_code = ? ORDER BY arrives_on LIMIT 1').get(itemCode) as
      | { po_id: string; quantity: number; arrives_on: string }
      | undefined;
    return {
      itemCode,
      description: i.description,
      location: s.location,
      onHand: s.onHand,
      reserved: s.held,
      ordered: s.allocated,
      available,
      low: available < POLICY.lowStockBelow,
      arriving: po ? { poId: po.po_id, quantity: po.quantity, on: po.arrives_on } : null,
      countedAt: s.countedAt,
      countOld: this.countOld(itemCode, now),
    };
  }

  stockRows(now: number): StockRow[] {
    return (this.db.prepare('SELECT item_code FROM stock ORDER BY rowid').all() as { item_code: string }[]).map((r) => this.stockRow(r.item_code, now));
  }

  countOld(itemCode: string, now: number): boolean {
    const s = this.stockRaw(itemCode);
    return !s.feedLive && now - s.countedAt > POLICY.stockFreshMs;
  }

  /** The simulated stock feed: a live feed stamps the count fresh; a dead one leaves it. */
  readFeed(itemCode: string, now: number, rfqId = '-'): boolean {
    const s = this.stockRaw(itemCode);
    if (!s.feedLive) return false;
    this.db.prepare('UPDATE stock SET counted_at = ? WHERE item_code = ?').run(now, itemCode);
    this.audit(now, rfqId, 'stock_feed_read', { itemCode, onHand: s.onHand });
    return true;
  }

  refreshFeed(itemCode: string, now: number): StockRow {
    this.tx(() => this.readFeed(itemCode, now));
    return this.stockRow(itemCode, now);
  }

  /** A count backs a firm date only if it is at most 5 minutes old; a live feed is re-read first. */
  private fresh(itemCode: string, now: number, rfqId: string): boolean {
    let s = this.stockRaw(itemCode);
    if (now - s.countedAt > POLICY.stockFreshMs && s.feedLive) {
      this.readFeed(itemCode, now, rfqId);
      s = this.stockRaw(itemCode);
    }
    return now - s.countedAt <= POLICY.stockFreshMs;
  }

  /** Only Inventory clears an old count. */
  confirmCount(itemCode: string, onHand: number, now: number, user: string): { ok: true; row: StockRow } | { ok: false; code: string } {
    return this.tx(() => {
      const s = this.stockRaw(itemCode);
      if (onHand < s.held + s.allocated) return { ok: false as const, code: 'BELOW_RESERVED' };
      this.db.prepare('UPDATE stock SET on_hand = ?, counted_at = ?, feed_live = 1 WHERE item_code = ?').run(onHand, now, itemCode);
      this.audit(now, '-', 'count_confirmed', { itemCode, onHand, user }, { actor: 'inventory' });
      return { ok: true as const, row: this.stockRow(itemCode, now) };
    });
  }

  setStaleStock(on: boolean, now: number): void {
    this.tx(() => {
      // 08:12 today; before 08:17 that is not old yet, so 08:12 yesterday.
      let t = Date.parse(`${istDate(now)}T08:12:00+05:30`);
      if (t > now - POLICY.stockFreshMs) t -= DAY;
      if (on) this.db.prepare('UPDATE stock SET feed_live = 0, counted_at = ?').run(t);
      else this.db.prepare('UPDATE stock SET feed_live = 1, counted_at = ?').run(now);
      this.setSetting('stale_stock', on ? 1 : 0);
    });
  }

  /** Atomic check-and-hold (2.2). Two RFQs racing for the last units: exactly one wins. */
  placeHold(rfqId: string, itemCode: string, quantity: number, now: number): HoldResult {
    return this.tx((): HoldResult => {
      this.releaseActive(rfqId, 'released', now);
      // A2: holds per buyer group, only for a group in good standing.
      const account = (this.db.prepare('SELECT account FROM rfqs WHERE rfq_id = ?').get(rfqId) as { account: string } | undefined)?.account;
      if (account) {
        const h = this.holdLimits(account, now, rfqId);
        const value = quantity * (this.contractPrice(account, itemCode) ?? 0);
        const reason = !h.goodStanding ? 'NOT_IN_GOOD_STANDING' : h.open + 1 > h.maxOpen || h.qty + quantity > h.maxQty || h.valueInr + value > h.maxValueInr ? 'HOLD_LIMIT' : null;
        if (reason) {
          this.audit(now, rfqId, 'hold_refused', { itemCode, quantity, reason, groupId: h.groupId, open: h.open, maxOpen: h.maxOpen, qty: h.qty, maxQty: h.maxQty, valueInr: h.valueInr, maxValueInr: h.maxValueInr, expiries: h.expiries }, { actor: 'rules' });
          return { ok: false, reason };
        }
      }
      if (!this.fresh(itemCode, now, rfqId)) {
        this.audit(now, rfqId, 'hold_refused', { itemCode, quantity, reason: 'STALE_STOCK' });
        return { ok: false, reason: 'STALE_STOCK' };
      }
      const r = this.db.prepare('UPDATE stock SET held = held + ? WHERE item_code = ? AND on_hand - held - allocated >= ?').run(quantity, itemCode, quantity);
      if (r.changes !== 1) {
        this.audit(now, rfqId, 'hold_refused', { itemCode, quantity, reason: 'INSUFFICIENT_STOCK' });
        return { ok: false, reason: 'INSUFFICIENT_STOCK' };
      }
      const expiresAt = now + POLICY.holdMs;
      this.db
        .prepare("INSERT INTO reservations (rfq_id, revision, item_code, source, po_id, quantity, deliver_on, expires_at, created_at, status) VALUES (?, NULL, ?, 'stock', NULL, ?, NULL, ?, ?, 'active')")
        .run(rfqId, itemCode, quantity, expiresAt, now);
      const s = this.stockRaw(itemCode);
      this.audit(now, rfqId, 'hold_placed', { itemCode, quantity, expiresAt, onHand: s.onHand, location: s.location });
      return { ok: true, expiresAt, onHand: s.onHand, location: s.location, countedAt: s.countedAt };
    });
  }

  /**
   * A2: what the buyer group holds now (active reservations of its other RFQs) and its limits. Every
   * HOLDS.expiriesPerStep RFQs whose reservation expired without an order in the window halve the
   * limits. Good standing: no overdue invoice or debit note, and no confirmed fake claim.
   */
  holdLimits(account: string, now: number, exceptRfq = ''): { groupId: string; open: number; qty: number; valueInr: number; maxOpen: number; maxQty: number; maxValueInr: number; expiries: number; goodStanding: boolean; why: string[] } {
    const groupId = this.groupOf(account);
    const held = this.db
      .prepare(
        "SELECT r.rfq_id, r.item_code, r.quantity, q.account FROM reservations r JOIN rfqs q ON q.rfq_id = r.rfq_id JOIN accounts a ON a.code = q.account WHERE a.group_id = ? AND r.status = 'active' AND r.rfq_id <> ?",
      )
      .all(groupId, exceptRfq) as { rfq_id: string; item_code: string; quantity: number; account: string }[];
    const expiries = (
      this.db
        .prepare(
          "SELECT COUNT(DISTINCT r.rfq_id) AS n FROM reservations r JOIN rfqs q ON q.rfq_id = r.rfq_id JOIN accounts a ON a.code = q.account WHERE a.group_id = ? AND r.status = 'expired' AND r.created_at > ? AND NOT EXISTS (SELECT 1 FROM reservations o WHERE o.rfq_id = r.rfq_id AND o.status = 'ordered')",
        )
        .get(groupId, now - HOLDS.expiryWindowDays * DAY) as { n: number }
    ).n;
    const factor = 0.5 ** Math.floor(expiries / HOLDS.expiriesPerStep);
    const why: string[] = [];
    const today = istDate(now);
    const overdue = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM orders o JOIN accounts a ON a.code = o.account WHERE a.group_id = ? AND o.paid_days IS NULL AND o.ordered_on < ?")
        .get(groupId, addDays(today, -(this.account(account)?.termsDays ?? 30))) as { n: number }
    ).n;
    const lateNotes = (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM debit_notes d JOIN accounts a ON a.code = d.account WHERE a.group_id = ? AND d.status = 'open' AND d.created_at < ?")
        .get(groupId, now - (this.account(account)?.termsDays ?? 30) * DAY) as { n: number }
    ).n;
    const fakes = this.group(groupId)?.confirmedFakes ?? 0;
    if (overdue) why.push('overdue invoice');
    if (lateNotes) why.push('overdue debit note');
    if (fakes) why.push('confirmed fake claim');
    return {
      groupId,
      open: new Set(held.map((h) => h.rfq_id)).size,
      qty: held.reduce((n, h) => n + h.quantity, 0),
      valueInr: held.reduce((n, h) => n + h.quantity * (this.contractPrice(h.account, h.item_code) ?? 0), 0),
      maxOpen: Math.floor(HOLDS.maxOpen * factor),
      maxQty: Math.floor(HOLDS.maxQty * factor),
      maxValueInr: Math.floor(HOLDS.maxValueInr * factor),
      expiries,
      goodStanding: why.length === 0,
      why,
    };
  }

  /** Gives stock and PO quantities back. Returns what was released. */
  private releaseActive(rfqId: string, status: 'released' | 'expired', now: number): { fromStock: number; fromPo: number; poId: string | null } {
    const rows = this.db.prepare("SELECT id, item_code, source, po_id, quantity FROM reservations WHERE rfq_id = ? AND status = 'active'").all(rfqId) as {
      id: number;
      item_code: string;
      source: 'stock' | 'po';
      po_id: string | null;
      quantity: number;
    }[];
    let fromStock = 0;
    let fromPo = 0;
    let poId: string | null = null;
    for (const r of rows) {
      if (r.source === 'stock') {
        this.db.prepare('UPDATE stock SET held = held - ? WHERE item_code = ? AND held >= ?').run(r.quantity, r.item_code, r.quantity);
        fromStock += r.quantity;
      } else {
        this.db.prepare('UPDATE purchase_orders SET reserved = reserved - ? WHERE po_id = ? AND reserved >= ?').run(r.quantity, r.po_id, r.quantity);
        fromPo += r.quantity;
        poId = r.po_id;
      }
      this.db.prepare('UPDATE reservations SET status = ? WHERE id = ?').run(status, r.id);
    }
    if (rows.length) this.audit(now, rfqId, status === 'expired' ? 'reservation_expired' : 'reservation_released', { fromStock, fromPo, poId });
    return { fromStock, fromPo, poId };
  }

  releaseReservations(rfqId: string, status: 'released' | 'expired', now: number) {
    return this.tx(() => this.releaseActive(rfqId, status, now));
  }

  /** Called by the workflow's durable hold timer: only an unsent hold that has run out. */
  expireHold(rfqId: string, now: number): boolean {
    return this.tx(() => {
      const live = this.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE rfq_id = ? AND status = 'active' AND revision IS NULL AND expires_at <= ?").get(rfqId, now) as { n: number };
      if (!live.n) return false;
      this.releaseActive(rfqId, 'expired', now);
      this.audit(now, rfqId, 'hold_expired', {}, { actor: 'timer' });
      return true;
    });
  }

  // ---- Send, book (2.4) ----

  /**
   * Send: recheck account, price band and approval, count freshness and the reservation (or place the
   * split/full reservations); insert the revision and the quote message; audit. One transaction,
   * idempotent on (rfq, revision).
   */
  issueQuote(a: IssueArgs): IssueResult {
    try {
      return this.issueTx(a);
    } catch (e) {
      if (!(e instanceof RefusedError)) throw e;
      this.audit(a.now, a.rfqId, 'send_refused', { reason: e.reason });
      return { kind: 'failed', reason: e.reason };
    }
  }

  private issueTx(a: IssueArgs): IssueResult {
    return this.tx((): IssueResult => {
      const prior = this.db.prepare('SELECT sent_at, valid_until FROM quote_revisions WHERE quote_ref = ? AND revision = ?').get(a.quoteRef, a.revision) as
        | { sent_at: number; valid_until: number }
        | undefined;
      if (prior) {
        const res = this.reservedFor(a.rfqId, a.revision);
        const msg = this.db.prepare("SELECT id FROM messages WHERE rfq_id = ? AND kind = 'quote' ORDER BY id DESC LIMIT 1").get(a.rfqId) as { id: number };
        return { kind: 'sent', revision: a.revision, at: prior.sent_at, validUntil: prior.valid_until, ...res, messageId: String(msg.id), to: this.account(a.account)?.email ?? '', replay: true };
      }
      const acct = this.account(a.account);
      if (!acct) return { kind: 'failed', reason: 'UNKNOWN_ACCOUNT' };
      const item = this.item(a.itemCode);
      const contract = this.contractPrice(a.account, a.itemCode);
      if (!item || contract === null) return { kind: 'failed', reason: 'NO_CONTRACT_PRICE' };
      const p = priceFacts({
        item,
        contractPrice: contract,
        quantity: a.quantity,
        approval: a.approval,
        salesPrice: a.salesPrice,
        askedPrice: a.askedPrice,
        cachedPrice: a.cachedPrice ?? null,
        frozen: a.frozen ?? false,
        lockedPrice: a.lockedPrice ?? null,
        trade: a.trade ?? null,
      });
      if (p.band !== 'ok' || p.target !== a.draftPrice) {
        this.audit(a.now, a.rfqId, 'terms_changed', { draftPrice: a.draftPrice, current: p.target, band: p.band });
        return { kind: 'terms_changed', unitPrice: p.band === 'ok' ? p.target : null };
      }
      let validUntil = closeOfBusiness(a.now);
      let fromStock = 0;
      let fromPo = 0;
      let poId: string | null = null;
      if (a.firm) {
        const stockPart = a.delivery.parts.find((x) => x.source === 'stock');
        const poPart = a.delivery.parts.find((x) => x.source === 'po');
        if (stockPart && !this.fresh(a.itemCode, a.now, a.rfqId)) return this.refuse(a, 'STALE_STOCK');
        if (a.delivery.id === 'stock') {
          const hold = this.db
            .prepare("SELECT id, quantity, expires_at FROM reservations WHERE rfq_id = ? AND status = 'active' AND revision IS NULL AND source = 'stock'")
            .get(a.rfqId) as { id: number; quantity: number; expires_at: number } | undefined;
          if (!hold || hold.expires_at <= a.now || hold.quantity !== a.quantity) {
            if (hold && hold.expires_at <= a.now) this.releaseActive(a.rfqId, 'expired', a.now);
            return this.refuse(a, 'HOLD_EXPIRED');
          }
          validUntil = hold.expires_at; // sending does not extend the hold
          this.db.prepare('UPDATE reservations SET revision = ?, deliver_on = ? WHERE id = ?').run(a.revision, stockPart!.on, hold.id);
          fromStock = a.quantity;
        } else {
          this.releaseActive(a.rfqId, 'released', a.now);
          if (stockPart) {
            const r = this.db.prepare('UPDATE stock SET held = held + ? WHERE item_code = ? AND on_hand - held - allocated >= ?').run(stockPart.quantity, a.itemCode, stockPart.quantity);
            if (r.changes !== 1) return this.refuse(a, 'INSUFFICIENT_STOCK');
            this.insertReservation(a, 'stock', null, stockPart.quantity, stockPart.on, validUntil);
            fromStock = stockPart.quantity;
          }
          if (poPart) {
            const po = this.earliestPo(a.itemCode);
            const r = po
              ? this.db.prepare('UPDATE purchase_orders SET reserved = reserved + ? WHERE po_id = ? AND quantity - reserved >= ?').run(poPart.quantity, po.poId, poPart.quantity)
              : { changes: 0 };
            if (r.changes !== 1) throw new RefusedError('INSUFFICIENT_STOCK'); // undo the stock part too
            this.insertReservation(a, 'po', po!.poId, poPart.quantity, poPart.on, validUntil);
            fromPo = poPart.quantity;
            poId = po!.poId;
          }
        }
      }
      this.db.prepare("UPDATE quote_revisions SET status = 'superseded' WHERE rfq_id = ? AND status = 'sent'").run(a.rfqId);
      const approvalUsed = p.targetSource === 'finance' ? a.approval : null;
      // H1: a faster-payment trade is part of the price, so the quote states the payment days.
      const payDays = p.trades.some((t) => t.kind === 'fast_payment') ? (a.trade?.paymentDays ?? null) : null;
      this.db
        .prepare(
          "INSERT INTO quote_revisions (quote_ref, revision, rfq_id, item_code, quantity, unit_price, total, firm, delivery_json, finance_price, finance_reason, sent_at, valid_until, status, account, deliver_by, base_price, trades_json, payment_days, lead_days, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          a.quoteRef, a.revision, a.rfqId, a.itemCode, a.quantity, p.target, p.target * a.quantity, a.firm ? 1 : 0, JSON.stringify(a.delivery), approvalUsed?.unitPrice ?? null, approvalUsed?.reason ?? null, a.now, validUntil, a.account, a.deliverBy ?? null,
          p.basePrice, JSON.stringify(p.trades), payDays, a.trade?.leadDays ?? null, a.priority === false ? 0 : 1,
        );
      const facts = {
        quoteRef: a.quoteRef,
        revision: a.revision,
        itemCode: a.itemCode,
        description: item.description,
        quantity: a.quantity,
        unitPrice: p.target,
        firm: a.firm,
        delivery: a.delivery,
        place: placeOrNull(a.place),
        validUntil,
        now: a.now,
        paymentDays: payDays,
      };
      // DECISIONS 11: the quote states one price, its quantity, total, dates and payment days, and nothing else.
      const allowed = [a.quantity, p.target, p.target * a.quantity, ...a.delivery.parts.map((x) => x.quantity), ...figuresIn(item.description), ...(payDays !== null ? [payDays] : [])];
      let msg = quoteMessage(facts);
      const bad = outboundProblem(messageText(msg), { numbers: allowed, otherAccountNames: this.otherAccountNames(a.account) });
      if (bad) {
        this.audit(a.now, a.rfqId, 'outbound_blocked', { kind: 'quote', problem: bad, action: 'sent without the delivery place' }, { actor: 'rules' });
        msg = quoteMessage({ ...facts, place: null });
      }
      const messageId = this.insertMessage(a.account, a.rfqId, a.now, 'out', msg, 'mail', null);
      this.audit(a.now, a.rfqId, 'quote_sent', { quoteRef: a.quoteRef, revision: a.revision, unitPrice: p.target, total: p.target * a.quantity, validUntil, fromStock, fromPo, poId, to: acct.email });
      return { kind: 'sent', revision: a.revision, at: a.now, validUntil, fromStock, fromPo, poId, messageId, to: acct.email, replay: false };
    });
  }

  private refuse(a: IssueArgs, reason: 'STALE_STOCK' | 'HOLD_EXPIRED' | 'INSUFFICIENT_STOCK'): IssueResult {
    this.audit(a.now, a.rfqId, 'send_refused', { reason });
    return { kind: 'failed', reason };
  }

  private insertReservation(a: IssueArgs, source: 'stock' | 'po', poId: string | null, quantity: number, on: string, expiresAt: number) {
    this.db
      .prepare("INSERT INTO reservations (rfq_id, revision, item_code, source, po_id, quantity, deliver_on, expires_at, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')")
      .run(a.rfqId, a.revision, a.itemCode, source, poId, quantity, on, expiresAt, a.now);
  }

  private reservedFor(rfqId: string, revision: number) {
    const rows = this.db.prepare('SELECT source, po_id, quantity FROM reservations WHERE rfq_id = ? AND revision = ?').all(rfqId, revision) as { source: string; po_id: string | null; quantity: number }[];
    return {
      fromStock: rows.filter((r) => r.source === 'stock').reduce((s, r) => s + r.quantity, 0),
      fromPo: rows.filter((r) => r.source === 'po').reduce((s, r) => s + r.quantity, 0),
      poId: rows.find((r) => r.po_id)?.po_id ?? null,
    };
  }

  /** Accept inside validUntil: held → allocated, PO reservations ordered, order and confirmation. Idempotent. */
  bookOrder(rfqId: string, quoteRef: string, revision: number, now: number, place: string | null): BookResult {
    return this.tx((): BookResult => {
      const rev = this.db.prepare('SELECT * FROM quote_revisions WHERE quote_ref = ? AND revision = ?').get(quoteRef, revision) as
        | {
            status: string; valid_until: number; item_code: string; quantity: number; unit_price: number; firm: number; delivery_json: string; finance_reason: string | null; finance_price: number | null; rfq_id: string;
            base_price: number | null; trades_json: string | null; payment_days: number | null; lead_days: number | null; priority: number | null;
          }
        | undefined;
      if (!rev) return { ok: false, reason: 'QUOTE_EXPIRED' };
      if (rev.status === 'accepted') {
        const o = this.db.prepare('SELECT order_ref FROM orders WHERE rfq_id = ?').get(rfqId) as { order_ref: string };
        return { ok: true, orderRef: o.order_ref, replay: true };
      }
      const res = this.db.prepare("SELECT id, source, item_code, quantity FROM reservations WHERE rfq_id = ? AND revision = ? AND status = 'active'").all(rfqId, revision) as {
        id: number;
        source: string;
        item_code: string;
        quantity: number;
      }[];
      if (rev.status !== 'sent' || now > rev.valid_until || (rev.firm === 1 && res.length === 0)) {
        this.audit(now, rfqId, 'accept_refused', { reason: 'QUOTE_EXPIRED', validUntil: rev.valid_until });
        return { ok: false, reason: 'QUOTE_EXPIRED' };
      }
      for (const r of res) {
        if (r.source === 'stock') this.db.prepare('UPDATE stock SET held = held - ?, allocated = allocated + ? WHERE item_code = ?').run(r.quantity, r.quantity, r.item_code);
        this.db.prepare("UPDATE reservations SET status = 'ordered' WHERE id = ?").run(r.id);
      }
      this.db.prepare("UPDATE quote_revisions SET status = 'accepted' WHERE quote_ref = ? AND revision = ?").run(quoteRef, revision);
      const n = Number(this.setting('next_order') ?? 1142);
      this.setSetting('next_order', n + 1);
      const orderRef = `SO-2026-${n}`;
      const r = this.db.prepare('SELECT account FROM rfqs WHERE rfq_id = ?').get(rfqId) as { account: string };
      const item = this.item(rev.item_code)!;
      const contract = this.contractPrice(r.account, rev.item_code) ?? rev.unit_price;
      const note = rev.finance_reason && rev.unit_price < minPriceFor(item) ? `Discount, ${rev.finance_reason}` : 'New order';
      const acct = this.account(r.account)!;
      const trades = JSON.parse(rev.trades_json ?? '[]') as TradeApplied[];
      // H1: a faster-payment trade sets the invoice terms; otherwise the account's terms.
      const termsDays = rev.payment_days ?? acct.termsDays;
      // H1: stock priority is for a buyer who took the price without countering on this RFQ.
      const countered = this.db.prepare("SELECT 1 FROM probe_events WHERE rfq_id = ? AND kind = 'counter' LIMIT 1").get(rfqId);
      const priority = countered || rev.priority === 0 ? 0 : 1;
      this.db
        .prepare(
          'INSERT INTO orders (order_ref, account, item_code, quantity, unit_price, unit_cost, ordered_on, note, discounted, paid_days, rfq_id, contract_price, base_price, trades_json, terms_days, lead_days, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(orderRef, r.account, rev.item_code, rev.quantity, rev.unit_price, item.unitCost, istDate(now), note, rev.unit_price < contract ? 1 : 0, rfqId, contract, rev.base_price ?? contract, JSON.stringify(trades), termsDays, rev.lead_days, priority);
      this.addConditions({ orderRef, rfqId, account: r.account, item, quantity: rev.quantity, unitPrice: rev.unit_price, contract, base: rev.base_price ?? contract, trades, financePrice: rev.finance_price }, now);
      const delivery = JSON.parse(rev.delivery_json) as DeliveryOption;
      const facts = { orderRef, quantity: rev.quantity, itemCode: rev.item_code, description: item.description, unitPrice: rev.unit_price, delivery, place: placeOrNull(place), termsDays };
      const allowed = [rev.quantity, rev.unit_price, rev.unit_price * rev.quantity, termsDays, ...delivery.parts.map((x) => x.quantity), ...figuresIn(item.description)];
      let msg = orderConfirmed(facts);
      const bad = outboundProblem(messageText(msg), { numbers: allowed, otherAccountNames: this.otherAccountNames(r.account) });
      if (bad) {
        this.audit(now, rfqId, 'outbound_blocked', { kind: 'order_confirmed', problem: bad, action: 'sent without the delivery place' }, { actor: 'rules' });
        msg = orderConfirmed({ ...facts, place: null });
      }
      this.insertMessage(r.account, rfqId, now, 'out', msg, 'mail', null);
      this.audit(now, rfqId, 'order_booked', { orderRef, quantity: rev.quantity, unitPrice: rev.unit_price });
      this.recordOutcome(rfqId, revision, true, now);
      return { ok: true, orderRef, replay: false };
    });
  }

  // ---- A3: discount conditions, clawback debit notes, repricing after a partial cancellation ----

  /**
   * Each discount on an order records the condition it was granted on: a quantity tier or a person's
   * price is for the quantity ordered; faster payment is for paying within the promised days; a new
   * customer's discount below the minimum rests on the ₹10 lakh order or on the rep's year commitment.
   */
  private addConditions(
    o: { orderRef: string; rfqId: string; account: string; item: ItemRules; quantity: number; unitPrice: number; contract: number; base: number; trades: TradeApplied[]; financePrice: number | null },
    now: number,
  ): void {
    const add = this.db.prepare(
      "INSERT INTO discount_conditions (order_ref, rfq_id, account, kind, required, granted_inr, source, commitment_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)",
    );
    const rows: { kind: string; required: number; granted: number; source: string; commitmentId: number | null }[] = [];
    // Each trade's share is the step it took off the price, in the order the steps were applied.
    let pct = 0;
    for (const t of o.trades) {
      const before = Math.round(o.contract * (1 - pct / 100));
      pct += t.pct;
      const granted = (before - Math.round(o.contract * (1 - pct / 100))) * o.quantity;
      if (t.kind === 'quantity') rows.push({ kind: 'quantity', required: t.condition, granted, source: 'trade', commitmentId: null });
      if (t.kind === 'fast_payment') rows.push({ kind: 'payment_days', required: t.condition, granted, source: 'trade', commitmentId: null });
    }
    if (o.unitPrice < o.base) {
      const granted = (o.base - o.unitPrice) * o.quantity;
      const source = o.financePrice !== null ? 'finance' : 'sales';
      rows.push({ kind: 'quantity', required: o.quantity, granted, source, commitmentId: null });
      if (o.unitPrice < minPriceFor(o.item) && this.lifetime(o.account).newCustomer) {
        const c = this.commitments(o.account, now).filter((x) => x.itemCode === o.item.itemCode && x.active).at(-1);
        if (c) rows.push({ kind: 'commitment', required: c.annualQty, granted, source, commitmentId: c.id });
        else rows.push({ kind: 'order_value', required: POLICY.newCustomerOrderThreshold, granted, source, commitmentId: null });
      }
    }
    for (const r of rows) add.run(o.orderRef, o.rfqId, o.account, r.kind, r.required, r.granted, r.source, r.commitmentId, now);
    if (rows.length) this.audit(now, o.rfqId, 'discount_conditions', { orderRef: o.orderRef, conditions: rows }, { actor: 'rules' });
  }

  conditions(orderRef: string): { id: number; kind: string; required: number; grantedInr: number; source: string; commitmentId: number | null; status: string }[] {
    return this.db
      .prepare('SELECT id, kind, required, granted_inr AS grantedInr, source, commitment_id AS commitmentId, status FROM discount_conditions WHERE order_ref = ? ORDER BY id')
      .all(orderRef) as never;
  }

  order(orderRef: string) {
    return this.db.prepare('SELECT * FROM orders WHERE order_ref = ?').get(orderRef) as
      | {
          order_ref: string; account: string; item_code: string; quantity: number; unit_price: number; unit_cost: number; ordered_on: string; paid_days: number | null; rfq_id: string | null;
          contract_price: number | null; base_price: number | null; trades_json: string | null; terms_days: number | null; lead_days: number | null; cancelled_qty: number;
        }
      | undefined;
  }

  private debitNote(d: { account: string; orderRef: string | null; conditionId: number | null; kind: string; amount: number; detail: string; rep?: string | null; commission?: number; rfqId: string | null }, now: number): string {
    const n = Number(this.setting('next_debit_note') ?? 1);
    this.setSetting('next_debit_note', n + 1);
    const ref = `DN-2026-${String(n).padStart(4, '0')}`;
    this.db
      .prepare("INSERT INTO debit_notes (note_ref, account, order_ref, condition_id, kind, amount_inr, detail, rep, commission_inr, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)")
      .run(ref, d.account, d.orderRef, d.conditionId, d.kind, d.amount, d.detail, d.rep ?? null, d.commission ?? 0, now);
    this.audit(now, d.rfqId ?? '-', 'debit_note_raised', { noteRef: ref, account: d.account, orderRef: d.orderRef, kind: d.kind, amountInr: d.amount, commissionInr: d.commission ?? 0, rep: d.rep ?? null, detail: d.detail }, { actor: 'rules' });
    return ref;
  }

  /** A3: Finance records when an order was paid. Paying later than a faster-payment trade promised claws that discount back. */
  recordPayment(orderRef: string, paidDays: number, now: number, by: string): { ok: true; debitNotes: string[] } | { ok: false; code: 'NOT_FOUND' | 'ALREADY_PAID' } {
    return this.tx(() => {
      const o = this.order(orderRef);
      if (!o) return { ok: false as const, code: 'NOT_FOUND' as const };
      if (o.paid_days !== null) return { ok: false as const, code: 'ALREADY_PAID' as const };
      this.db.prepare('UPDATE orders SET paid_days = ? WHERE order_ref = ?').run(paidDays, orderRef);
      this.audit(now, o.rfq_id ?? '-', 'payment_recorded', { orderRef, paidDays, user: by }, { actor: 'finance' });
      const notes: string[] = [];
      for (const c of this.conditions(orderRef).filter((x) => x.kind === 'payment_days' && x.status === 'open')) {
        const broken = paidDays > c.required;
        this.db.prepare('UPDATE discount_conditions SET status = ? WHERE id = ?').run(broken ? 'broken' : 'met', c.id);
        // The faster-payment step on the order as it stands now (a partial cancel may have changed it).
        const item = this.item(o.item_code)!;
        const contract = o.contract_price ?? o.unit_price;
        const min = minPriceOf(item.unitCost, item.minMarginPct);
        const step = tradePrice(contract, min, o.quantity, { leadDays: o.lead_days, paymentDays: null }).price - tradePrice(contract, min, o.quantity, { leadDays: o.lead_days, paymentDays: c.required }).price;
        const amount = Math.max(0, step) * o.quantity || c.grantedInr;
        if (broken) notes.push(this.debitNote({ account: o.account, orderRef, conditionId: c.id, kind: 'payment_days', amount, detail: `Paid in ${paidDays} days; the price assumed payment within ${c.required} days.`, rfqId: o.rfq_id }, now));
      }
      return { ok: true as const, debitNotes: notes };
    });
  }

  /**
   * A3: settles a rep's year commitment (at its end, or early when Finance closes it). A shortfall claws
   * back the discounts it carried, in proportion to the units not ordered, and takes CLAWBACK.commissionPct
   * of that from the rep's commission.
   */
  settleCommitment(id: number, now: number, by: string): { ok: true; shortfall: number; debitNotes: string[] } | { ok: false; code: 'NOT_FOUND' | 'ALREADY_SETTLED' } {
    return this.tx(() => {
      const row = this.db.prepare('SELECT account, settled_at FROM rep_commitments WHERE id = ?').get(id) as { account: string; settled_at: number | null } | undefined;
      if (!row) return { ok: false as const, code: 'NOT_FOUND' as const };
      if (row.settled_at !== null) return { ok: false as const, code: 'ALREADY_SETTLED' as const };
      const c = this.commitments(row.account, now).find((x) => x.id === id)!;
      this.db.prepare('UPDATE rep_commitments SET settled_at = ? WHERE id = ?').run(now, id);
      this.audit(now, '-', 'commitment_settled', { id, account: row.account, annualQty: c.annualQty, orderedQty: c.orderedQty, shortfall: c.shortfall, user: by }, { actor: 'finance' });
      const notes: string[] = [];
      const conds = this.db.prepare("SELECT id, order_ref, rfq_id, granted_inr FROM discount_conditions WHERE commitment_id = ? AND status = 'open'").all(id) as { id: number; order_ref: string; rfq_id: string | null; granted_inr: number }[];
      for (const k of conds) {
        const broken = c.shortfall > 0;
        this.db.prepare('UPDATE discount_conditions SET status = ? WHERE id = ?').run(broken ? 'broken' : 'met', k.id);
        if (!broken) continue;
        const amount = Math.round((k.granted_inr * c.shortfall) / c.annualQty);
        const commission = Math.round((amount * CLAWBACK.commissionPct) / 100);
        notes.push(
          this.debitNote(
            { account: row.account, orderRef: k.order_ref, conditionId: k.id, kind: 'volume', amount, rep: c.rep, commission, detail: `Ordered ${c.orderedQty} of the ${c.annualQty} ${c.itemCode} committed; ${c.shortfall} short.`, rfqId: k.rfq_id },
            now,
          ),
        );
      }
      return { ok: true as const, shortfall: c.shortfall, debitNotes: notes };
    });
  }

  /**
   * A3: the buyer cancels part of an order. The cancelled units go back to stock or the PO. A discount
   * granted for the ordered quantity (a quantity tier, a person's price, the ₹10 lakh rule) no longer
   * holds: the rest is repriced at the price the smaller order earns (its own trades), the difference
   * is a debit note, and the customer is told the new figures.
   */
  cancelPart(orderRef: string, cancelQty: number, now: number, by: string): { ok: true; quantity: number; unitPrice: number; debitNote: string | null } | { ok: false; code: 'NOT_FOUND' | 'BAD_QUANTITY' } {
    return this.tx(() => {
      const o = this.order(orderRef);
      if (!o) return { ok: false as const, code: 'NOT_FOUND' as const };
      if (!Number.isInteger(cancelQty) || cancelQty < 1 || cancelQty >= o.quantity) return { ok: false as const, code: 'BAD_QUANTITY' as const };
      const left = o.quantity - cancelQty;
      // Give the units back: the PO part first (not yet arrived), then stock.
      let give = cancelQty;
      const res = this.db.prepare("SELECT id, source, po_id, item_code, quantity FROM reservations WHERE rfq_id = ? AND status = 'ordered' ORDER BY CASE source WHEN 'po' THEN 0 ELSE 1 END, id").all(o.rfq_id ?? '') as {
        id: number; source: string; po_id: string | null; item_code: string; quantity: number;
      }[];
      for (const r of res) {
        if (give <= 0) break;
        const take = Math.min(give, r.quantity);
        if (r.source === 'stock') this.db.prepare('UPDATE stock SET allocated = allocated - ? WHERE item_code = ? AND allocated >= ?').run(take, r.item_code, take);
        else this.db.prepare('UPDATE purchase_orders SET reserved = reserved - ? WHERE po_id = ? AND reserved >= ?').run(take, r.po_id, take);
        this.db.prepare("UPDATE reservations SET quantity = quantity - ?, status = CASE WHEN quantity - ? = 0 THEN 'released' ELSE status END WHERE id = ?").run(take, take, r.id);
        give -= take;
      }
      const item = this.item(o.item_code)!;
      const contract = o.contract_price ?? this.contractPrice(o.account, o.item_code) ?? o.unit_price;
      const trades = JSON.parse(o.trades_json ?? '[]') as TradeApplied[];
      const paymentDays = trades.some((t) => t.kind === 'fast_payment') ? o.terms_days : null;
      const earns = item.clearance || left * contract < 10_000 ? contract : tradePrice(contract, minPriceOf(item.unitCost, item.minMarginPct), left, { leadDays: o.lead_days, paymentDays }).price;
      const conds = this.conditions(orderRef).filter((c) => c.status === 'open' && (c.kind === 'quantity' || c.kind === 'order_value'));
      const brokenIds = conds.filter((c) => (c.kind === 'quantity' ? left < c.required : left * o.unit_price < c.required)).map((c) => c.id);
      for (const id of brokenIds) this.db.prepare("UPDATE discount_conditions SET status = 'broken' WHERE id = ?").run(id);
      const newPrice = Math.max(o.unit_price, earns);
      this.db.prepare('UPDATE orders SET quantity = ?, unit_price = ?, cancelled_qty = cancelled_qty + ?, discounted = ? WHERE order_ref = ?').run(left, newPrice, cancelQty, newPrice < contract ? 1 : 0, orderRef);
      this.audit(now, o.rfq_id ?? '-', 'order_part_cancelled', { orderRef, cancelled: cancelQty, quantity: left, unitPrice: o.unit_price, newUnitPrice: newPrice, brokenConditions: brokenIds, user: by }, { actor: 'customer' });
      let note: string | null = null;
      if (newPrice > o.unit_price) {
        note = this.debitNote(
          { account: o.account, orderRef, conditionId: brokenIds[0] ?? null, kind: 'reprice', amount: (newPrice - o.unit_price) * left, detail: `${cancelQty} of ${o.quantity} cancelled; the remaining ${left} are repriced from ${o.unit_price} to ${newPrice} each.`, rfqId: o.rfq_id },
          now,
        );
      }
      const msg = orderChanged({ orderRef, quantity: left, itemCode: o.item_code, unitPrice: newPrice });
      const bad = outboundProblem(messageText(msg), { numbers: [left, newPrice, left * newPrice], otherAccountNames: this.otherAccountNames(o.account) });
      if (!bad) this.insertMessage(o.account, o.rfq_id, now, 'out', msg, 'mail', null);
      else this.audit(now, o.rfq_id ?? '-', 'outbound_blocked', { kind: 'order_confirmed', problem: bad, action: 'not sent' }, { actor: 'rules' });
      return { ok: true as const, quantity: left, unitPrice: newPrice, debitNote: note };
    });
  }

  debitNotes(): { noteRef: string; account: string; accountName: string; orderRef: string | null; kind: string; amountInr: number; commissionInr: number; rep: string | null; detail: string; status: string; createdAt: number }[] {
    return this.db
      .prepare(
        'SELECT d.note_ref AS noteRef, d.account, a.name AS accountName, d.order_ref AS orderRef, d.kind, d.amount_inr AS amountInr, d.commission_inr AS commissionInr, d.rep, d.detail, d.status, d.created_at AS createdAt FROM debit_notes d JOIN accounts a ON a.code = d.account ORDER BY d.created_at DESC, d.note_ref DESC',
      )
      .all() as never;
  }

  /** Recent orders with their open discount conditions (for Finance: payments, partial cancels, commitments). */
  orders(account?: string): { orderRef: string; account: string; itemCode: string; quantity: number; unitPrice: number; orderedOn: string; paidDays: number | null; termsDays: number | null; conditions: ReturnType<Store['conditions']> }[] {
    const rows = this.db
      .prepare("SELECT order_ref, account, item_code, quantity, unit_price, ordered_on, paid_days, terms_days FROM orders WHERE rfq_id IS NOT NULL AND (? IS NULL OR account = ?) ORDER BY ordered_on DESC, order_ref DESC")
      .all(account ?? null, account ?? null) as { order_ref: string; account: string; item_code: string; quantity: number; unit_price: number; ordered_on: string; paid_days: number | null; terms_days: number | null }[];
    return rows.map((r) => ({ orderRef: r.order_ref, account: r.account, itemCode: r.item_code, quantity: r.quantity, unitPrice: r.unit_price, orderedOn: r.ordered_on, paidDays: r.paid_days, termsDays: r.terms_days, conditions: this.conditions(r.order_ref) }));
  }

  // ---- A4: per-rep report for Finance ----

  /**
   * Per rep (account owner), last 12 months: orders and the share sold below the contract price, the
   * rep's price revisions sent to Finance, the share of RFQs taken by phone, and the rep's margin
   * against the other reps'. A rep is flagged for the Finance reviewer's sample when the discount rate
   * is 20 points above the peers', the margin is 2 points below, or most RFQs come by phone.
   */
  repReport(now: number): { rep: string; accounts: number; orders: number; revenue: number; discountRatePct: number; financeRevisions: number; rfqs: number; phoneSharePct: number; marginPct: number; peerMarginPct: number | null; marginVsPeersPts: number | null; flags: string[] }[] {
    const since = addDays(istDate(now), -365);
    const reps = (this.db.prepare('SELECT DISTINCT owner FROM accounts ORDER BY owner').all() as { owner: string }[]).map((r) => r.owner);
    const ordersOf = (rep: string, peers: boolean) =>
      this.db
        .prepare(`SELECT o.quantity, o.unit_price, o.unit_cost, o.discounted FROM orders o JOIN accounts a ON a.code = o.account WHERE a.owner ${peers ? '<>' : '='} ? AND o.ordered_on > ?`)
        .all(rep, since) as { quantity: number; unit_price: number; unit_cost: number; discounted: number }[];
    const margin = (rows: { quantity: number; unit_price: number; unit_cost: number }[]) => {
      const rev = rows.reduce((n, r) => n + r.quantity * r.unit_price, 0);
      return rev ? Math.round((rows.reduce((n, r) => n + r.quantity * (r.unit_price - r.unit_cost), 0) / rev) * 1000) / 10 : null;
    };
    const rate = (rows: { discounted: number }[]) => (rows.length ? Math.round((rows.filter((r) => r.discounted === 1).length / rows.length) * 1000) / 10 : 0);
    return reps.map((rep) => {
      const own = ordersOf(rep, false);
      const peers = ordersOf(rep, true);
      const rfqs = this.db.prepare('SELECT q.rfq_id, q.channel FROM rfqs q JOIN accounts a ON a.code = q.account WHERE a.owner = ? AND q.received_at > ?').all(rep, now - 365 * DAY) as { rfq_id: string; channel: string }[];
      const toFinance = rfqs.length
        ? (
            this.db
              .prepare(`SELECT COUNT(*) AS n FROM audit WHERE event = 'approval_pending' AND json_extract(detail, '$.requestedBy') = 'sales' AND rfq_id IN (${rfqs.map(() => '?').join(',')})`)
              .get(...rfqs.map((r) => r.rfq_id)) as { n: number }
          ).n
        : 0;
      const m = margin(own) ?? 0;
      const pm = margin(peers);
      const phone = rfqs.length ? Math.round((rfqs.filter((r) => r.channel === 'phone').length / rfqs.length) * 1000) / 10 : 0;
      const dr = rate(own);
      const flags: string[] = [];
      if (peers.length && dr - rate(peers) >= 20) flags.push('discount rate');
      if (pm !== null && m - pm <= -2) flags.push('margin');
      if (rfqs.length >= 2 && phone > 50) flags.push('phone RFQs');
      if (toFinance >= 3) flags.push('revisions to Finance');
      return {
        rep,
        accounts: (this.db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE owner = ?').get(rep) as { n: number }).n,
        orders: own.length,
        revenue: own.reduce((n, r) => n + r.quantity * r.unit_price, 0),
        discountRatePct: dr,
        financeRevisions: toFinance,
        rfqs: rfqs.length,
        phoneSharePct: phone,
        marginPct: m,
        peerMarginPct: pm,
        marginVsPeersPts: pm === null ? null : Math.round((m - pm) * 10) / 10,
        flags,
      };
    });
  }

  markRevision(quoteRef: string, revision: number, status: 'declined' | 'expired'): void {
    this.db.prepare("UPDATE quote_revisions SET status = ? WHERE quote_ref = ? AND revision = ? AND status = 'sent'").run(status, quoteRef, revision);
  }

  recordLoss(rfqId: string, revision: number, l: { reason: LossReason | null; evidence: string | null; words: string | null; taggedBy: string | null }, now: number, by: Provenance): void {
    this.tx(() => {
      this.db
        .prepare(
          'INSERT INTO loss_reasons VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(rfq_id, revision) DO UPDATE SET reason = excluded.reason, tagged_by = excluded.tagged_by, evidence = COALESCE(excluded.evidence, evidence), customer_words = COALESCE(excluded.customer_words, customer_words)',
        )
        .run(rfqId, revision, l.reason, l.evidence, l.words, l.taggedBy, now);
      this.recordOutcome(rfqId, revision, false, now);
      this.audit(now, rfqId, l.taggedBy === 'sales' ? 'loss_tagged' : 'loss_recorded', { revision, reason: l.reason, evidence: l.evidence }, by);
    });
  }

  // ---- Messages ----

  insertMessage(account: string, rfqId: string | null, at: number, direction: 'in' | 'out', m: Outbound, channel: string, replyTo: string | null): string {
    const r = this.db
      .prepare('INSERT INTO messages (account, rfq_id, at, direction, kind, channel, text, mail_json, chat_text, reply_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(account, rfqId, at, direction, m.kind, channel, m.text, m.mail ? JSON.stringify(m.mail) : null, m.chat, replyTo === null ? null : Number(replyTo));
    return String(r.lastInsertRowid);
  }

  addMessage(account: string, rfqId: string | null, at: number, direction: 'in' | 'out', m: Outbound, channel: string, replyTo: string | null, audit?: { event: string; by: Provenance }): string {
    return this.tx(() => {
      const id = this.insertMessage(account, rfqId, at, direction, m, channel, replyTo);
      if (audit && rfqId) this.audit(at, rfqId, audit.event, { messageId: id, kind: m.kind, text: m.text }, audit.by);
      return id;
    });
  }

  setMessageRfq(id: string, rfqId: string): void {
    this.db.prepare('UPDATE messages SET rfq_id = ? WHERE id = ?').run(rfqId, Number(id));
  }

  private toMessage(r: Record<string, unknown>): StoredMessage {
    return {
      id: String(r.id),
      account: r.account as string,
      rfqId: (r.rfq_id as string | null) ?? null,
      at: r.at as number,
      direction: r.direction as 'in' | 'out',
      kind: r.kind as MessageKind,
      channel: r.channel as string,
      text: r.text as string,
      mail: r.mail_json ? (JSON.parse(r.mail_json as string) as Mail) : null,
      chat: (r.chat_text as string | null) ?? null,
      replyTo: r.reply_to === null || r.reply_to === undefined ? null : String(r.reply_to),
    };
  }

  message(id: string): StoredMessage | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id)) as Record<string, unknown> | undefined;
    return r ? this.toMessage(r) : undefined;
  }

  messagesFor(account: string): StoredMessage[] {
    return (this.db.prepare('SELECT * FROM messages WHERE account = ? ORDER BY at, id').all(account) as Record<string, unknown>[]).map((r) => this.toMessage(r));
  }

  messagesForRfq(rfqId: string): StoredMessage[] {
    return (this.db.prepare('SELECT * FROM messages WHERE rfq_id = ? ORDER BY at, id').all(rfqId) as Record<string, unknown>[]).map((r) => this.toMessage(r));
  }

  // ---- RFQ snapshots ----

  insertRfq(r: { rfqId: string; workflowId: string; quoteRef: string; account: string; channel: Channel; receivedAt: number; clientKey?: string | null }): void {
    this.db
      .prepare("INSERT INTO rfqs (rfq_id, workflow_id, quote_ref, account, channel, received_at, updated_at, seq, status, state_json, client_key) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'intake', NULL, ?)")
      .run(r.rfqId, r.workflowId, r.quoteRef, r.account, r.channel, r.receivedAt, r.receivedAt, r.clientKey ?? null);
  }

  /** The workflow's latest state. Returns the new seq and whether the status changed. */
  publish(state: QuoteState, now: number): { seq: number; statusChanged: boolean } {
    return this.tx(() => {
      const cur = this.db.prepare('SELECT seq, status FROM rfqs WHERE rfq_id = ?').get(state.rfqId) as { seq: number; status: string } | undefined;
      if (!cur) {
        this.insertRfq({ rfqId: state.rfqId, workflowId: state.workflowId, quoteRef: state.quoteRef, account: state.account, channel: state.channel, receivedAt: state.receivedAt });
      }
      const seq = (cur?.seq ?? 0) + 1;
      this.db.prepare('UPDATE rfqs SET seq = ?, status = ?, state_json = ?, updated_at = ? WHERE rfq_id = ?').run(seq, state.status, JSON.stringify(state), now, state.rfqId);
      return { seq, statusChanged: cur?.status !== state.status };
    });
  }

  private toRfq(r: Record<string, unknown>): RfqRow {
    return {
      rfqId: r.rfq_id as string,
      workflowId: r.workflow_id as string,
      quoteRef: r.quote_ref as string,
      account: r.account as string,
      channel: r.channel as Channel,
      receivedAt: r.received_at as number,
      updatedAt: r.updated_at as number,
      seq: r.seq as number,
      status: r.status as string,
      state: r.state_json ? (JSON.parse(r.state_json as string) as QuoteState) : null,
      clientKey: (r.client_key as string | null) ?? null,
    };
  }

  rfq(rfqId: string): RfqRow | undefined {
    const r = this.db.prepare('SELECT * FROM rfqs WHERE upper(rfq_id) = upper(?)').get(rfqId) as Record<string, unknown> | undefined;
    return r ? this.toRfq(r) : undefined;
  }
  rfqByQuoteRef(ref: string): RfqRow | undefined {
    const r = this.db.prepare('SELECT * FROM rfqs WHERE quote_ref = ?').get(ref) as Record<string, unknown> | undefined;
    return r ? this.toRfq(r) : undefined;
  }
  rfqByClientKey(account: string, key: string): RfqRow | undefined {
    const r = this.db.prepare('SELECT * FROM rfqs WHERE account = ? AND client_key = ?').get(account, key) as Record<string, unknown> | undefined;
    return r ? this.toRfq(r) : undefined;
  }
  rfqs(): RfqRow[] {
    return (this.db.prepare('SELECT * FROM rfqs ORDER BY received_at DESC, rfq_id DESC').all() as Record<string, unknown>[]).map((r) => this.toRfq(r));
  }

  // ---- Inventory views ----

  reservationRows(): {
    rfqId: string;
    revision: number | null;
    itemCode: string;
    source: 'stock' | 'po';
    poId: string | null;
    quantity: number;
    deliverOn: string | null;
    expiresAt: number;
    status: string;
    createdAt: number;
  }[] {
    return this.db
      .prepare(
        'SELECT rfq_id AS rfqId, revision, item_code AS itemCode, source, po_id AS poId, quantity, deliver_on AS deliverOn, expires_at AS expiresAt, status, created_at AS createdAt FROM reservations ORDER BY id',
      )
      .all() as never;
  }

  activeReservations(): number {
    return (this.db.prepare("SELECT COUNT(DISTINCT rfq_id || '/' || COALESCE(revision, -1)) AS n FROM reservations WHERE status = 'active'").get() as { n: number }).n;
  }

  // ---- Finance history (4.4) ----

  history(account: string, now: number): CustomerHistory {
    const acct = this.account(account)!;
    const since = addDays(istDate(now), -365);
    const rows = this.db
      .prepare('SELECT ordered_on, quantity, unit_price, unit_cost, note, discounted, paid_days FROM orders WHERE account = ? AND ordered_on > ? ORDER BY ordered_on DESC')
      .all(account, since) as { ordered_on: string; quantity: number; unit_price: number; unit_cost: number; note: string; discounted: number; paid_days: number | null }[];
    const revenue = rows.reduce((s, r) => s + r.quantity * r.unit_price, 0);
    const profit = rows.reduce((s, r) => s + r.quantity * (r.unit_price - r.unit_cost), 0);
    const paid = rows.filter((r) => r.paid_days !== null);
    const disc = rows.filter((r) => r.discounted === 1).reverse();
    return {
      account: { code: acct.code, name: acct.name, email: acct.email },
      months: 12,
      revenue,
      units: rows.reduce((s, r) => s + r.quantity, 0),
      orders: rows.length,
      avgMarginPct: revenue ? Math.round((profit / revenue) * 1000) / 10 : 0,
      companyMarginPct: POLICY.companyMarginPct,
      discounts: { count: disc.length, months: disc.map((r) => monthName(r.ordered_on)) },
      paysInDays: paid.length ? Math.round(paid.reduce((s, r) => s + r.paid_days!, 0) / paid.length) : null,
      termsDays: acct.termsDays,
      overdue: 0,
      ...this.lifetime(account),
      commitments: this.commitments(account, now),
      buyerGroup: this.groupView(account, now),
      rows: rows.map((r) => ({ date: r.ordered_on, units: r.quantity, unitPrice: r.unit_price, marginPct: marginPct(r.unit_price, r.unit_cost), note: r.note, discounted: r.discounted === 1 })),
    };
  }

  // ---- Audit and AI usage ----

  audit(now: number, rfqId: string, event: string, detail: object, by: Provenance = { actor: 'code' }): void {
    this.db
      .prepare('INSERT INTO audit (at, rfq_id, event, detail, actor, model, prompt_version) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(now, rfqId, event, JSON.stringify(detail), by.actor, by.model ?? null, by.promptVersion ?? null);
  }

  auditRows(rfqId: string): { id: number; at: number; event: string; detail: unknown; actor: string; model: string | null; promptVersion: string | null }[] {
    return (this.db.prepare('SELECT * FROM audit WHERE rfq_id = ? ORDER BY at, id').all(rfqId) as Record<string, unknown>[]).map((r) => ({
      id: r.id as number,
      at: r.at as number,
      event: r.event as string,
      detail: JSON.parse(r.detail as string) as unknown,
      actor: r.actor as string,
      model: (r.model as string | null) ?? null,
      promptVersion: (r.prompt_version as string | null) ?? null,
    }));
  }

  recordAiCall(c: AiCallInput): void {
    this.db
      .prepare('INSERT INTO ai_calls (rfq_id, at, agent, model, prompt_version, input_tokens, output_tokens, reasoning_tokens, inr_per_m, inr, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.rfqId, c.at, c.agent, c.model, c.promptVersion, c.inputTokens, c.outputTokens, c.reasoningTokens, c.inrPerM, c.inr, c.ok ? 1 : 0);
  }

  aiCalls(rfqId: string): AiCallInput[] {
    return (this.db.prepare('SELECT * FROM ai_calls WHERE rfq_id = ? ORDER BY id').all(rfqId) as Record<string, unknown>[]).map((r) => ({
      rfqId: r.rfq_id as string,
      at: r.at as number,
      agent: r.agent as AiCallInput['agent'],
      model: r.model as string,
      promptVersion: r.prompt_version as string,
      inputTokens: r.input_tokens as number,
      outputTokens: r.output_tokens as number,
      reasoningTokens: r.reasoning_tokens as number,
      inrPerM: r.inr_per_m as number,
      inr: r.inr as number,
      ok: r.ok === 1,
    }));
  }

  aiTotals(rfqId: string): { calls: number; input: number; output: number; reasoning: number; aiInr: number } {
    const r = this.db
      .prepare(
        'SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output, COALESCE(SUM(reasoning_tokens),0) AS reasoning, COALESCE(SUM(inr),0) AS aiInr FROM ai_calls WHERE rfq_id = ?',
      )
      .get(rfqId) as { calls: number; input: number; output: number; reasoning: number; aiInr: number };
    return r; // aiInr unrounded: rounded once for display (usageView)
  }

  // ---- Customer facts: lifetime, new-customer rule, commitments (DECISIONS 2 to 4) ----

  /**
   * Lifetime figures over every order on record (not only the last 12 months). The new-customer rule is
   * group-wide (A1): a buyer group with fewer than 3 paid orders across its linked accounts is new.
   */
  lifetime(account: string): { lifetimeRevenue: number; lifetimeOrders: number; paidOrders: number; groupPaidOrders: number; newCustomer: boolean } {
    const r = this.db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(quantity * unit_price), 0) AS rev, SUM(CASE WHEN paid_days IS NOT NULL THEN 1 ELSE 0 END) AS paid FROM orders WHERE account = ?')
      .get(account) as { n: number; rev: number; paid: number | null };
    const g = this.db
      .prepare('SELECT COUNT(*) AS n FROM orders o JOIN accounts a ON a.code = o.account WHERE a.group_id = ? AND o.paid_days IS NOT NULL')
      .get(this.groupOf(account)) as { n: number };
    const paid = r.paid ?? 0;
    const groupPaid = Math.max(g.n, paid);
    return { lifetimeRevenue: r.rev, lifetimeOrders: r.n, paidOrders: paid, groupPaidOrders: groupPaid, newCustomer: groupPaid < POLICY.newCustomerPaidOrders };
  }

  customerFacts(account: string): CustomerFacts {
    const acct = this.account(account)!;
    const rows = this.db.prepare('SELECT quantity, unit_price, discounted, paid_days FROM orders WHERE account = ?').all(account) as { quantity: number; unit_price: number; discounted: number; paid_days: number | null }[];
    const paid = rows.filter((r) => r.paid_days !== null);
    return {
      orders: rows.length,
      lifetimeRevenue: rows.reduce((s, r) => s + r.quantity * r.unit_price, 0),
      avgPaymentDays: paid.length ? Math.round(paid.reduce((s, r) => s + r.paid_days!, 0) / paid.length) : null,
      termsDays: acct.termsDays,
      overdueInvoices: 0,
      discountedOrders: rows.filter((r) => r.discounted === 1).length,
    };
  }

  /** A rep's one-year volume commitment, stored on the account (DECISIONS 4). */
  addCommitment(c: { account: string; itemCode: string; annualQty: number; rep: string; rfqId: string | null; note?: string | null }, now: number): number {
    // A demo role login ("sales", "professor") stands for the account's rep: the commitment (and any clawback from
    // the rep's commission, A3) is the account owner's.
    const rep = DEMO_ROLES.has(c.rep) ? (this.account(c.account)?.owner ?? c.rep) : c.rep;
    return this.tx(() => {
      const r = this.db
        .prepare('INSERT INTO rep_commitments (account, item_code, annual_qty, rep, rfq_id, start_on, created_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(c.account, c.itemCode, c.annualQty, rep, c.rfqId, istDate(now), now, c.note ?? null);
      this.audit(now, c.rfqId ?? '-', 'commitment_recorded', { account: c.account, itemCode: c.itemCode, annualQty: c.annualQty, user: c.rep }, { actor: 'sales' });
      return Number(r.lastInsertRowid);
    });
  }

  /** Commitments with the shortfall to date: committed units less units ordered since the start. */
  commitments(account: string, now: number): { id: number; itemCode: string; annualQty: number; rep: string; startOn: string; endsOn: string; orderedQty: number; shortfall: number; active: boolean; settled: boolean }[] {
    const rows = this.db.prepare('SELECT id, item_code, annual_qty, rep, start_on, settled_at FROM rep_commitments WHERE account = ? ORDER BY id').all(account) as {
      id: number;
      item_code: string;
      annual_qty: number;
      rep: string;
      start_on: string;
      settled_at: number | null;
    }[];
    const today = istDate(now);
    return rows.map((r) => {
      const endsOn = addDays(r.start_on, 365);
      const ordered = (this.db.prepare('SELECT COALESCE(SUM(quantity), 0) AS q FROM orders WHERE account = ? AND item_code = ? AND ordered_on >= ? AND ordered_on < ?').get(account, r.item_code, r.start_on, endsOn) as { q: number }).q;
      return { id: r.id, itemCode: r.item_code, annualQty: r.annual_qty, rep: r.rep, startOn: r.start_on, endsOn, orderedQty: ordered, shortfall: Math.max(0, r.annual_qty - ordered), active: today < endsOn && r.settled_at === null, settled: r.settled_at !== null };
    });
  }

  hasCommitment(account: string, itemCode: string, now: number): boolean {
    return this.commitments(account, now).some((c) => c.itemCode === itemCode && c.active);
  }

  // ---- Win rate at a price (DECISIONS 1 and 9) ----

  /** Closed quotes of the part group in the last 12 months, newest first. */
  outcomes(partGroup: string, now: number): OutcomeRow[] {
    const since = addDays(istDate(now), -30 * WIN_RATE.months - 5);
    return (
      this.db
        .prepare('SELECT group_id, unit_price, list_price, won, closed_on FROM quote_outcomes WHERE part_group = ? AND closed_on > ? ORDER BY closed_on DESC, id DESC')
        .all(partGroup, since) as { group_id: string; unit_price: number; list_price: number; won: number; closed_on: string }[]
    ).map((r) => ({ groupId: r.group_id, unitPrice: r.unit_price, listPrice: r.list_price, won: r.won === 1, closedOn: r.closed_on }));
  }

  winRate(partGroup: string, price: number, listPrice: number, now: number): WinRate {
    return winRateAt(price, listPrice, this.outcomes(partGroup, now));
  }

  /** Lowest Dhruva price in the part group's won and lost quotes, last 12 months (claim signal). */
  lowestPastPrice(partGroup: string, itemCode: string, now: number): number | null {
    const rows = this.outcomes(partGroup, now).filter((r) => r.unitPrice > 0);
    const list = this.db.prepare('SELECT MAX(price) AS p FROM contract_prices WHERE item_code = ?').get(itemCode) as { p: number | null };
    if (!rows.length || !list.p) return null;
    return Math.round(Math.min(...rows.map((r) => r.unitPrice / r.listPrice)) * list.p);
  }

  /** Dhruva's own price on a sent revision, won or lost. A price the buyer states is a claim, never an outcome. */
  private recordOutcome(rfqId: string, revision: number, won: boolean, now: number): void {
    const rev = this.db.prepare('SELECT item_code, unit_price FROM quote_revisions WHERE rfq_id = ? AND revision = ?').get(rfqId, revision) as { item_code: string; unit_price: number } | undefined;
    const rfq = this.db.prepare('SELECT account FROM rfqs WHERE rfq_id = ?').get(rfqId) as { account: string } | undefined;
    if (!rev || !rfq) return;
    const item = this.item(rev.item_code);
    const list = this.contractPrice(rfq.account, rev.item_code);
    if (!item || !list) return;
    this.db
      .prepare(
        'INSERT INTO quote_outcomes (group_id, account, part_group, item_code, unit_price, list_price, won, closed_on, rfq_id, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET won = excluded.won, closed_on = excluded.closed_on',
      )
      .run(this.groupOf(rfq.account), rfq.account, item.partGroup, rev.item_code, rev.unit_price, list, won ? 1 : 0, istDate(now), rfqId, revision);
  }

  /** Test helper: a closed quote with no RFQ behind it. */
  addOutcome(o: { groupId: string; partGroup: string; itemCode: string; unitPrice: number; listPrice: number; won: boolean; closedOn: string }): void {
    this.db
      .prepare('INSERT INTO quote_outcomes (group_id, account, part_group, item_code, unit_price, list_price, won, closed_on, rfq_id, revision) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL)')
      .run(o.groupId, o.partGroup, o.itemCode, o.unitPrice, o.listPrice, o.won ? 1 : 0, o.closedOn);
  }

  // ---- Cached quotes (DECISIONS 11: same request, same price) ----

  /**
   * The unit price of a live quote for the same account, item, quantity and delivery date, sent by
   * another RFQ and still valid. Re-asking returns this price, so asking again reveals nothing. A
   * Finance-approved price is single use and never cached: a repeat request goes back through the rules.
   */
  cachedQuote(account: string, itemCode: string, quantity: number, deliverBy: string | null, now: number, rfqId: string, paymentDays: number | null = null): { unitPrice: number; quoteRef: string; validUntil: number } | null {
    // A faster-payment trade is a different request (H1): it is part of the key.
    const r = this.db
      .prepare(
        "SELECT unit_price, quote_ref, valid_until FROM quote_revisions WHERE account = ? AND item_code = ? AND quantity = ? AND COALESCE(deliver_by, '') = COALESCE(?, '') AND COALESCE(payment_days, -1) = COALESCE(?, -1) AND status = 'sent' AND finance_price IS NULL AND valid_until > ? AND rfq_id <> ? ORDER BY sent_at DESC LIMIT 1",
      )
      .get(account, itemCode, quantity, deliverBy, paymentDays, now, rfqId) as { unit_price: number; quote_ref: string; valid_until: number } | undefined;
    return r ? { unitPrice: r.unit_price, quoteRef: r.quote_ref, validUntil: r.valid_until } : null;
  }

  // ---- Buyer groups, probe counters and the freeze (DECISIONS 11, ADVERSARIAL threat 3 and 4) ----

  groupOf(account: string): string {
    const r = this.db.prepare('SELECT group_id FROM accounts WHERE code = ?').get(account) as { group_id: string | null } | undefined;
    return r?.group_id ?? `GRP-${account}`;
  }

  group(groupId: string): { groupId: string; name: string; confirmedFakes: number; frozenUntil: number | null; frozenReason: string | null; accounts: string[] } | null {
    const g = this.db.prepare('SELECT * FROM buyer_group WHERE group_id = ?').get(groupId) as { group_id: string; name: string; confirmed_fakes: number; frozen_until: number | null; frozen_reason: string | null } | undefined;
    if (!g) return null;
    const accounts = (this.db.prepare('SELECT code FROM accounts WHERE group_id = ? ORDER BY code').all(groupId) as { code: string }[]).map((r) => r.code);
    return { groupId: g.group_id, name: g.name, confirmedFakes: g.confirmed_fakes, frozenUntil: g.frozen_until, frozenReason: g.frozen_reason, accounts };
  }

  frozen(account: string, now: number): boolean {
    const g = this.group(this.groupOf(account));
    return !!g?.frozenUntil && g.frozenUntil > now;
  }

  /** Counts of probe events per kind for the group in the rolling window. */
  probeCounts(groupId: string, now: number): Record<'counter' | 'requote' | 'reopen' | 'prompt_leak' | 'rfq', number> {
    const rows = this.db.prepare('SELECT kind, COUNT(*) AS n FROM probe_events WHERE group_id = ? AND at > ? GROUP BY kind').all(groupId, now - PROBE.windowDays * DAY) as { kind: string; n: number }[];
    const c = { counter: 0, requote: 0, reopen: 0, prompt_leak: 0, rfq: 0 };
    for (const r of rows) if (r.kind in c) c[r.kind as keyof typeof c] = r.n;
    return c;
  }

  groupView(account: string, now: number) {
    const id = this.groupOf(account);
    const g = this.group(id);
    const name = (code: string) => this.account(code)?.name ?? code;
    const h = this.holdLimits(account, now);
    return {
      groupId: id,
      accounts: g?.accounts ?? [account],
      names: (g?.accounts ?? [account]).map(name),
      links: this.links(id).map((l) => ({ a: l.a, aName: name(l.a), b: l.b, bName: name(l.b), via: l.via })),
      confirmedFakes: g?.confirmedFakes ?? 0,
      frozenUntil: g?.frozenUntil && g.frozenUntil > now ? g.frozenUntil : null,
      frozenReason: g?.frozenReason ?? null,
      probes: this.probeCounts(id, now),
      holds: { open: h.open, qty: h.qty, valueInr: h.valueInr, maxOpen: h.maxOpen, maxQty: h.maxQty, maxValueInr: h.maxValueInr, expiries: h.expiries, goodStanding: h.goodStanding },
    };
  }

  /**
   * Records one probe event for the buyer group and freezes the group's discounts when a limit is
   * reached. Returns whether the group is frozen after this event. Re-quotes are found here: an RFQ
   * for an item the group already asked for within the window.
   */
  recordProbe(account: string, rfqId: string | null, kind: 'counter' | 'rfq' | 'reopen' | 'prompt_leak', itemCode: string | null, now: number): { frozen: boolean; newlyFrozen: boolean; counts: ReturnType<Store['probeCounts']> } {
    return this.tx(() => {
      const groupId = this.groupOf(account);
      const wasFrozen = this.frozen(account, now);
      const ins = this.db.prepare('INSERT OR IGNORE INTO probe_events (group_id, account, rfq_id, kind, item_code, at) VALUES (?, ?, ?, ?, ?, ?)');
      if (kind === 'rfq') {
        const earlier = this.db
          .prepare("SELECT COUNT(*) AS n FROM probe_events WHERE group_id = ? AND kind = 'rfq' AND item_code = ? AND at > ? AND rfq_id <> ?")
          .get(groupId, itemCode, now - PROBE.windowDays * DAY, rfqId) as { n: number };
        const added = ins.run(groupId, account, rfqId, 'rfq', itemCode, now).changes === 1;
        if (added && earlier.n > 0) {
          ins.run(groupId, account, rfqId, 'requote', itemCode, now);
          this.audit(now, rfqId ?? '-', 'probe_counted', { kind: 'requote', groupId, itemCode }, { actor: 'rules' });
        }
      } else if (ins.run(groupId, account, rfqId, kind, itemCode, now).changes === 1) {
        // A prompt-leak probe is keyed by the text it came from: the same sentence counts once per RFQ.
        this.audit(now, rfqId ?? '-', 'probe_counted', { kind, groupId, ...(kind !== 'prompt_leak' && { itemCode }) }, { actor: 'rules' });
      }
      const counts = this.probeCounts(groupId, now);
      const hit =
        counts.counter >= PROBE.counters ? 'counters' : counts.requote >= PROBE.requotes ? 'requotes' : counts.reopen >= PROBE.reopens ? 'reopens' : counts.prompt_leak >= PROBE.promptLeaks ? 'prompt_leaks' : null;
      if (hit && !wasFrozen) {
        this.db.prepare('INSERT OR IGNORE INTO buyer_group (group_id, name) VALUES (?, ?)').run(groupId, groupId);
        this.db.prepare('UPDATE buyer_group SET frozen_until = ?, frozen_reason = ? WHERE group_id = ?').run(now + PROBE.freezeDays * DAY, hit, groupId);
        const owner = this.account(account)?.owner ?? null;
        this.audit(now, rfqId ?? '-', 'discounts_frozen', { groupId, reason: hit, counts, until: now + PROBE.freezeDays * DAY, alerted: owner }, { actor: 'rules' });
      }
      return { frozen: wasFrozen || !!hit, newlyFrozen: !wasFrozen && !!hit, counts };
    });
  }

  /** Test and demo helper: another account. It joins the group of every account it shares a GSTIN, PAN, bank account, address or mail domain with (A1). */
  addAccount(a: { code: string; name: string; email: string; gstin: string | null; owner?: string; pan?: string | null; bankAccount?: string | null; address?: string | null }, contractFrom = 'ACC-104', now = DEMO_START): void {
    this.tx(() => {
      const groupId = `GRP-${a.code.replace(/^ACC-/, '')}`;
      this.db.prepare('INSERT OR IGNORE INTO buyer_group (group_id, name) VALUES (?, ?)').run(groupId, a.name);
      this.db
        .prepare('INSERT INTO accounts (code, name, email, owner, payment_terms_days, gstin, group_id, pan, bank_account, address) VALUES (?, ?, ?, ?, 30, ?, ?, ?, ?, ?)')
        .run(a.code, a.name, a.email, a.owner ?? 'Priya N.', a.gstin, groupId, a.pan ?? panOf(a.gstin), a.bankAccount ?? null, a.address ?? null);
      this.db.prepare('INSERT INTO contract_prices SELECT ?, item_code, price FROM contract_prices WHERE account = ?').run(a.code, contractFrom);
      this.relink(now);
    });
  }

  /**
   * A1: links accounts that share a GSTIN, PAN, bank account, delivery address or mail domain (public
   * mail domains never link) into one buyer group. Linked accounts share one group's probe counters,
   * freeze, claim reputation, new-customer rule and hold limits. A group that absorbs another keeps the
   * oldest group id, the later freeze and the sum of confirmed fakes. Returns the groups that merged.
   */
  relink(now: number): string[] {
    const run = () => {
      const rows = this.db.prepare('SELECT code, email, gstin, pan, bank_account, address, group_id FROM accounts ORDER BY code').all() as {
        code: string; email: string; gstin: string | null; pan: string | null; bank_account: string | null; address: string | null; group_id: string | null;
      }[];
      const key = (r: (typeof rows)[number]): [LinkVia, string][] => {
        const domain = r.email.split('@')[1]?.toLowerCase() ?? '';
        return (
          [
            ['gstin', norm(r.gstin)],
            ['pan', norm(r.pan ?? panOf(r.gstin))],
            ['bank_account', norm(r.bank_account)],
            ['address', norm(r.address)],
            ['email_domain', PUBLIC_MAIL.has(domain) ? '' : domain],
          ] as [LinkVia, string][]
        ).filter(([, v]) => v.length >= 4);
      };
      const parent = new Map(rows.map((r) => [r.code, r.code]));
      const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
      const seen = new Map<string, string>();
      this.db.prepare('DELETE FROM account_links').run();
      const link = this.db.prepare('INSERT OR IGNORE INTO account_links (a, b, via) VALUES (?, ?, ?)');
      for (const r of rows) {
        for (const [via, v] of key(r)) {
          const other = seen.get(`${via}:${v}`);
          if (!other) {
            seen.set(`${via}:${v}`, r.code);
            continue;
          }
          link.run(other, r.code, via);
          const [x, y] = [find(other), find(r.code)];
          if (x !== y) parent.set(x < y ? y : x, x < y ? x : y);
        }
      }
      const merged: string[] = [];
      const groupOfRoot = new Map<string, string>();
      for (const row of rows) {
        const r = { ...row, group_id: (this.db.prepare('SELECT group_id FROM accounts WHERE code = ?').get(row.code) as { group_id: string | null }).group_id };
        const root = find(r.code);
        const target = groupOfRoot.get(root) ?? r.group_id ?? `GRP-${r.code.replace(/^ACC-/, '')}`;
        groupOfRoot.set(root, target);
        if (r.group_id && r.group_id !== target) {
          const from = this.db.prepare('SELECT confirmed_fakes, frozen_until, frozen_reason FROM buyer_group WHERE group_id = ?').get(r.group_id) as
            | { confirmed_fakes: number; frozen_until: number | null; frozen_reason: string | null }
            | undefined;
          this.db.prepare('INSERT OR IGNORE INTO buyer_group (group_id, name) VALUES (?, ?)').run(target, target);
          if (from) {
            this.db
              .prepare('UPDATE buyer_group SET confirmed_fakes = confirmed_fakes + ?, frozen_until = MAX(COALESCE(frozen_until, 0), COALESCE(?, 0)), frozen_reason = COALESCE(frozen_reason, ?) WHERE group_id = ?')
              .run(from.confirmed_fakes, from.frozen_until, from.frozen_reason, target);
            this.db.prepare('UPDATE buyer_group SET confirmed_fakes = 0, frozen_until = NULL WHERE group_id = ?').run(r.group_id);
          }
          for (const t of ['probe_events', 'buyer_claim', 'quote_outcomes']) this.db.prepare(`UPDATE ${t} SET group_id = ? WHERE group_id = ?`).run(target, r.group_id);
          this.db.prepare('UPDATE accounts SET group_id = ? WHERE group_id = ?').run(target, r.group_id);
          this.audit(now, '-', 'accounts_linked', { groupId: target, merged: r.group_id, account: r.code }, { actor: 'rules' });
          merged.push(r.group_id);
        } else if (!r.group_id) this.db.prepare('UPDATE accounts SET group_id = ? WHERE code = ?').run(target, r.code);
      }
      this.db.prepare('UPDATE buyer_group SET frozen_until = NULL WHERE frozen_until = 0').run();
      return merged;
    };
    return this.db.inTransaction ? run() : this.tx(run);
  }

  /** Why accounts of one group are linked: each pair and the identifier they share. */
  links(groupId: string): { a: string; b: string; via: LinkVia }[] {
    return this.db
      .prepare('SELECT l.a, l.b, l.via FROM account_links l JOIN accounts x ON x.code = l.a WHERE x.group_id = ? ORDER BY l.a, l.b, l.via')
      .all(groupId) as { a: string; b: string; via: LinkVia }[];
  }

  // ---- Buyer claims and fake-rival alerts (F1, ADVERSARIAL 12) ----

  competitors(partGroup: string): { name: string; gstin: string | null }[] {
    return this.db.prepare('SELECT name, gstin FROM competitors WHERE part_group = ? ORDER BY name').all(partGroup) as { name: string; gstin: string | null }[];
  }

  addClaim(
    c: { rfqId: string; account: string; rival: string | null; rivalGstin: string | null; claimedPrice: number | null; attachmentText: string | null; source: string },
    alert: { level: AlertLevel; signals: Signal[]; findings: unknown[]; thresholdVersion: string },
    now: number,
  ): { claimId: string; alertId: string } {
    return this.tx(() => {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM buyer_claim').get() as { n: number }).n + 1;
      const claimId = `CLM-${String(n).padStart(4, '0')}`;
      const alertId = `ALR-${String(n).padStart(4, '0')}`;
      const hash = c.attachmentText ? createHash('sha256').update(c.attachmentText).digest('hex') : null;
      this.db
        .prepare('INSERT INTO buyer_claim VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(claimId, c.rfqId, this.groupOf(c.account), c.account, c.rival, c.rivalGstin, c.claimedPrice, hash, c.attachmentText, c.source, now);
      this.db.prepare('INSERT INTO claim_alert VALUES (?, ?, ?, ?, ?, ?, ?)').run(alertId, claimId, alert.level, JSON.stringify(alert.signals), JSON.stringify(alert.findings), alert.thresholdVersion, now);
      this.audit(now, c.rfqId, 'claim_recorded', { claimId, rival: c.rival, claimedPrice: c.claimedPrice, attachmentHash: hash, source: c.source, status: 'unverified' }, { actor: 'rules' });
      this.audit(now, c.rfqId, 'alert_raised', { alertId, claimId, level: alert.level, signals: alert.signals.map((s) => ({ id: s.id, weight: s.weight, evidence: s.evidence })), thresholdVersion: alert.thresholdVersion }, { actor: 'rules' });
      return { claimId, alertId };
    });
  }

  claims(where: { rfqId?: string; claimId?: string; alertId?: string } = {}): ClaimRow[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, a.alert_id, a.level, a.signals_json, a.findings_json, a.threshold_version, r.verdict, r.reviewer, r.at AS reviewed_at, v.result, v.channel, v.by AS verified_by, v.at AS verified_at
         FROM buyer_claim c JOIN claim_alert a ON a.claim_id = c.claim_id LEFT JOIN alert_review r ON r.alert_id = a.alert_id LEFT JOIN claim_verification v ON v.claim_id = c.claim_id
         WHERE (? IS NULL OR c.rfq_id = ?) AND (? IS NULL OR c.claim_id = ?) AND (? IS NULL OR a.alert_id = ?) ORDER BY c.created_at, c.claim_id`,
      )
      .all(where.rfqId ?? null, where.rfqId ?? null, where.claimId ?? null, where.claimId ?? null, where.alertId ?? null, where.alertId ?? null) as Record<string, unknown>[];
    return rows.map((r) => ({
      claimId: r.claim_id as string,
      rfqId: r.rfq_id as string,
      groupId: r.group_id as string,
      account: r.account as string,
      rival: (r.rival as string | null) ?? null,
      rivalGstin: (r.rival_gstin as string | null) ?? null,
      claimedPrice: (r.claimed_price as number | null) ?? null,
      attachmentHash: (r.attachment_hash as string | null) ?? null,
      attachmentText: (r.attachment_text as string | null) ?? null,
      source: r.source as string,
      createdAt: r.created_at as number,
      alert: {
        alertId: r.alert_id as string,
        level: r.level as AlertLevel,
        signals: JSON.parse(r.signals_json as string) as Signal[],
        findings: JSON.parse(r.findings_json as string) as { text: string; quote: string; cites: string[] }[],
        thresholdVersion: r.threshold_version as string,
        review: r.verdict ? { verdict: r.verdict as 'correct' | 'wrong', by: r.reviewer as string, at: r.reviewed_at as number } : null,
      },
      verification: r.result ? { result: r.result as 'genuine' | 'fake', channel: r.channel as string, by: r.verified_by as string, at: r.verified_at as number } : null,
      status: r.result ? (r.result as 'genuine' | 'fake') : 'unverified',
    }));
  }

  /** Finance marks an alert Correct or Wrong. Reputation does not change here. */
  reviewAlert(alertId: string, verdict: 'correct' | 'wrong', reviewer: string, now: number): ClaimRow | null {
    return this.tx(() => {
      const c = this.claims({ alertId })[0];
      if (!c) return null;
      // Idempotent: the same verdict again (a double click) changes nothing and logs nothing.
      if (c.alert.review?.verdict === verdict) return c;
      this.db.prepare('INSERT INTO alert_review VALUES (?, ?, ?, ?) ON CONFLICT(alert_id) DO UPDATE SET verdict = excluded.verdict, reviewer = excluded.reviewer, at = excluded.at').run(alertId, verdict, reviewer, now);
      this.audit(now, c.rfqId, 'alert_reviewed', { alertId, claimId: c.claimId, level: c.alert.level, verdict, user: reviewer }, { actor: 'finance' });
      return this.claims({ alertId })[0] ?? null;
    });
  }

  /** Genuine or Fake after independent verification. Only Fake changes the group's reputation. */
  verifyClaim(claimId: string, result: 'genuine' | 'fake', channel: string, by: string, now: number): ClaimRow | null {
    return this.tx(() => {
      const c = this.claims({ claimId })[0];
      if (!c) return null;
      if (c.verification) return c; // recorded once
      this.db.prepare('INSERT INTO claim_verification VALUES (?, ?, ?, ?, ?)').run(claimId, result, channel, by, now);
      if (result === 'fake') this.db.prepare('UPDATE buyer_group SET confirmed_fakes = confirmed_fakes + 1 WHERE group_id = ?').run(c.groupId);
      this.audit(now, c.rfqId, 'claim_verified', { claimId, result, channel, user: by, groupId: c.groupId }, { actor: 'finance' });
      return this.claims({ claimId })[0] ?? null;
    });
  }

  alertMetrics() {
    return alertMetrics(
      this.claims().map((c) => ({ level: c.alert.level, signals: c.alert.signals.map((s) => s.id as SignalId), review: c.alert.review?.verdict ?? null, verification: c.verification?.result ?? null })),
    );
  }

  /** Test helpers. */
  setCountedAt(itemCode: string, at: number, feedLive?: boolean): void {
    this.db.prepare('UPDATE stock SET counted_at = ?, feed_live = COALESCE(?, feed_live) WHERE item_code = ?').run(at, feedLive === undefined ? null : feedLive ? 1 : 0, itemCode);
  }
  setClearance(itemCode: string, on: boolean): void {
    this.db.prepare('UPDATE items SET clearance = ? WHERE item_code = ?').run(on ? 1 : 0, itemCode);
  }
  setItemRules(itemCode: string, r: { unitCost?: number; maxDiscountPct?: number }): void {
    this.db.prepare('UPDATE items SET unit_cost = COALESCE(?, unit_cost), max_discount_pct = COALESCE(?, max_discount_pct) WHERE item_code = ?').run(r.unitCost ?? null, r.maxDiscountPct ?? null, itemCode);
  }
  setContractPrice(account: string, itemCode: string, price: number): void {
    this.db.prepare('UPDATE contract_prices SET price = ? WHERE account = ? AND item_code = ?').run(price, account, itemCode);
  }
}

export interface ClaimRow {
  claimId: string;
  rfqId: string;
  groupId: string;
  account: string;
  rival: string | null;
  rivalGstin: string | null;
  claimedPrice: number | null;
  attachmentHash: string | null;
  attachmentText: string | null;
  source: string;
  createdAt: number;
  alert: {
    alertId: string;
    level: AlertLevel;
    signals: Signal[];
    findings: { text: string; quote: string; cites: string[] }[];
    thresholdVersion: string;
    review: { verdict: 'correct' | 'wrong'; by: string; at: number } | null;
  };
  verification: { result: 'genuine' | 'fake'; channel: string; by: string; at: number } | null;
  status: 'unverified' | 'genuine' | 'fake';
}

const minPriceFor = (i: ItemRules) => Math.round(i.unitCost / (1 - i.minMarginPct / 100));

/** Thrown inside a transaction to roll back a half-placed split reservation. */
class RefusedError extends Error {
  constructor(readonly reason: 'INSUFFICIENT_STOCK') {
    super(reason);
  }
}

export { MIN };
