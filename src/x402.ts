// x402 payment signer for the "exact" scheme on EVM (USDC EIP-3009).
//
// Given the `accepts[0]` payment-requirements object from a Realmint 402
// challenge, produce the base64 `X-PAYMENT` header value: a signed EIP-3009
// `TransferWithAuthorization` moving USDC from the agent's EOA to the smart
// account named in `payTo`. This is the entire client side of the x402 protocol
// — drop-in compatible with the Coinbase x402 facilitator that settles it.

import type { LocalAccount } from "viem";

export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string; // atomic USDC (6 decimals)
  resource: string;
  payTo: string;
  asset: string; // USDC contract on the payment network
  maxTimeoutSeconds?: number;
  extra?: { name?: string; version?: string };
}

const CHAIN_ID: Record<string, number> = { base: 8453 };

/**
 * Build the `X-PAYMENT` header value for a Realmint x402 challenge.
 */
export async function buildXPayment(
  req: PaymentRequirements,
  account: LocalAccount,
): Promise<string> {
  if (req.scheme !== "exact") {
    throw new Error(`Unsupported x402 scheme: ${req.scheme}`);
  }
  const chainId = CHAIN_ID[req.network];
  if (!chainId) throw new Error(`Unsupported x402 network: ${req.network}`);

  const name = req.extra?.name ?? "USD Coin";
  const version = req.extra?.version ?? "2";
  const value = BigInt(req.maxAmountRequired);
  const validAfter = 0n;
  const validBefore = BigInt(
    Math.floor(Date.now() / 1000) + (req.maxTimeoutSeconds ?? 300),
  );
  const nonce = randomHex32();

  const signature = await account.signTypedData({
    domain: { name, version, chainId, verifyingContract: req.asset as `0x${string}` },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: account.address,
      to: req.payTo as `0x${string}`,
      value,
      validAfter,
      validBefore,
      nonce,
    },
  });

  const payload = {
    x402Version: 1,
    scheme: "exact",
    network: req.network,
    payload: {
      signature,
      authorization: {
        from: account.address,
        to: req.payTo,
        value: req.maxAmountRequired,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function randomHex32(): `0x${string}` {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ("0x" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
}
