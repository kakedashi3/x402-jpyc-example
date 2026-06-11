import { config } from "dotenv";
import express from "express";
import type { Request, Response } from "express";
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

/**
 * x402 決済ゲート (402 quote → verify → settle)。
 * 支払い完了なら true を返す (PAYMENT-RESPONSE ヘッダ設定済み)。
 * 402/400/500 を既に返した場合は false。
 *
 * opts.jp402 は 402 envelope の accepts[] に載せる JP 拡張 (税構造など)。
 * EIP-712 domain を運ぶ extra とは分離する (facilitator の verify 対象外)。
 */
async function collectPayment(
  req: Request,
  res: Response,
  opts: { amount: string; jp402?: Record<string, unknown> },
): Promise<boolean> {
  // Accept both v2 (PAYMENT-SIGNATURE) and v1 (X-PAYMENT) headers so existing
  // clients keep working while new clients use the v2 canonical name.
  const rawPayment =
    (req.headers["payment-signature"] as string | undefined) ??
    (req.headers["x-payment"] as string | undefined);

  const paymentRequirements = {
    scheme:  JPYC_SCHEME,
    network,
    asset:   token,
    amount:  opts.amount,
    payTo:   recipientAddress,
    extra:   { name: JPYC_EIP712_NAME, version: JPYC_EIP712_VERSION },
  };

  // 支払い情報がなければ 402 を返す
  if (!rawPayment) {
    // yen402 facilitator expects v1 paymentPayload shape (scheme at top level),
    // so advertise x402Version:1 in the envelope to make yen402-mcp emit v1 payloads.
    const envelope = {
      x402Version: 1,
      accepts: [
        {
          ...paymentRequirements,
          maxAmountRequired: opts.amount,
          resource: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
          ...(opts.jp402 ? { jp402: opts.jp402 } : {}),
        },
      ],
    };
    // Body + base64 `payment-required` header: dual delivery to maximize compat
    // with both body-parsing clients (mameta EC style) and header-parsing
    // clients (paylog.dev / yen402-mcp). The header carries the same envelope.
    res.setHeader(
      "payment-required",
      Buffer.from(JSON.stringify(envelope)).toString("base64"),
    );
    res.status(402).json(envelope);
    return false;
  }

  // PAYMENT-SIGNATURE / X-PAYMENT は base64(JSON) で paymentPayload を運ぶ
  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(rawPayment, "base64").toString());
  } catch {
    res
      .status(400)
      .json({ error: "Invalid payment header: not valid base64 JSON" });
    return false;
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
    res
      .status(400)
      .json({ error: "Invalid payment header: missing required fields (expect payload.signature and payload.authorization.{from,to,value,nonce})" });
    return false;
  }

  // Step 1: verify
  let verifyRes: globalThis.Response;
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
    res
      .status(500)
      .json({ error: `Facilitator unreachable: ${e?.message}` });
    return false;
  }

  if (!verifyRes.ok) {
    const err = (await verifyRes.json().catch(() => ({}))) as any;
    console.error("[verify] FAILED:", err);
    res
      .status(402)
      .json({ error: err.error || "Payment verification failed" });
    return false;
  }

  console.log("[verify] OK");

  // Step 2: settle（replay attack 防止）
  let settleRes: globalThis.Response;
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
    res
      .status(500)
      .json({ error: `Settle failed: ${e?.message}` });
    return false;
  }

  if (!settleRes.ok) {
    const err = (await settleRes.json().catch(() => ({}))) as any;
    console.error("[settle] FAILED:", err);
    res
      .status(402)
      .json({ error: err.error || "Payment settle failed" });
    return false;
  }

  // Forward the facilitator's settle response to the client as PAYMENT-RESPONSE
  const settleBody = await settleRes.json().catch(() => ({}));
  res.setHeader(
    "PAYMENT-RESPONSE",
    Buffer.from(JSON.stringify(settleBody)).toString("base64"),
  );

  console.log("[settle] Payment consumed");
  return true;
}

const app = express();

// 有料エンドポイント (従来デモ)
app.get("/api/premium", async (req, res) => {
  const paid = await collectPayment(req, res, { amount: AMOUNT });
  if (!paid) return;
  // 支払い確認・消費済み → コンテンツを返す
  res.json({ data: "Premium content here" });
});

// ─────────────────────────────────────────────────────────────
// 上流転送ハンドラ (jojo Day1 デモ / knowledge jojo.md §10-①)
// 無料の Polymarket Gamma API を 402 ゲートして転送する。
// 原価ゼロ・粗利 100% (blockrun §7)。quote は税抜/税額を jp402 拡張で明示。
// ─────────────────────────────────────────────────────────────

// 税込 11 JPYC = 税抜 10 + 消費税 1 (10%)
const MARKETS_AMOUNT = "11000000000000000000";
const MARKETS_TAX = { excl_jpyc: "10", vat_jpyc: "1", rate: 0.1 };
const UPSTREAM_MARKETS = "https://gamma-api.polymarket.com/markets";
// パススルーは安全な read 系パラメータのみ許可 (資格情報パススルー禁止 — blockrun §9 の反面教師)
const MARKETS_PARAM_ALLOWLIST = [
  "limit", "offset", "order", "ascending", "active", "closed", "slug", "id",
] as const;

app.get("/api/markets", async (req, res) => {
  const paid = await collectPayment(req, res, {
    amount: MARKETS_AMOUNT,
    jp402: { tax: MARKETS_TAX, upstream: "polymarket-gamma" },
  });
  if (!paid) return;

  const upstream = new URL(UPSTREAM_MARKETS);
  for (const k of MARKETS_PARAM_ALLOWLIST) {
    const v = req.query[k];
    if (typeof v === "string") upstream.searchParams.set(k, v);
  }
  if (!upstream.searchParams.has("limit")) upstream.searchParams.set("limit", "5");

  try {
    const r = await fetch(upstream, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await r.json();
    console.log(`[forward] ${upstream.pathname}?${upstream.searchParams} → ${r.status}`);
    // 支払い済みなのに上流が落ちている場合も 200 で返さない (決済は完了している
    // ため、agent 側が PAYMENT-RESPONSE の tx_hash で問い合わせできるよう明示)
    res.status(r.ok ? 200 : 502).json(
      r.ok ? body : { error: `Upstream error: ${r.status}`, upstream_body: body },
    );
  } catch (e: any) {
    console.error("[forward] ERROR:", e?.message);
    res.status(502).json({ error: `Upstream unreachable: ${e?.message}` });
  }
});

// 起動
fetchPaymentInfo()
  .then(() => {
    const PORT = Number(process.env.PORT) || 3000;
    app.listen(PORT, () => {
      console.log(`Server listening at http://localhost:${PORT}`);
      console.log(`Facilitator: ${X402_FACILITATOR_URL}`);
      console.log(`Paid routes: /api/premium (1 JPYC), /api/markets (11 JPYC 税込)`);
    });
  })
  .catch((e) => {
    console.error("Failed to fetch payment info:", e.message);
    process.exit(1);
  });
