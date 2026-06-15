import { config } from "dotenv";
import express from "express";
import type { Request, Response } from "express";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
// scheme, network, and extra.name/version must match the EIP-712 domain of the
// current JPYC contract (電子決済手段, 0xe7c3d8c9a439fede00d2600032d5db0be71c3c29
// — same address on Polygon/Kaia). The actual token address comes from the
// facilitator's /payment-info at startup; only the domain values are fixed here.
const JPYC_SCHEME = "exact" as const;
const JPYC_EIP712_NAME = "JPY Coin" as const; // canonical EIP-712 name on the JPYC contract
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

// JPYC on Polygon has 18 decimals. 1 JPYC = 10^18 raw units.
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
// 上流転送ハンドラ (yoyo Day1 デモ / knowledge yoyo.md §10-①)
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

  await forwardJson(res, upstream);
});

/**
 * 上流 GET 転送の共通部。
 * 支払い済みなのに上流が落ちている場合も 200 で返さない (決済は完了している
 * ため、agent 側が PAYMENT-RESPONSE の tx_hash で問い合わせできるよう明示)。
 */
async function forwardJson(res: Response, upstream: URL): Promise<void> {
  try {
    const r = await fetch(upstream, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await r.json();
    console.log(`[forward] ${upstream.host}${upstream.pathname}?${upstream.searchParams} → ${r.status}`);
    res.status(r.ok ? 200 : 502).json(
      r.ok ? body : { error: `Upstream error: ${r.status}`, upstream_body: body },
    );
  } catch (e: any) {
    console.error("[forward] ERROR:", e?.message);
    res.status(502).json({ error: `Upstream unreachable: ${e?.message}` });
  }
}

// ─────────────────────────────────────────────────────────────
// 多 endpoint 化 (yoyo Phase G / knowledge yoyo.md §14、blockrun §7)
// 選定基準: 無料 API 優先 (原価ゼロ・粗利 100%)・read 系のみ・上流データの権利クリーン度。
// ─────────────────────────────────────────────────────────────

// /api/fx — 為替レート (Frankfurter、ECB 公表レートのオープンデータ・key 不要)
// 税込 5.5 JPYC = 税抜 5 + 消費税 0.5 — 税額が 1 円を割るマイクロペイメント帯のケース (blockrun §6)
const FX_AMOUNT = "5500000000000000000";
const FX_TAX = { excl_jpyc: "5", vat_jpyc: "0.5", rate: 0.1 };
const UPSTREAM_FX = "https://api.frankfurter.dev/v1/latest";
const FX_PARAM_ALLOWLIST = ["base", "symbols"] as const;

app.get("/api/fx", async (req, res) => {
  const paid = await collectPayment(req, res, {
    amount: FX_AMOUNT,
    jp402: { tax: FX_TAX, upstream: "frankfurter-ecb" },
  });
  if (!paid) return;

  const upstream = new URL(UPSTREAM_FX);
  for (const k of FX_PARAM_ALLOWLIST) {
    const v = req.query[k];
    if (typeof v === "string") upstream.searchParams.set(k, v);
  }
  if (!upstream.searchParams.has("symbols")) upstream.searchParams.set("symbols", "JPY,EUR,GBP");
  await forwardJson(res, upstream);
});

// /api/defi — チェーン別 DeFi TVL (DeFiLlama 公開 API・key 不要)
// 税込 11 JPYC = 税抜 10 + 消費税 1 (10%)
const DEFI_AMOUNT = "11000000000000000000";
const DEFI_TAX = { excl_jpyc: "10", vat_jpyc: "1", rate: 0.1 };
const UPSTREAM_DEFI = "https://api.llama.fi/v2/chains";

app.get("/api/defi", async (req, res) => {
  const paid = await collectPayment(req, res, {
    amount: DEFI_AMOUNT,
    jp402: { tax: DEFI_TAX, upstream: "defillama" },
  });
  if (!paid) return;

  // 上流はパラメータなしで全チェーン返却。limit だけローカルで TVL 降順 top N に絞る
  try {
    const r = await fetch(UPSTREAM_DEFI, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      res.status(502).json({ error: `Upstream error: ${r.status}`, upstream_body: body });
      return;
    }
    const chains = (await r.json()) as Array<{ tvl: number }>;
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const body = [...chains].sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0)).slice(0, limit);
    console.log(`[forward] api.llama.fi/v2/chains (top ${limit}) → 200`);
    res.json(body);
  } catch (e: any) {
    console.error("[forward] ERROR:", e?.message);
    res.status(502).json({ error: `Upstream unreachable: ${e?.message}` });
  }
});

// /api/reports/:id — yoyo の受託レポート販売 (F-1 sell endpoint・demo-grade)
// 税込 55 JPYC = 税抜 50 + 消費税 5 (10%)。納品=入金の原子性: 払うまで全文は出ない。
// ※demo は買い手 yoyo が自分のレポートを買う self-loop。payTo は facilitator 設定の
//   共用 wallet で、収益専用 wallet (W-H) への分離は product-grade の精緻化。
const REPORT_AMOUNT = "55000000000000000000";
const REPORT_TAX = { excl_jpyc: "50", vat_jpyc: "5", rate: 0.1 };
const REPORTS_DIR = join(homedir(), ".yen402", "reports");

app.get("/api/reports/:id", async (req, res) => {
  const id = String(req.params.id).replace(/[^A-Za-z0-9_-]/g, ""); // path traversal 防止
  const file = join(REPORTS_DIR, `${id}.html`);
  if (!existsSync(file)) {
    res.status(404).json({ error: `report ${id} not found` });
    return;
  }
  const paid = await collectPayment(req, res, {
    amount: REPORT_AMOUNT,
    jp402: { tax: REPORT_TAX, deliverable: `受託レポート ${id}` },
  });
  if (!paid) return;
  console.log(`[sell] report ${id} delivered (paid 55 JPYC)`);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(readFileSync(file, "utf8"));
});

// /api/catalog — 無料の品書き。買い手 agent (yoyo 等) が品揃えと価格を発見する用。
// 正式な discovery は jp402-registry 登録 (yoyo Phase D) でこの簡易版を置き換える
app.get("/api/catalog", (_req, res) => {
  res.json({
    seller: "x402-jpyc-example (yoyo demo)",
    currency: "JPYC",
    network: "eip155:137",
    resources: [
      { path: "/api/premium", price_jpyc: "1", description: "デモ用固定コンテンツ" },
      { path: "/api/markets", price_jpyc: "11", tax: MARKETS_TAX, upstream: "polymarket-gamma", params: MARKETS_PARAM_ALLOWLIST, description: "Polymarket 予測市場データ" },
      { path: "/api/fx", price_jpyc: "5.5", tax: FX_TAX, upstream: "frankfurter-ecb", params: FX_PARAM_ALLOWLIST, description: "ECB 公表為替レート" },
      { path: "/api/defi", price_jpyc: "11", tax: DEFI_TAX, upstream: "defillama", params: ["limit"], description: "チェーン別 DeFi TVL (降順 top N)" },
    ],
  });
});

// 起動
fetchPaymentInfo()
  .then(() => {
    const PORT = Number(process.env.PORT) || 3000;
    app.listen(PORT, () => {
      console.log(`Server listening at http://localhost:${PORT}`);
      console.log(`Facilitator: ${X402_FACILITATOR_URL}`);
      console.log(`Paid routes: /api/premium (1 JPYC), /api/markets (11 JPYC 税込), /api/fx (5.5 JPYC 税込), /api/defi (11 JPYC 税込), /api/reports/:id (55 JPYC 税込・売り手)`);
      console.log(`Free routes: /api/catalog (品書き)`);
    });
  })
  .catch((e) => {
    console.error("Failed to fetch payment info:", e.message);
    process.exit(1);
  });
