// Autonomous AI-agent reference for Realmint.
//
// Starting from nothing but its own EVM private key, the agent:
//   1. authenticates keyless (EOA signature → bearer; no API key),
//   2. self-funds in USDC over x402,
//   3. waits for Realmint to bridge the funds to its smart account, and
//   4. buys a tokenized RWA (default: tslax — Tesla xStock on Solana),
//   5. polls the intent to completion.
//
// Everything runs over the public Realmint API + the x402 protocol. Signing is
// done locally with the agent's key (viem) — Realmint never holds keys.
//
// Run:  npm run agent          (full flow; needs the EOA funded with USDC on Base)
//       npm run smoke          (login + quote only; moves no funds)

import { privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { buildXPayment, type PaymentRequirements } from "./x402.js";
import { deriveSolanaWallet, registerSolanaWallet } from "./solana-wallet.js";

const BASE_URL = (process.env.REALMINT_BASE_URL ?? "https://api.realmint.io").replace(/\/+$/, "");
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

async function bundlerRpc(url: string, methodName: string, params: unknown[]) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: methodName, params }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.error) throw new Error(`Bundler: ${json?.error?.message ?? res.status}`);
  return json.result;
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

// ── 2. Self-fund over x402 ─────────────────────────────────────────────────

async function fund(acct: LocalAccount): Promise<void> {
  const params = { owner_eoa: acct.address, amount_usdc: AMOUNT_USDC, asset_id: ASSET_ID };
  const challenge = await http("POST", "/v1/route/x402-buy", { body: params });
  if (challenge.status !== 402) {
    if (challenge.status >= 200 && challenge.status < 300) { console.log("✓ already funded"); return; }
    throw new Error(`expected 402, got ${challenge.status}: ${JSON.stringify(challenge.body)}`);
  }
  const req = (challenge.body.accepts as PaymentRequirements[])[0];
  console.log(`x402 challenge: pay ${req.maxAmountRequired} atomic USDC to ${req.payTo} on ${req.network}`);
  const xPayment = await buildXPayment(req, acct);
  const settled = await http("POST", "/v1/route/x402-buy", { body: params, headers: { "X-PAYMENT": xPayment } });
  if (settled.status !== 200) throw new Error(`x402 settle failed (${settled.status}): ${JSON.stringify(settled.body)}`);
  console.log(`✓ funded ${AMOUNT_USDC} USDC — settle tx ${settled.body.settle_tx}`);
}

// ── 3. Wait for the bridge to land funds on the smart account ────────────────

async function waitForFunds(bearer: string, smartAccount: string, timeoutMs = 30 * 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write("waiting for the cross-chain bridge to land USDC on the smart account");
  while (Date.now() < deadline) {
    const p = await http("GET", `/v1/portfolio/${smartAccount}`, { bearer });
    const total = Number(p.body?.total_usd ?? 0);
    if (total >= AMOUNT_USDC * 0.5) { console.log(`\n✓ funds available: $${total}`); return; }
    process.stdout.write(".");
    await sleep(30_000);
  }
  throw new Error("timed out waiting for the bridge");
}

// ── 4. Buy: create → prepare → sign UserOp → submit → execute → poll ─────────

async function buy(acct: LocalAccount, bearer: string): Promise<void> {
  const asset = await http("GET", `/v1/assets/${encodeURIComponent(ASSET_ID)}`, { bearer });
  const destinationToken = asset.body?.contract_address as string | undefined;

  const status = await http("GET", `/v1/account/status?wallet=${acct.address}`, { bearer });
  if (status.status !== 200) throw new Error(`account status: ${JSON.stringify(status.body)}`);
  const { smart_account, bundler_url, entrypoint_address } = status.body;
  await waitForFunds(bearer, smart_account);

  const created = await http("POST", "/v1/route/intent", {
    bearer,
    body: {
      asset_id: ASSET_ID,
      action: "buy",
      source_token: "USDC",
      amount_in: AMOUNT_USDC,
      agent_wallet: acct.address,
      destination_token: destinationToken,
    },
  });
  if (created.status !== 200) throw new Error(`create intent: ${JSON.stringify(created.body)}`);
  const intentId = created.body.intent_id;
  console.log(`✓ intent ${intentId} — quoted ${created.body.quote?.net_amount_out} ${ASSET_ID}`);

  const prep = await http("POST", `/v1/route/intent/${intentId}/prepare`, { bearer });
  if (!prep.body?.source_user_op || !prep.body?.source_user_op_hash) {
    throw new Error(`prepare returned a non-UserOp lane: ${JSON.stringify(prep.body)}`);
  }
  const signature = await acct.signMessage({ message: { raw: prep.body.source_user_op_hash } });
  const signedUserOp = { ...prep.body.source_user_op, signature };
  const userOpHash = await bundlerRpc(bundler_url, "eth_sendUserOperation", [
    signedUserOp,
    prep.body.entrypoint_address ?? entrypoint_address,
  ]);
  console.log(`✓ source UserOp submitted: ${userOpHash}`);

  // `execute` needs the source tx MINED (else 400 source_tx_not_mined); a UserOp
  // hash is not a tx hash. Wait for inclusion, then execute with the real tx hash
  // before the quote expires.
  const sourceTxHash = await waitForUserOp(bundler_url, userOpHash);
  console.log(`✓ source tx mined: ${sourceTxHash}`);

  await http("POST", `/v1/route/intent/${intentId}/execute`, {
    bearer,
    body: { agent_wallet: acct.address, source_tx_hash: sourceTxHash },
  });

  await pollIntent(bearer, intentId);
}

async function waitForUserOp(bundlerUrl: string, userOpHash: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await bundlerRpc(bundlerUrl, "eth_getUserOperationReceipt", [userOpHash]);
    if (receipt) {
      if (receipt.success === false) throw new Error("source UserOp reverted on-chain");
      return receipt.receipt?.transactionHash ?? userOpHash;
    }
    await sleep(2_000);
  }
  throw new Error(`timed out waiting for UserOp ${userOpHash} to mine`);
}

async function pollIntent(bearer: string, intentId: string, timeoutMs = 10 * 60_000): Promise<void> {
  const terminal = ["completed", "terminal_failed", "expired", "cancelled"];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await http("POST", `/v1/route/intent/${intentId}/reconcile`, { bearer }).catch(() => {});
    const g = await http("GET", `/v1/route/intent/${intentId}`, { bearer });
    const intent = g.body?.intent;
    console.log(`  status: ${intent?.status}`);
    if (terminal.includes(intent?.status)) {
      if (intent.status === "completed") {
        console.log(`✓ DONE — destination tx ${intent.destination_tx_hash}`);
      } else {
        throw new Error(`intent ended ${intent.status}: ${intent.last_error ?? ""}`);
      }
      return;
    }
    await sleep(5_000);
  }
  throw new Error("timed out polling the intent");
}

// ── Entrypoints ──────────────────────────────────────────────────────────────

async function runAgent() {
  const acct = account();
  const bearer = await agentLogin(acct);
  // Register the agent's Realmint Wallet (Solana recipient) — required to buy
  // Solana-settled assets like xStocks. Derived from the EVM key; idempotent.
  const wallet = await deriveSolanaWallet(acct);
  await registerSolanaWallet(BASE_URL, bearer, wallet);
  console.log(`✓ Realmint Wallet registered: ${wallet.address}`);
  await fund(acct);
  await buy(acct, bearer);
}

async function runSmoke() {
  const acct = account();
  const bearer = await agentLogin(acct);
  const asset = await http("GET", `/v1/assets/${encodeURIComponent(ASSET_ID)}`, { bearer });
  const quote = await http("POST", "/v1/route/intent", {
    bearer,
    body: {
      asset_id: ASSET_ID,
      action: "buy",
      quote_only: true,
      source_token: "USDC",
      amount_in: AMOUNT_USDC,
      agent_wallet: acct.address,
      destination_token: asset.body?.contract_address,
    },
  });
  console.log(`✓ quote: ${AMOUNT_USDC} USDC → ${quote.body?.quote?.net_amount_out} ${ASSET_ID} ` +
    `(confidence ${quote.body?.quote?.confidence})`);
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

const cmd = process.argv[2] ?? "agent";
(cmd === "smoke" ? runSmoke() : runAgent()).catch((e) => {
  console.error("ERROR:", e.message ?? e);
  process.exit(1);
});
