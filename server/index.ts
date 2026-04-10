import { config } from "dotenv";
import express from "express";
config();

const evmAddress = process.env.EVM_ADDRESS as `0x${string}`;
if (!evmAddress) {
  console.error("Missing required environment variable: EVM_ADDRESS");
  process.exit(1);
}

const network = process.env.NETWORK || "eip155:137";
const asset = process.env.ASSET || "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29";
const facilitatorUrl = process.env.FACILITATOR_URL || "https://x402-jpyc.vercel.app/api";
const apiKey = "jpyc-test-key-20260410";

const paymentRequirements = {
  scheme: "evm-erc20-transfer",
  network,
  amount: "1000",
  asset,
  payTo: evmAddress,
  maxTimeoutSeconds: 300,
};

const app = express();

// カスタム x402 ミドルウェア (evm-erc20-transfer スキーム)
async function jpycPaymentMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const paymentHeader =
    (req.headers["x-payment"] as string) || (req.headers["X-PAYMENT"] as string);

  if (!paymentHeader) {
    // 402 を返してクライアントに支払い要件を通知
    const paymentRequired = {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: `http://${req.headers.host}${req.path}`,
        description: "Weather data",
        mimeType: "application/json",
      },
      accepts: [paymentRequirements],
    };
    const encoded = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
    res.setHeader("payment-required", encoded);
    res.status(402).json({});
    return;
  }

  // X-PAYMENT ヘッダーを Base64 デコード
  let paymentPayload: any;
  try {
    paymentPayload = JSON.parse(Buffer.from(paymentHeader, "base64").toString());
  } catch {
    res.status(400).json({ error: "Invalid X-PAYMENT header" });
    return;
  }

  console.log("[verify] payload:", JSON.stringify(paymentPayload, null, 2));

  // ファシリテーターへ検証リクエスト
  let verifyResult: any;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout

    let verifyRes: Response;
    try {
      verifyRes = await fetch(`${facilitatorUrl}/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": apiKey,
        },
        body: JSON.stringify(
          paymentPayload.scheme === "evm-erc20-permit2"
            ? {
                permit: paymentPayload.permit,
                transferDetails: paymentPayload.transferDetails,
                owner: paymentPayload.owner,
                signature: paymentPayload.signature,
                paymentRequirements,
              }
            : {
                paymentPayload,
                paymentRequirements,
              },
        ),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await verifyRes.text();
    console.log("[verify] response status:", verifyRes.status);
    console.log("[verify] response body:", text);

    try {
      verifyResult = JSON.parse(text);
    } catch {
      if (!res.headersSent) res.status(402).json({ error: `Facilitator error: ${text}` });
      return;
    }

    if (!verifyRes.ok) {
      if (!res.headersSent) res.status(402).json({ error: verifyResult.error || "Verification failed" });
      return;
    }
  } catch (e: any) {
    console.error("[verify] ERROR:", e?.message);
    if (!res.headersSent) res.status(500).json({ error: `Facilitator unreachable: ${e?.message}` });
    return;
  }

  if (!verifyResult.isValid) {
    res.status(402).json({
      error: verifyResult.invalidReason || verifyResult.error || "Invalid payment",
    });
    return;
  }

  console.log("[verify] Payment valid! Proceeding...");
  next();
}

app.get("/weather", jpycPaymentMiddleware, (req, res) => {
  res.json({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(4021, () => {
  console.log(`Server listening at http://localhost:4021`);
  console.log(`Facilitator: ${facilitatorUrl}`);
  console.log(`payTo: ${evmAddress}`);
});
