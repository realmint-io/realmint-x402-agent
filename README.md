# Realmint x402 agent

An autonomous AI-agent reference for [Realmint](https://realmint.io): starting
from nothing but its own EVM key, an agent **authenticates keyless**, **pays USDC
over [x402](https://x402.org)** to **buy a tokenized RWA delivered to its own
wallet**, and can **sell it back to USDC** — no browser, no human signer, no API
key, self-custodial throughout. Node + TypeScript + viem.

This is the headless sibling of
[`realmint-sdk-example`](https://github.com/realmint-io/realmint-sdk-example)
(a wallet UI built on [`@realmint/sdk`](https://www.npmjs.com/package/@realmint/sdk)).
Here everything is over the raw HTTP API + x402, so it works in any agent runtime.

## Buy — pay USDC, receive the RWA

```
EOA key ─▶ keyless auth ─▶ register Solana wallet ─▶ x402 pay ─▶ poll order ─▶ asset in wallet
          (sign challenge)   (derive + prove)         (EIP-3009)  (bridge+buy+deliver, automatic)
```

1. **Keyless auth** — `POST /v1/agent/auth/challenge` → `personal_sign` →
   `POST /v1/agent/auth/token` → a bearer whose subject is the agent's canonical
   DID `agent:<eoa>`. No API key.
2. **Register the Realmint Wallet (Solana)** — the delivery address for
   Solana-settled assets (xStocks). Derive an ed25519 key from the EVM key
   (Option A; [`src/solana-wallet.ts`](src/solana-wallet.ts)) and prove control:
   `GET /v1/agent/solana-wallet/challenge` → sign → `POST /v1/agent/solana-wallet`.
   The seed never leaves the process.
3. **Pay over x402** — `POST /v1/route/x402-buy { owner_eoa, amount_usdc,
   asset_id }` returns a `402` with payment requirements; the agent signs a USDC
   EIP-3009 `transferWithAuthorization` ([`src/x402.ts`](src/x402.ts)) and retries
   with the `X-PAYMENT` header. Realmint then **bridges, buys, and delivers** the
   asset to the agent's wallet — one paid call.
4. **Poll** — `GET /v1/x402/order/:id` → `funded → bridged → buying → completed`
   with the Solana `asset_tx`. Self-custodial: the asset lands in the agent's own
   wallet; Realmint never custodies it.

## Sell — RWA back to USDC

```
create sell ─▶ prepare wire ─▶ co-sign (1 Solana sig) ─▶ submit ─▶ poll
(commit)       (relayer pre-signs)  (agent's key)         (broadcast) (USDC on Injective)
```

`POST /v1/route/intent { action: "sell", destination_chain_id: 0, … }` →
`POST /v1/route/intent/:id/solana-sell/prepare` returns a base64 V0 wire
partial-signed by the relayer → the agent co-signs it with its Realmint Wallet
([`signSolanaWire`](src/solana-wallet.ts)) → `…/solana-sell/submit` broadcasts.
Gas is relayer-sponsored; USDC settles back on the agent's Injective smart
account. (Minimum sell: $4.20 of value.)

## Run

```bash
cp .env.example .env      # set AGENT_PRIVATE_KEY
npm install

# Fund the agent's address with ~5 USDC on Base (chain 8453). No ETH needed —
# x402's EIP-3009 transfer is gasless for the signer.

npm run buy               # pay USDC over x402 → RWA delivered to the agent wallet
npm run sell              # sell the held RWA back to USDC
npm run smoke             # login + quote only (moves no funds)
```

Override with `AMOUNT_USDC`, `ASSET_ID` (default `tslax`, Tesla xStock on
Solana), `SELL_AMOUNT` (asset units; defaults to the full wallet balance), and
`SOLANA_RPC`.

## Using the SDK instead

For a higher-level client, [`@realmint/sdk`](https://www.npmjs.com/package/@realmint/sdk)
wraps the same flows (`agentLogin`, `x402Buy`, `sellSolana`).

## Safety

The agent's keys sign everything locally; Realmint never holds them and never
custodies funds — the asset is delivered to, and sold from, the agent's own
wallet. The keyless bearer only authorizes the EOA's **own** accounts. Use a
dedicated key with a capped balance for agents.
