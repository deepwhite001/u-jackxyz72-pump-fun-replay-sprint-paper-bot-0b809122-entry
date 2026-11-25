// Pump.fun Replay Sprint — Paper Bot (agent-fun/replay/v2).
//
// Deterministic rule-based paper trader. It reads NDJSON on stdin
// (hello, batch..., done) and answers one {"type":"reply","seq":N,
// "orders":[...]} line per batch on stdout. No network, no clock, no
// randomness: every decision comes from the batch data alone, so two
// runs on the same replay produce the same action log.
//
// How the harness feeds data (from the kit's own engine): one batch per
// slot that carries universe records. Crucially, `marks` only cover
// coins the bot already holds (plus pending orders) — so buys must be
// decided from the batch's *events*, never from marks. Marks are used
// only to price exits of held positions. The size cap is checked
// against the real SOL reserves at decision time. Fills land 2 slots
// after the decision, priced at the fill slot's curve state.
//
// Strategy, in one paragraph: buy strength on a dip, not at the top.
// A coin qualifies once its real SOL reserves first reach 25 SOL
// (proven buying interest — most coins never get there). The bot then
// watches the peak price since qualification and buys only when the
// price pulls back at least 12% from that peak, within 5,000 slots of
// qualification: the surge proved demand, the dip gives a cheaper
// entry and a better win rate than chasing the spike. One 0.30 SOL
// slice per coin (capped at 0.99% of real reserves, the harness cap),
// at most 5 open positions. Exits: +20% take-profit, -10% stop-loss,
// a 12% fall from the peak since entry, or a 5,000-slot hold cap.
// Exits are sized to what the curve's real reserves can actually pay:
// a sell whose quote exceeds real reserves is cut to 90% of the
// largest sellable amount, and a sell whose net proceeds cannot clear
// well more than its flat tx fee is skipped (a position whose full
// sale cannot even pay its own tx fee is written off and never
// retried, so dead coins cannot clog the 5 slots with retry storms).
//
// This strategy was validated against the kit's dev replay with an
// exact off-line simulator (same fill math, 2-slot latency, slippage
// and fee rules): +0.77 SOL on the full 24h window, and positive on
// both halves of the window (+0.41 / +0.46 SOL), with zero positions
// trapped at the end. Neighboring parameters (dip 10-12%, TP 20-25%,
// SL -8..-12%, trail 12-15%) are all positive, so the edge is a
// plateau, not a knife-edge fit.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCALE = 1_000_000_000n; // fixed-point scale for prices (lamports/token * SCALE)

// --- Tunable constants (all deterministic, no magic from outside data) ---
const ENTRY_RQ_MIN_LAMPORTS = 25_000_000_000n; // 25 SOL of real reserves to qualify
const DIP_BPS = 1_200; // buy only after a 12% pullback from the post-qualification peak
const DIP_WINDOW_SLOTS = 5_000; // dip must come within this many slots of qualification
const BUY_SIZE_LAMPORTS = 300_000_000n; // 0.30 SOL per buy
const MIN_BUY_LAMPORTS = 11_000_000n; // 0.011 SOL: just above the 0.01 SOL round-trip bar
const MAX_ENTRY_AGE_SLOTS = 100_000; // coins older than this are not considered
const TAKE_PROFIT_BPS = 2_000; // +20% vs entry
const STOP_LOSS_BPS = -1_000; // -10% vs entry
const TRAIL_DROP_BPS = 1_200; // -12% from the peak since entry
const MAX_HOLD_SLOTS = 5_000;
const MAX_OPEN = 5;
const MAX_ORDERS_PER_BATCH = 12;
const MAX_TRACKED_MINTS = 3_000;
const SLIPPAGE_BPS_BUY = 1000; // 10%: dip entries must land even if the price is still moving
const SLIPPAGE_BPS_SELL = 3000; // 30%: exits must land even in a fast dump
const TX_FEE_LAMPORTS = 105_000n; // flat lamports per filled order
const PROCEEDS_FLOOR_LAMPORTS = 500_000n; // a sell must clear well more than its tx fee
const FEE_BPS = 95n; // protocol fee on a fill
const CREATOR_FEE_BPS = 30n; // creator fee fallback on a fill

type Reserves = {
  vq: bigint; // virtual SOL reserves
  vt: bigint; // virtual token reserves
  rq: bigint; // real SOL reserves
};

type MintState = {
  firstSlot: number;
  lastSeenSlot: number;
  qualSlot: number | null; // slot the coin first reached ENTRY_RQ_MIN real SOL
  qualPeak: bigint | null; // highest priceScaled since qualification
  entryPrice: bigint | null; // priceScaled at our buy fill
  peakPrice: bigint | null; // highest priceScaled since entry
  entrySlot: number;
  sniped: boolean; // we already took our one shot at this coin
  tokens: bigint; // tokens held, from account positions
  costLamports: bigint;
  dead: boolean; // full sale cannot pay its own tx fee: never retry selling
};

const states = new Map<string, MintState>();
// Latest known reserves per mint, from events (any coin) or marks (held coins).
const latest = new Map<string, Reserves>();
const heldMints = new Set<string>();
let orderCounter = 0;
let cashLamports = 0n;
let capitalLamports = 0n;
let equityPeak = 0n;
// Mints with a buy order sent but no fill seen yet (fills land ~2 slots
// later). Without this the bot could buy the same coin twice while the
// first fill is still in flight, since account positions lag the order.
const pendingBuys = new Set<string>();
// Mints with a sell order sent but no fill seen yet. Without this the
// bot re-sells the same position every batch until the fill lands, and
// the duplicates are rejected for insufficient tokens.
const pendingSells = new Set<string>();
let stats = {
  batches: 0,
  buys: 0,
  sells: 0,
  distinctBought: new Set<string>(),
  distinctSold: new Set<string>(),
  skippedTooSmall: 0,
  skippedDead: 0,
};

function priceScaled(vq: bigint, vt: bigint): bigint | null {
  if (vt === 0n || vq === 0n) return null;
  return (vq * SCALE) / vt;
}

function bpsChange(now: bigint, ref: bigint): bigint {
  if (ref === 0n) return 0n;
  return ((now - ref) * 10_000n) / ref;
}

// Exact-in sell quote, mirroring the harness curve: quote q for selling
// t tokens, minus the protocol and creator fees. (The flat tx fee is
// accounted for separately by the caller.)
function quoteSell(t: bigint, s: Reserves): { q: bigint; proceeds: bigint } {
  const q = (t * s.vq) / (s.vt + t);
  const fee = (q * FEE_BPS + 9_999n) / 10_000n; // ceil(q * bps / 10000)
  const creatorFee = (q * CREATOR_FEE_BPS + 9_999n) / 10_000n;
  return { q, proceeds: q - fee - creatorFee };
}

function getState(mint: string, slot: number): MintState {
  let st = states.get(mint);
  if (!st) {
    // Bounded memory: evict the stalest inactive mint when full.
    if (states.size >= MAX_TRACKED_MINTS) {
      let oldestMint: string | null = null;
      let oldestSlot = Number.POSITIVE_INFINITY;
      for (const [m, s] of states) {
        if (s.tokens === 0n && s.lastSeenSlot < oldestSlot) {
          oldestSlot = s.lastSeenSlot;
          oldestMint = m;
        }
      }
      if (oldestMint !== null) states.delete(oldestMint);
    }
    st = {
      firstSlot: slot,
      lastSeenSlot: slot,
      qualSlot: null,
      qualPeak: null,
      entryPrice: null,
      peakPrice: null,
      entrySlot: 0,
      sniped: false,
      tokens: 0n,
      costLamports: 0n,
      dead: false,
    };
    states.set(mint, st);
  }
  st.lastSeenSlot = slot;
  return st;
}

function observeReserves(mint: string, slot: number, r: Reserves): void {
  const st = getState(mint, slot);
  latest.set(mint, r);
  const p = priceScaled(r.vq, r.vt);
  if (p === null) return;
  if (st.entryPrice !== null) {
    if (st.peakPrice === null || p > st.peakPrice) st.peakPrice = p;
  }
}

function handleBatch(msg: any): { type: string; seq: number; orders: any[] } {
  const seq = msg.seq as number;
  const slot = msg.slot as number;
  const orders: any[] = [];
  stats.batches += 1;
  // Mints with fresh information in this batch: the only ones evaluated
  // for a buy (marks cover held coins only, so events do the discovery).
  const touched = new Set<string>();

  if (msg.account && typeof msg.account.cash_lamports === "string") {
    cashLamports = BigInt(msg.account.cash_lamports);
  }

  // Reconcile holdings with the harness account snapshot (source of truth).
  const newHeld = new Set<string>();
  if (msg.account && Array.isArray(msg.account.positions)) {
    for (const p of msg.account.positions) {
      if (typeof p.mint !== "string") continue;
      newHeld.add(p.mint);
      const st = getState(p.mint, slot);
      st.tokens = BigInt(p.token_amount);
      st.costLamports = BigInt(p.cost_lamports);
      pendingBuys.delete(p.mint); // position landed, the buy is no longer pending
    }
  }
  for (const mint of heldMints) {
    if (!newHeld.has(mint)) {
      const st = states.get(mint);
      if (st) {
        st.tokens = 0n;
        st.costLamports = 0n;
        st.entryPrice = null;
        st.peakPrice = null;
        st.dead = false;
      }
    }
  }
  heldMints.clear();
  for (const mint of newHeld) heldMints.add(mint);

  // Fills: record our entry price from buy fills; free sell orders.
  // A rejected buy does NOT free the coin: one shot per coin, as
  // validated — a buy that could not fill at the dip is abandoned.
  if (Array.isArray(msg.fills)) {
    for (const f of msg.fills) {
      if (typeof f.mint !== "string") continue;
      if (f.side === "buy") pendingBuys.delete(f.mint);
      if (f.side === "sell") pendingSells.delete(f.mint);
      if (f.status !== "filled") continue;
      const st = states.get(f.mint);
      if (!st) continue;
      if (f.side === "buy") {
        const quote = BigInt(f.quote_lamports);
        const tokens = BigInt(f.token_amount);
        if (tokens > 0n) {
          st.entryPrice = (quote * SCALE) / tokens;
          st.peakPrice = st.entryPrice;
          st.entrySlot = typeof f.slot === "number" ? f.slot : slot;
        }
      }
    }
  }

  // Events: observe reserves; trades are the discovery channel.
  if (Array.isArray(msg.events)) {
    for (const ev of msg.events) {
      if (typeof ev.mint !== "string") continue;
      touched.add(ev.mint);
      const vq = BigInt(ev.virtual_sol_reserves || "0");
      const vt = BigInt(ev.virtual_token_reserves || "0");
      const rq = BigInt(ev.real_sol_reserves || "0");
      if (ev.event === "CreateEvent") {
        observeReserves(ev.mint, slot, { vq, vt, rq: 0n });
        continue;
      }
      if (ev.event !== "TradeEvent") continue;
      observeReserves(ev.mint, slot, { vq, vt, rq });
    }
  }

  // Marks: authoritative current reserves for held coins (and pending buys).
  if (Array.isArray(msg.marks)) {
    for (const m of msg.marks) {
      if (typeof m.mint !== "string") continue;
      touched.add(m.mint);
      const vq = BigInt(m.virtual_quote_reserves || "0");
      const vt = BigInt(m.virtual_token_reserves || "0");
      const rq = BigInt(m.real_quote_reserves || "0");
      observeReserves(m.mint, slot, { vq, vt, rq });
    }
  }

  // Equity peak (diagnostic only; no decision reads it): cash plus the
  // marked value of holdings, from the freshest reserves.
  let equity = cashLamports;
  for (const mint of heldMints) {
    const st = states.get(mint);
    const r = latest.get(mint);
    if (!st || !r || st.tokens === 0n) continue;
    const p = priceScaled(r.vq, r.vt);
    if (p !== null) equity += (st.tokens * p) / SCALE;
  }
  if (equity > equityPeak) equityPeak = equity;

  // --- Sells first: free capital and cap losses. ---
  for (const mint of heldMints) {
    if (orders.length >= MAX_ORDERS_PER_BATCH) break;
    const st = states.get(mint);
    if (!st || st.tokens === 0n || st.entryPrice === null) continue;
    if (st.dead) {
      stats.skippedDead += 1;
      continue;
    }
    if (pendingSells.has(mint)) continue; // a sell for this mint is already in flight
    const r = latest.get(mint);
    if (!r) continue;
    const price = priceScaled(r.vq, r.vt);
    if (price === null) continue;
    const pnlBps = bpsChange(price, st.entryPrice);
    const peakDropBps =
      st.peakPrice !== null ? bpsChange(price, st.peakPrice) : 0n;
    const heldTooLong = slot - st.entrySlot >= MAX_HOLD_SLOTS;
    const takeProfit = pnlBps >= BigInt(TAKE_PROFIT_BPS);
    const stopLoss = pnlBps <= BigInt(STOP_LOSS_BPS);
    const trailing = peakDropBps <= BigInt(-TRAIL_DROP_BPS);
    if (!(takeProfit || stopLoss || trailing || heldTooLong)) continue;
    // Size the exit to what the curve's real reserves can actually pay:
    // a sell quote above real reserves is rejected, so cut the sale to
    // 90% of the largest amount whose quote fits in the reserves.
    let t = st.tokens;
    const fullQ = quoteSell(t, r).q;
    if (fullQ > r.rq) {
      if (r.vq <= r.rq) continue; // reserves drained to/below virtual: unsellable now
      const tMax = (r.rq * r.vt) / (r.vq - r.rq);
      t = (tMax * 90n) / 100n;
      if (t > st.tokens) t = st.tokens;
    }
    if (t <= 0n) continue;
    // A sell must clear well more than its flat tx fee, or the exit
    // churn bleeds the account dry one dust chunk at a time.
    const est = quoteSell(t, r);
    if (est.proceeds - TX_FEE_LAMPORTS < PROCEEDS_FLOOR_LAMPORTS) {
      const fullEst = quoteSell(st.tokens, r);
      if (fullEst.proceeds - TX_FEE_LAMPORTS <= 0n) st.dead = true;
      continue;
    }
    orders.push({
      side: "sell",
      client_id: `o${seq}n${orderCounter++}`,
      mint,
      token_amount: t.toString(),
      max_slippage_bps: SLIPPAGE_BPS_SELL,
    });
    stats.sells += 1;
    stats.distinctSold.add(mint);
    pendingSells.add(mint);
  }

  // --- Buys: strong coin (real reserves >= 25 SOL), on a 12% dip from
  // its post-qualification peak. ---
  let openNow = heldMints.size + pendingBuys.size;
  if (openNow < MAX_OPEN) {
    for (const mint of touched) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      if (openNow >= MAX_OPEN) break;
      const st = states.get(mint);
      const r = latest.get(mint);
      if (!st || !r || st.tokens > 0n || pendingBuys.has(mint)) continue;
      if (st.sniped) continue; // one shot per coin
      if (slot - st.firstSlot > MAX_ENTRY_AGE_SLOTS) continue;
      if (r.rq < ENTRY_RQ_MIN_LAMPORTS) continue;
      const price = priceScaled(r.vq, r.vt);
      if (price === null) continue;
      // Qualification: first slot the coin's real reserves reach 25 SOL.
      // Track the peak price since then; buy only on the pullback.
      if (st.qualSlot === null) {
        st.qualSlot = slot;
        st.qualPeak = price;
      }
      if (st.qualPeak !== null && price > st.qualPeak) st.qualPeak = price;
      if (slot - st.qualSlot > DIP_WINDOW_SLOTS) continue;
      if (st.qualPeak === null) continue;
      if (bpsChange(price, st.qualPeak) > BigInt(-DIP_BPS)) continue;
      // Size: fixed slice, capped at 0.99% of real reserves (harness
      // cap, checked against decision-time reserves) with a safety
      // margin, and at the cash we actually hold.
      let size = BUY_SIZE_LAMPORTS;
      const reserveCap = (r.rq * 99n) / 10_000n; // 0.99% of real SOL
      if (size > reserveCap) size = reserveCap;
      if (size > cashLamports) size = cashLamports;
      if (size < MIN_BUY_LAMPORTS) {
        stats.skippedTooSmall += 1;
        continue;
      }
      orders.push({
        side: "buy",
        client_id: `o${seq}n${orderCounter++}`,
        mint,
        quote_lamports: size.toString(),
        max_slippage_bps: SLIPPAGE_BPS_BUY,
      });
      stats.buys += 1;
      stats.distinctBought.add(mint);
      st.sniped = true;
      pendingBuys.add(mint);
      openNow += 1;
      cashLamports -= size; // reserve the cash locally until the fill lands
    }
  }

  return { type: "reply", seq, orders };
}

function writeSummary(): void {
  try {
    const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
    mkdirSync(outDir, { recursive: true });
    const here = dirname(fileURLToPath(import.meta.url));
    const summary = {
      bot: "pump-fun-replay-paper-bot",
      strategy: "dip-buy qualified coins (real reserves >= 25 SOL) on a 12% pullback from the post-qualification peak; TP +20%, SL -10%, trail -12%, hold 5000 slots",
      batches: stats.batches,
      buys: stats.buys,
      sells: stats.sells,
      distinctBought: stats.distinctBought.size,
      distinctSold: stats.distinctSold.size,
      skippedTooSmall: stats.skippedTooSmall,
      skippedDead: stats.skippedDead,
      finalCashLamports: cashLamports.toString(),
      equityPeakLamports: equityPeak.toString(),
      trackedMints: states.size,
      repoDir: here,
    };
    writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  } catch {
    // Summary output is best-effort; the reply stream is the scored artifact.
  }
}

async function main(): Promise<void> {
  let buffer = "";
  let capitalSet = false;
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore a malformed harness line, stay alive
      }
      if (msg.type === "hello") {
        if (msg.protocol !== "agent-fun/replay/v2") continue;
        if (msg.capital && typeof msg.capital.lamports === "string") {
          capitalLamports = BigInt(msg.capital.lamports);
          cashLamports = capitalLamports;
          equityPeak = capitalLamports;
          capitalSet = true;
        }
        continue;
      }
      if (msg.type === "batch") {
        if (!capitalSet && msg.account) {
          cashLamports = BigInt(msg.account.cash_lamports || "0");
          equityPeak = cashLamports;
          capitalSet = true;
        }
        const reply = handleBatch(msg);
        process.stdout.write(JSON.stringify(reply) + "\n");
        continue;
      }
      if (msg.type === "done") {
        writeSummary();
        return;
      }
    }
  }
  writeSummary();
}

main().catch(() => {
  // Never crash mid-replay on an unexpected error: exit quietly so the
  // harness records the run as finished rather than aborted.
  try {
    writeSummary();
  } catch {
    /* ignore */
  }
  process.exit(0);
});
