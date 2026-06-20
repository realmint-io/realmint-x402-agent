# Realmint x402 agent

An autonomous AI-agent reference for [Realmint](https://realmint.io): starting
from nothing but its own EVM key, an agent **authenticates keyless**, **self-funds
in USDC over [x402](https://x402.org)**, and **buys a tokenized RWA** — no
browser, no human signer, no API key. Node + TypeScript + viem.

This is the headless sibling of
[`realmint-sdk-example`](https://github.com/realmint-io/realmint-sdk-example)
(a wallet UI built on [`@realmint/sdk`](https://www.npmjs.com/package/@realmint/sdk)).
Here everything is over the raw HTTP API + x402, so it works in any agent runtime.

## The loop

```
EOA key ─▶ keyless auth ─▶ register Solana wallet ─▶ x402 self-fund ─▶ bridge ─▶ buy ─▶ poll
          (sign challenge)   (derive + prove)         (sign EIP-3009)  (auto)   (sign UserOp)
```

1. **Keyless auth** — `POST /v1/agent/auth/challenge` → sign the message
   (`personal_sign`) → `POST /v1/agent/auth/token` → a bearer scoped to the EOA.
   No API key.
2. **Register the Realmint Wallet (Solana)** — only for Solana-settled assets
   (xStocks). Derive an ed25519 key from the EVM key (Option A; see
   [`src/solana-wallet.ts`](src/solana-wallet.ts)), then
   `GET /v1/agent/solana-wallet/challenge` → sign → `POST /v1/agent/solana-wallet`.
3. **Self-fund over x402** — `POST /v1/route/x402-buy` returns a `402` with
   payment requirements; the agent signs a USDC EIP-3009 `transferWithAuthorization`
   (see [`src/x402.ts`](src/x402.ts)) and retries with the `X-PAYMENT` header.
   Realmint settles it via the Coinbase facilitator.
4. **Bridge** — Realmint bridges the USDC to the agent's smart account
   (CCTP, native USDC). Fully automatic; the agent just polls its portfolio.
5. **Buy** — create → prepare → sign the ERC-4337 UserOp → **wait for it to
   mine** → execute → poll to completion. The agent signs the UserOp with its
   own key; the Solana destination swap is relayer/session-key driven.

## Run

```bash
cp .env.example .env      # set AGENT_PRIVATE_KEY
npm install

# Fund the agent's address with ~5 USDC on Base (chain 8453). No ETH needed —
# x402's EIP-3009 transfer is gasless for the signer.

npm run agent             # full autonomous flow
npm run smoke             # login + quote only (moves no funds)
```

Override the target with `AMOUNT_USDC` and `ASSET_ID` (default `tslax`, Tesla
xStock on Solana).

## Using the SDK instead

For a higher-level client, [`@realmint/sdk`](https://www.npmjs.com/package/@realmint/sdk)
wraps the same flow:

```ts
import { agentLogin, fundWithX402, signerFromViemAccount } from "@realmint/sdk";

const { client } = await agentLogin({
  ownerEoa: account.address,
  signMessage: (m) => account.signMessage({ message: m }),
});
await fundWithX402(client, { owner_eoa: account.address, amount_usdc: 5, asset_id: "tslax" }, payX402);
await client.buy(
  { asset_id: "tslax", source_token: "USDC", amount_in: 5, agent_wallet: account.address },
  signerFromViemAccount(account),
);
```

## Safety

The agent's key signs everything locally; Realmint never holds it. The keyless
bearer only authorizes quoting and creating intents for the EOA's **own** smart
accounts — moving funds still requires the EOA's UserOp signature, so a leaked
bearer cannot spend. Use a dedicated key with a capped balance for agents.
