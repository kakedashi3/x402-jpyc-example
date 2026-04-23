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

// x402-jpyc enforces these values on every /verify and /settle call.
// scheme, network, and extra.name/version must match the JPYC v2 EIP-712 domain.
const JPYC_SCHEME = "exact" as const;
const JPYC_EIP712_NAME = "JPY Coin" as const; // canonical EIP-712 name on the JPYC v2 contract
const JPYC_EIP712_VERSION = "1" as const;

// 起動時にファシリテーターから受取情報を取得
let recipientAddress: string;
let network: string;
let token: string;

async function fetchPaymentInfo(): Promise<void> {
  const res = await fetch(`${X402_FACILITATOR_URL}/payment-info`, {
    headers: { "X-API-Key": X402_API_KEY! },
  });
  if (!res.ok) throw new Error(`payment-info failed: ${res.status}`);
  const data = (await res.json()) as {
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

// JPYC v2 on Polygon has 18 decimals. 1 JPYC = 10^18 raw units.
const AMOUNT = "1000000000000000000"; // 1 JPYC

const app = express();

// 有料エンドポイント
app.get("/api/premium", async (req, res) => {
  // Accept both v2 (PAYMENT-SIGNATURE) and v1 (X-PAYMENT) headers so existing
  // clients keep working while new clients use the v2 canonical name.
  const rawPayment =
    (req.headers["payment-signature"] as string | undefined) ??
    (req.headers["x-payment"] as string | undefined);

  const paymentRequirements = {
    scheme:  JPYC_SCHEME,
    network,
    asset:   token,
    amount:  AMOUNT,
    payTo:   recipientAddress,
    extra:   { name: JPYC_EIP712_NAME, version: JPYC_EIP712_VERSION },
  };

  // 支払い情報がなければ 402 を返す
  if (!rawPayment) {
    return res.status(402).json({
      x402Version: 2,
      accepts: [
        {
          ...paymentRequirements,
          maxAmountRequired: AMOUNT,
          resource: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
        },
      ],
    });
  }

  // PAYMENT-SIGNATURE / X-PAYMENT は base64(JSON) で paymentPayload を運ぶ
  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(rawPayment, "base64").toString());
  } catch {
    return res
      .status(400)
      .json({ error: "Invalid payment header: not valid base64 JSON" });
  }

  const payload = (paymentPayload as { payload?: { authorization?: Record<string, unknown>; signature?: unknown } })?.payload;
  const auth = payload?.authorization;
  const signature = payload?.signature;
  if (
    !auth ||
    typeof auth.from !== "string" ||
    typeof auth.to !== "string" ||
    typeof auth.value !== "string" ||
    typeof auth.nonce !== "string" ||
    typeof signature !== "string"
  ) {
    return res
      .status(400)
      .json({ error: "Invalid payment header: missing required fields (expect payload.signature and payload.authorization.{from,to,value,nonce})" });
  }

  // Step 1: verify
  let verifyRes: Response;
  try {
    verifyRes = await fetch(`${X402_FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": X402_API_KEY!,
      },
      body: JSON.stringify({ paymentPayload, paymentRequirements }),
    });
  } catch (e: any) {
    console.error("[verify] ERROR:", e?.message);
    return res
      .status(500)
      .json({ error: `Facilitator unreachable: ${e?.message}` });
  }

  if (!verifyRes.ok) {
    const err = (await verifyRes.json().catch(() => ({}))) as any;
    console.error("[verify] FAILED:", err);
    return res
      .status(402)
      .json({ error: err.error || "Payment verification failed" });
  }

  console.log("[verify] OK");

  // Step 2: settle（replay attack 防止）
  let settleRes: Response;
  try {
    settleRes = await fetch(`${X402_FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": X402_API_KEY!,
      },
      body: JSON.stringify({ paymentPayload, paymentRequirements }),
    });
  } catch (e: any) {
    console.error("[settle] ERROR:", e?.message);
    return res
      .status(500)
      .json({ error: `Settle failed: ${e?.message}` });
  }

  if (!settleRes.ok) {
    const err = (await settleRes.json().catch(() => ({}))) as any;
    console.error("[settle] FAILED:", err);
    return res
      .status(402)
      .json({ error: err.error || "Payment settle failed" });
  }

  // Forward the facilitator's settle response to the client as PAYMENT-RESPONSE
  const settleBody = await settleRes.json().catch(() => ({}));
  res.setHeader(
    "PAYMENT-RESPONSE",
    Buffer.from(JSON.stringify(settleBody)).toString("base64"),
  );

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
