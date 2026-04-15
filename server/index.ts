import { config } from "dotenv";
import express from "express";
config({ path: "../.env" });

const X402_FACILITATOR_URL = process.env.X402_FACILITATOR_URL;
const X402_API_KEY = process.env.X402_API_KEY;

if (!X402_FACILITATOR_URL) {
  console.error("Missing required environment variable: X402_FACILITATOR_URL");
  process.exit(1);
}
if (!X402_API_KEY) {
  console.error("Missing required environment variable: X402_API_KEY");
  process.exit(1);
}

// 起動時にファシリテーターから受取情報を取得
let recipientAddress: string;
let network: string;
let token: string;

async function fetchPaymentInfo(): Promise<void> {
  const res = await fetch(`${X402_FACILITATOR_URL}/api/payment-info`, {
    headers: { "X-API-Key": X402_API_KEY! },
  });
  if (!res.ok) throw new Error(`payment-info failed: ${res.status}`);
  const data = await res.json() as {
    recipientAddress: string;
    network: string;
    token: string;
  };
  recipientAddress = data.recipientAddress;
  network = data.network;
  token = data.token;
  console.log(`payTo:   ${recipientAddress}`);
  console.log(`network: ${network}`);
  console.log(`token:   ${token}`);
}

const AMOUNT = "1000000"; // 1 JPYC (6 decimals)

const app = express();

// 有料エンドポイント
app.get("/api/premium", async (req, res) => {
  const xPayment = req.headers["x-payment"] as string | undefined;

  // 支払い情報がなければ 402 を返す
  if (!xPayment) {
    return res.status(402).json({
      x402Version: 1,
      accepts: [
        {
          scheme: "evm-erc20-transfer",
          network,
          maxAmountRequired: AMOUNT,
          resource: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
          payTo: recipientAddress,
          token,
          facilitatorUrl: X402_FACILITATOR_URL,
        },
      ],
    });
  }

  // X-PAYMENT ヘッダーをデコード・検証
  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(xPayment, "base64").toString());
  } catch {
    return res.status(400).json({ error: "Invalid X-PAYMENT header: not valid base64 JSON" });
  }

  const auth = (paymentPayload as any)?.payload?.authorization;
  if (
    !auth ||
    typeof auth.from !== "string" ||
    typeof auth.to !== "string" ||
    typeof auth.value !== "string" ||
    typeof auth.nonce !== "string" ||
    typeof auth.signature !== "string"
  ) {
    return res.status(400).json({ error: "Invalid X-PAYMENT header: missing required fields" });
  }

  const paymentRequirements = {
    scheme: "evm-erc20-transfer",
    network,
    amount: AMOUNT,
    asset: token,
    payTo: recipientAddress,
  };

  // Step 1: verify
  let verifyRes: Response;
  try {
    verifyRes = await fetch(`${X402_FACILITATOR_URL}/api/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": X402_API_KEY!,
      },
      body: JSON.stringify({ paymentPayload, paymentRequirements }),
    });
  } catch (e: any) {
    console.error("[verify] ERROR:", e?.message);
    return res.status(500).json({ error: `Facilitator unreachable: ${e?.message}` });
  }

  if (!verifyRes.ok) {
    const err = await verifyRes.json().catch(() => ({})) as any;
    console.error("[verify] FAILED:", err);
    return res.status(402).json({ error: err.error || "Payment verification failed" });
  }

  console.log("[verify] OK");

  // Step 2: settle（replay attack 防止）
  let settleRes: Response;
  try {
    settleRes = await fetch(`${X402_FACILITATOR_URL}/api/settle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": X402_API_KEY!,
      },
      body: JSON.stringify({ paymentPayload, paymentRequirements }),
    });
  } catch (e: any) {
    console.error("[settle] ERROR:", e?.message);
    return res.status(500).json({ error: `Settle failed: ${e?.message}` });
  }

  if (!settleRes.ok) {
    const err = await settleRes.json().catch(() => ({})) as any;
    console.error("[settle] FAILED:", err);
    return res.status(402).json({ error: err.error || "Payment settle failed" });
  }

  console.log("[settle] Payment consumed");

  // 支払い確認・消費済み → コンテンツを返す
  res.json({ data: "Premium content here" });
});

// 起動
fetchPaymentInfo()
  .then(() => {
    app.listen(3000, () => {
      console.log("Server listening at http://localhost:3000");
      console.log(`Facilitator: ${X402_FACILITATOR_URL}`);
    });
  })
  .catch((e) => {
    console.error("Failed to fetch payment info:", e.message);
    process.exit(1);
  });
