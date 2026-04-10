/**
 * JPYC x402 Client — Permit2 署名スキーム
 * 1. JPYC → Permit2 approve（未承認の場合のみ）
 * 2. Permit2 EIP-712 署名を生成（PermitTransferFrom）
 * 3. X-PAYMENT ヘッダーに入れてサーバーに送信
 */
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { privateKeyToAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  maxUint256,
} from "viem";
import { polygon } from "viem/chains";
import { randomBytes } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

const privateKey = (process.env.PRIVATE_KEY ?? process.env.EVM_PRIVATE_KEY) as `0x${string}`;
if (!privateKey) {
  console.error("Missing PRIVATE_KEY in clients/.env");
  process.exit(1);
}

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const baseURL = process.env.SERVER_URL || "http://localhost:4021";
const url = `${baseURL}/weather`;

const JPYC_ADDRESS = "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29" as `0x${string}`;
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as `0x${string}`;
// ファシリテーターのリレーアドレス（Permit2のspender = 実際にpermitTransferFromを呼ぶアドレス）
const FACILITATOR_RELAYER = "0x21c2AD63909Db11bcdc11Dc43d97EEfE01298a7D" as `0x${string}`;

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

// Permit2 PermitTransferFrom EIP-712 型定義（witness なし）
const PERMIT_TRANSFER_FROM_TYPES = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender",   type: "address" },
    { name: "nonce",     type: "uint256" },
    { name: "deadline",  type: "uint256" },
  ],
  TokenPermissions: [
    { name: "token",  type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

async function main(): Promise<void> {
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain: polygon, transport: http(POLYGON_RPC) });
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC) });

  console.log(`Wallet:  ${account.address}`);
  console.log(`Target:  ${url}`);
  console.log(`Network: eip155:137 (Polygon)`);
  console.log(`Token:   ${JPYC_ADDRESS} (JPYC)`);
  console.log(`Flow:    Permit2 EIP-712 (PermitTransferFrom)\n`);

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

  // Step 2: Permit2 へのJPYC approve チェック
  console.log("\nStep 2: Checking JPYC allowance for Permit2...");
  const allowance = await publicClient.readContract({
    address: JPYC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, PERMIT2_ADDRESS],
  });
  console.log(`Current allowance: ${allowance}`);

  if (allowance < BigInt(amount)) {
    console.log("Approving Permit2 to spend JPYC (max uint256)...");
    const approveTxHash = await walletClient.writeContract({
      address: JPYC_ADDRESS,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [PERMIT2_ADDRESS, maxUint256],
    });
    console.log(`Approve txHash: ${approveTxHash}`);
    await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    console.log("Approved!");
  } else {
    console.log("Already approved, skipping.");
  }

  // Step 3: Permit2 EIP-712 署名を生成
  console.log("\nStep 3: Generating Permit2 EIP-712 signature...");

  // ランダムな 256-bit nonce
  const nonce = BigInt("0x" + randomBytes(32).toString("hex"));
  // deadline = 現在時刻 + 1時間
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const permit2Domain = {
    name: "Permit2",
    chainId: 137,
    verifyingContract: PERMIT2_ADDRESS,
  } as const;

  const permitMessage = {
    permitted: {
      token: JPYC_ADDRESS,
      amount: BigInt(amount),
    },
    spender: FACILITATOR_RELAYER, // permitTransferFrom を呼ぶファシリテーターのアドレス
    nonce,
    deadline,
  };

  const signature = await account.signTypedData({
    domain: permit2Domain,
    types: PERMIT_TRANSFER_FROM_TYPES,
    primaryType: "PermitTransferFrom",
    message: permitMessage,
  });

  console.log(`Signature: ${signature.slice(0, 20)}...`);
  console.log(`Nonce:     ${nonce}`);
  console.log(`Deadline:  ${deadline} (unix)`);

  // Step 4: paymentPayload を構築 (フラット構造)
  const paymentPayload = {
    x402Version: 2,
    scheme: "evm-erc20-permit2",
    network: "eip155:137",
    permit: {
      permitted: {
        token: JPYC_ADDRESS,
        amount: amount,
      },
      nonce: nonce.toString(),
      deadline: deadline.toString(),
    },
    transferDetails: {
      to: payTo,
      requestedAmount: amount,
    },
    owner: account.address,
    signature,
  };

  const xPaymentHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  // Step 5: X-PAYMENT ヘッダー付きでサーバーにリクエスト
  console.log("\nStep 4: Sending Permit2 payment to server...");
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
    console.log("\n世界初のJPYC Permit2 x402決済成功！");
  }
}

main().catch(error => {
  console.error("\n=== Error ===");
  console.error(error?.message ?? error);
  process.exit(1);
});
