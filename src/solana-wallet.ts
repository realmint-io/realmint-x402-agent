// Realmint Wallet (Option A) — derive the agent's Solana recipient from its EVM
// key, and register it so it can buy Solana-settled assets (xStocks).
//
// Derivation (byte-identical to the web client):
//   sig  = personal_sign(CANONICAL)        // deterministic (RFC6979)
//   seed = keccak256(sig)                   // 32-byte ed25519 seed
//   key  = ed25519 keypair from seed        // the Solana wallet
// The seed never leaves the process; the server only sees a control proof.

import type { LocalAccount } from "viem";
import { keccak256, hexToBytes } from "viem";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

export const REALMINT_WALLET_CANONICAL_MESSAGE =
  "Realmint Wallet — key v1\n" +
  "Sign to unlock your Realmint Wallet.\n" +
  "This only proves it's you — it never moves funds, sends a transaction, or costs gas.";

export interface SolanaWallet {
  address: string; // base58
  seed: Uint8Array; // 32-byte ed25519 seed (keep local)
  sign: (message: Uint8Array) => Uint8Array;
}

/** Derive the agent's Realmint Solana wallet from its EVM account. */
export async function deriveSolanaWallet(account: LocalAccount): Promise<SolanaWallet> {
  const sig = await account.signMessage({ message: REALMINT_WALLET_CANONICAL_MESSAGE });
  const seed = hexToBytes(keccak256(hexToBytes(sig))); // 32 bytes
  const address = bs58.encode(ed25519.getPublicKey(seed));
  return { address, seed, sign: (m) => ed25519.sign(m, seed) };
}

/**
 * Register the derived Solana wallet with Realmint (agent bearer). Proves
 * control by signing a server challenge — the seed never leaves the process.
 */
export async function registerSolanaWallet(
  baseUrl: string,
  bearer: string,
  wallet: SolanaWallet,
): Promise<void> {
  const chRes = await fetch(`${baseUrl}/v1/agent/solana-wallet/challenge`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const ch = await chRes.json();
  if (!chRes.ok || !ch.challenge) {
    throw new Error(`solana-wallet challenge failed: ${JSON.stringify(ch)}`);
  }
  const proof = Buffer.from(wallet.sign(new TextEncoder().encode(ch.challenge))).toString("base64");
  const regRes = await fetch(`${baseUrl}/v1/agent/solana-wallet`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ solana_pubkey: wallet.address, challenge: ch.challenge, proof }),
  });
  const reg = await regRes.json();
  if (!regRes.ok) throw new Error(`register solana wallet failed: ${JSON.stringify(reg)}`);
}
