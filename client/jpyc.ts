/**
 * JPYC x402 Client — EIP-3009 TransferWithAuthorization 署名スキーム
 * 1. EIP-712 署名を生成（TransferWithAuthorization）
 * 2. X-PAYMENT ヘッダーに入れてサーバーに送信
 * ※ Permit2 の approve ステップは不要
 */
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  http,
} from "viem";
import { polygon } from "viem/chains";
import { randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

const privateKey = (process.env.PRIVATE_KEY ?? process.env.EVM_PRIVATE_KEY) as `0x${string}`;
if (!privateKey) {
  console.error("Missing PRIVATE_KEY in .env");
  process.exit(1);
}

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const baseURL = process.env.SERVER_URL || "http://localhost:4021";
const url = `${baseURL}/weather`;

const JPYC_ADDRESS = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29" as `0x${string}`;

// EIP-3009 TransferWithAuthorization EIP-712 型定義
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// JPYC の EIP-712 ドメイン
const JPYC_DOMAIN = {
  name: "JPY Coin",
  version: "1",
  chainId: 137,
  verifyingContract: JPYC_ADDRESS,
} as const;

async function main(): Promise<void> {
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) });

  console.log(`Wallet:  ${account.address}`);
  console.log(`Target:  ${url}`);
  console.log(`Network: eip155:137 (Polygon)`);
  console.log(`Token:   ${JPYC_ADDRESS} (JPYC)`);
  console.log(`Flow:    EIP-3009 TransferWithAuthorization\n`);

  // Step 1: 初回リクエスト → 402 を受け取り支払い先・金額を取得
  console.log("Step 1: Initial request (expect 402)...");
  const initRes = await fetch(url, { method: "GET" });
  console.log(`Status: ${initRes.status}`);

  if (initRes.status !== 402) {
    console.log("Unexpected response:", await initRes.text());
    return;
  }

  const paymentRequiredHeader = initRes.headers.get("payment-required");
  let payTo = process.env.EVM_ADDRESS || "0xD111da39205E8DBb52621D12fef1f952C83890D2";
  let amount = "1000";

  if (paymentRequiredHeader) {
    try {
      const decoded = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString());
      const accept = decoded.accepts?.[0];
      if (accept?.payTo) payTo = accept.payTo;
      if (accept?.amount) amount = accept.amount;
    } catch {
      console.warn("Could not parse payment-required header, using defaults");
    }
  }
  console.log(`payTo:   ${payTo}`);
  console.log(`amount:  ${amount} (raw JPYC units)`);

  // Step 2: EIP-3009 TransferWithAuthorization EIP-712 署名を生成
  console.log("\nStep 2: Generating EIP-3009 TransferWithAuthorization signature...");

  const nonce = `0x${randomBytes(32).toString("hex")}` as `0x${string}`;
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const message = {
    from: account.address,
    to: payTo as `0x${string}`,
    value: BigInt(amount),
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await account.signTypedData({
    domain: JPYC_DOMAIN,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  console.log(`Signature:  ${signature.slice(0, 20)}...`);
  console.log(`Nonce:      ${nonce.slice(0, 20)}...`);
  console.log(`ValidAfter: ${validAfter}`);
  console.log(`ValidBefore: ${validBefore} (unix)`);

  // Step 3: paymentPayload を構築
  // facilitator が期待する構造: { paymentPayload: { payload: { authorization: {...} } }, paymentRequirements: {...} }
  // サーバーが paymentPayload でラップするため、ここでは payload.authorization を構築
  const paymentPayload = {
    payload: {
      authorization: {
        from: account.address,
        to: payTo,
        value: amount,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce,
        signature,
      },
    },
  };

  const xPaymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  // Step 4: X-PAYMENT ヘッダー付きでサーバーにリクエスト
  console.log("\nStep 3: Sending EIP-3009 payment to server...");
  const response = await fetch(url, {
    method: "GET",
    headers: { "X-PAYMENT": xPaymentHeader },
  });

  console.log("\n=== Status ===");
  console.log("Status:", response.status);

  console.log("\n=== Headers ===");
  console.log(Object.fromEntries(response.headers));

  console.log("\n=== Body ===");
  const body = await response.text();
  console.log(body);

  if (response.status === 200) {
    console.log("\nJPYC EIP-3009 x402決済成功！");
  }
}

main().catch(error => {
  console.error("\n=== Error ===");
  console.error(error?.message ?? error);
  process.exit(1);
});
