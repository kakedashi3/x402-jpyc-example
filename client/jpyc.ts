/**
 * JPYC x402 Client — EIP-3009 TransferWithAuthorization 署名スキーム
 * 1. サーバーに GET → 402 を受け取り payTo・amount・token を取得
 * 2. EIP-712 署名を生成（TransferWithAuthorization）
 * 3. X-PAYMENT ヘッダーに入れて再リクエスト
 */
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http } from "viem";
import { polygon } from "viem/chains";
import { randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
if (!privateKey) {
  console.error("Missing PRIVATE_KEY in .env");
  process.exit(1);
}

const baseURL = process.env.SERVER_URL || "http://localhost:3000";
const url = `${baseURL}/api/premium`;

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

async function main(): Promise<void> {
  const account = privateKeyToAccount(privateKey);
  createPublicClient({ chain: polygon, transport: http() });

  console.log(`Wallet:  ${account.address}`);
  console.log(`Target:  ${url}`);

  // Step 1: 初回リクエスト → 402 を受け取り支払い情報を取得
  console.log("\nStep 1: Initial request (expect 402)...");
  const initRes = await fetch(url);
  console.log(`Status: ${initRes.status}`);

  if (initRes.status !== 402) {
    console.log("Unexpected response:", await initRes.text());
    return;
  }

  const body402 = await initRes.json() as {
    accepts: Array<{
      payTo: string;
      maxAmountRequired: string;
      token: string;
      network: string;
    }>;
  };

  const accept = body402.accepts?.[0];
  if (!accept) {
    console.error("No accepts in 402 response");
    return;
  }

  const { payTo, maxAmountRequired: amount, token } = accept;
  console.log(`payTo:   ${payTo}`);
  console.log(`amount:  ${amount}`);
  console.log(`token:   ${token}`);

  // Step 2: EIP-3009 TransferWithAuthorization EIP-712 署名を生成
  console.log("\nStep 2: Generating EIP-3009 signature...");

  const jpycDomain = {
    name: "JPY Coin",
    version: "1",
    chainId: 137,
    verifyingContract: token as `0x${string}`,
  } as const;

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
    domain: jpycDomain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  console.log(`Signature:   ${signature.slice(0, 20)}...`);
  console.log(`Nonce:       ${nonce.slice(0, 20)}...`);
  console.log(`ValidBefore: ${validBefore} (unix)`);

  // Step 3: paymentPayload を構築して base64 エンコード
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

  // Step 4: X-PAYMENT ヘッダー付きで再リクエスト
  console.log("\nStep 3: Sending payment to server...");
  const response = await fetch(url, {
    headers: { "X-PAYMENT": xPaymentHeader },
  });

  console.log("\n=== Status ===");
  console.log(response.status);

  console.log("\n=== Body ===");
  console.log(await response.text());

  if (response.status === 200) {
    console.log("\nJPYC x402 決済成功！");
  }
}

main().catch((error) => {
  console.error("\n=== Error ===");
  console.error(error?.message ?? error);
  process.exit(1);
});
