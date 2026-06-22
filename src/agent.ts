// Autonomous AI-agent reference for Realmint — BUY and SELL tokenized RWAs.
//
// Starting from nothing but its own EVM private key, the agent:
//   1. authenticates keyless (EOA signature → bearer; no API key),
//   2. derives + registers its Realmint Wallet (Solana recipient),
//   3. BUY:  pays USDC over x402 and receives the RWA in its own wallet
//            (one call — Realmint bridges + buys + delivers; the agent polls),
//   4. SELL: sells the RWA back to USDC (one Solana signature; gas sponsored).
//
// Everything runs over the public Realmint API + the x402 protocol. Signing is
// done locally with the agent's key — Realmint never holds keys, never custodies
// funds (the asset lands in, and is sold from, the agent's own wallet).
//
// Run:  npm run buy            (x402 → RWA delivered; needs USDC on Base)
//       npm run sell           (RWA → USDC back on Injective)
//       npm run smoke          (login + quote only; moves no funds)

import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { buildXPayment, type PaymentRequirements } from "./x402.js";
import { deriveSolanaWallet, registerSolanaWallet, signSolanaWire } from "./solana-wallet.js";

const BASE_URL = (process.env.REALMINT_BASE_URL ?? "https://api.realmint.io").replace(/\/+$/, "");
const SOLANA_RPC = process.env.SOLANA_RPC ?? "https://api.mainnet-beta.solana.com";
const AMOUNT_USDC = Number(process.env.AMOUNT_USDC ?? 5);
const ASSET_ID = process.env.ASSET_ID ?? "tslax";

function account(): LocalAccount {
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk) throw new Error("Set AGENT_PRIVATE_KEY (0x…) in the environment / .env");
  return privateKeyToAccount(pk as `0x${string}`);
}

// ── Minimal HTTP ───────────────────────────────────────────────────────────

async function http(method: string, path: string, opts: { bearer?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

// ── 1. Keyless auth ──────────────────────────────────────────────────────────

async function agentLogin(acct: LocalAccount): Promise<string> {
  const ch = await http("POST", "/v1/agent/auth/challenge", { body: { owner_eoa: acct.address } });
  if (ch.status !== 200) throw new Error(`challenge failed: ${JSON.stringify(ch.body)}`);
  const signature = await acct.signMessage({ message: ch.body.message });
  const tok = await http("POST", "/v1/agent/auth/token", {
    body: { challenge_token: ch.body.challenge_token, signature },
  });
  if (tok.status !== 200) throw new Error(`token failed: ${JSON.stringify(tok.body)}`);
  console.log(`✓ authenticated keyless as ${acct.address}`);
  return tok.body.access_token as string;
}

// ── 2. BUY: pay USDC over x402 → receive the RWA in your own wallet ───────────
//
// One x402 settlement funds the agent's smart account; Realmint then bridges,
// buys, and delivers the asset to the agent's registered Solana wallet. The
// agent polls the order until the asset lands. Self-custodial throughout.

async function runBuy() {
  const acct = account();
  const bearer = await agentLogin(acct);

  // The Solana-settled asset needs a delivery address: the agent's Realmint
  // Wallet, derived from the EVM key and registered (idempotent).
  const wallet = await deriveSolanaWallet(acct);
  await registerSolanaWallet(BASE_URL, bearer, wallet);
  console.log(`✓ Realmint Wallet: ${wallet.address}`);

  const params = { owner_eoa: acct.address, amount_usdc: AMOUNT_USDC, asset_id: ASSET_ID };
  const challenge = await http("POST", "/v1/route/x402-buy", { body: params });
  if (challenge.status !== 402) {
    throw new Error(`expected a 402 x402 challenge, got ${challenge.status}: ${JSON.stringify(challenge.body)}`);
  }
  const req = (challenge.body.accepts as PaymentRequirements[])[0];
  console.log(`x402 challenge: pay ${req.maxAmountRequired} atomic USDC on ${req.network}`);
  const xPayment = await buildXPayment(req, acct);
  const settled = await http("POST", "/v1/route/x402-buy", { body: params, headers: { "X-PAYMENT": xPayment } });
  if (settled.status !== 200) throw new Error(`x402 settle failed (${settled.status}): ${JSON.stringify(settled.body)}`);
  const orderId = settled.body.order_id;
  console.log(`✓ paid ${AMOUNT_USDC} USDC — order ${orderId}; bridging + buying + delivering…`);

  // Poll the order: funded → bridged → buying → completed (asset delivered).
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const o = await http("GET", `/v1/x402/order/${orderId}`, { bearer });
    const b = o.body ?? {};
    console.log(`  funded=${b.funded} bridged=${b.bridged} buying=${b.buying} completed=${b.completed}` +
      `${b.intent_status ? ` (${b.intent_status})` : ""}`);
    if (b.completed) { console.log(`✓✓ ${ASSET_ID} delivered to ${wallet.address} — asset tx ${b.asset_tx}`); return; }
    if (b.error) throw new Error(`order failed: ${b.error}`);
    await sleep(30_000);
  }
  throw new Error("timed out waiting for delivery");
}

// ── 3. SELL: RWA → USDC (one Solana signature; gas relayer-sponsored) ─────────

async function runSell() {
  const acct = account();
  const bearer = await agentLogin(acct);
  const wallet = await deriveSolanaWallet(acct);
  // Ensure the wallet is on file (idempotent) so the server resolves the seller.
  await registerSolanaWallet(BASE_URL, bearer, wallet);

  // Resolve the asset mint, then read how much the wallet holds (sell it all,
  // or override with SELL_AMOUNT).
  const asset = await http("GET", `/v1/assets/${encodeURIComponent(ASSET_ID)}`, { bearer });
  const mint = asset.body?.contract_address as string;
  if (!mint) throw new Error(`no Solana mint for ${ASSET_ID}`);
  const amount = process.env.SELL_AMOUNT
    ? Number(process.env.SELL_AMOUNT)
    : await splBalance(wallet.address, mint);
  if (!amount || amount <= 0) throw new Error(`no ${ASSET_ID} balance to sell in ${wallet.address}`);
  console.log(`selling ${amount} ${ASSET_ID} from ${wallet.address}`);

  // create (commit) → prepare wire → co-sign → submit → poll. destination_chain_id
  // 0 selects the Solana sell lane (USDC settles back on Injective).
  const created = await http("POST", "/v1/route/intent", {
    bearer,
    body: { asset_id: ASSET_ID, action: "sell", source_token: "USDC", amount_in: amount, agent_wallet: acct.address, destination_chain_id: 0 },
  });
  if (created.status >= 400) throw new Error(`create sell: ${JSON.stringify(created.body)}`);
  const intentId = created.body.intent_id;
  console.log(`✓ sell intent ${intentId}`);

  const prep = await http("POST", `/v1/route/intent/${intentId}/solana-sell/prepare`, { bearer });
  if (prep.status !== 200 || !prep.body?.transaction) throw new Error(`prepare: ${JSON.stringify(prep.body)}`);
  const signed = signSolanaWire(prep.body.transaction, wallet.seed);
  const submit = await http("POST", `/v1/route/intent/${intentId}/solana-sell/submit`, {
    bearer, body: { transaction: signed },
  });
  if (submit.status !== 200) throw new Error(`submit: ${JSON.stringify(submit.body)}`);
  console.log(`✓ source executed — Solana tx ${submit.body.signature}; bridging USDC back to Injective…`);

  await pollIntent(bearer, intentId);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Read an SPL token uiAmount for `owner` + `mint` via a public Solana RPC. */
async function splBalance(owner: string, mint: string): Promise<number> {
  const res = await fetch(SOLANA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { mint }, { encoding: "jsonParsed" }] }),
  });
  const j = await res.json().catch(() => null);
  const acc = j?.result?.value?.[0];
  return acc ? Number(acc.account.data.parsed.info.tokenAmount.uiAmountString) : 0;
}

async function pollIntent(bearer: string, intentId: string, timeoutMs = 20 * 60_000): Promise<void> {
  const terminal = ["completed", "terminal_failed", "expired", "cancelled", "recoverable_failed"];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const g = await http("GET", `/v1/route/intent/${intentId}`, { bearer });
    const intent = g.body?.intent;
    console.log(`  status: ${intent?.status}`);
    if (terminal.includes(intent?.status)) {
      if (intent.status === "completed") { console.log(`✓✓ DONE — USDC back on Injective (tx ${intent.destination_tx_hash})`); return; }
      throw new Error(`intent ended ${intent.status}: ${intent.last_error ?? ""}`);
    }
    await sleep(15_000);
  }
  throw new Error("timed out polling the intent");
}

async function runSmoke() {
  const acct = account();
  const bearer = await agentLogin(acct);
  const asset = await http("GET", `/v1/assets/${encodeURIComponent(ASSET_ID)}`, { bearer });
  const quote = await http("POST", "/v1/route/intent", {
    bearer,
    body: { asset_id: ASSET_ID, action: "buy", quote_only: true, source_token: "USDC", amount_in: AMOUNT_USDC, agent_wallet: acct.address, destination_token: asset.body?.contract_address },
  });
  console.log(`✓ quote: ${AMOUNT_USDC} USDC → ${quote.body?.quote?.net_amount_out} ${ASSET_ID} (confidence ${quote.body?.quote?.confidence})`);
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const cmd = process.argv[2] ?? "buy";
const run = cmd === "sell" ? runSell : cmd === "smoke" ? runSmoke : runBuy;
run().catch((e) => { console.error("ERROR:", e.message ?? e); process.exit(1); });
