# x402-jpyc-example

Reference implementation for JPYC payments using the [x402 protocol](https://x402.org).

## What is this?

A minimal working example of pay-per-request APIs using JPYC (Japanese Yen stablecoin) on Polygon.

- **Server**: Returns a 402 response when payment is missing, verifies and settles payment via the facilitator
- **Client**: Signs an EIP-3009 authorization and sends it in the `X-PAYMENT` header

No gas fees required on the client side. The facilitator executes the on-chain transfer.

---

## How it works

```
Client                        Server                        Facilitator
  │                              │                               │
  │── GET /api/premium ─────────>│                               │
  │                              │                               │
  │<─ 402 (payTo, amount, token)─│                               │
  │                              │                               │
  │ [Sign EIP-3009 off-chain]    │                               │
  │                              │                               │
  │── GET /api/premium ─────────>│                               │
  │   X-PAYMENT: <signed auth>   │── POST /api/verify ──────────>│
  │                              │<─ 200 OK ─────────────────────│
  │                              │                               │
  │                              │── POST /api/settle ──────────>│
  │                              │              [on-chain transfer executed]
  │                              │<─ 200 OK ─────────────────────│
  │                              │                               │
  │<─ 200 (content) ────────────│                               │
```

---

## Prerequisites

- Node.js 18+
- A wallet with JPYC on Polygon mainnet
  - Get JPYC at [jpyc.co.jp](https://jpyc.co.jp)
  - Token contract: `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29` (6 decimals)
- An API key from the x402-jpyc dashboard
  - Dashboard: [x402-jpyc.vercel.app/dashboard](https://x402-jpyc.vercel.app/dashboard)
  - Register your recipient wallet address when creating the key

---

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/your-org/x402-jpyc-example
cd x402-jpyc-example

cd server && npm install && cd ..
cd client && npm install && cd ..
```

### 2. Set up environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

```env
# API key issued from the x402-jpyc dashboard
# The recipient wallet address is registered to this key
X402_API_KEY=jpyc_sk_...

# Private key of the wallet that will PAY with JPYC
PRIVATE_KEY=0x...
```

> **Warning:** Never commit your `.env` file. It is already in `.gitignore`.

### 3. Start the server

```bash
cd server
npm run dev
```

Expected output:

```
payTo:   0x3f02...         ← recipient address fetched from facilitator
network: eip155:137
token:   0xe7c3...
Server listening at http://localhost:3000
```

### 4. Run the client

```bash
cd client
npm start
```

Expected output:

```
Wallet:  0xD111...

Step 1: Initial request (expect 402)...
Status: 402
payTo:   0x3f02...
amount:  1000000
token:   0xe7c3...

Step 2: Generating EIP-3009 signature...
Signature:   0x...
ValidBefore: 1776231758 (unix)

Step 3: Sending payment to server...

=== Status ===
200

=== Body ===
{"data":"Premium content here"}

JPYC x402 決済成功！
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `X402_API_KEY` | ✅ Server | API key from the dashboard. The recipient address is registered to this key. |
| `X402_FACILITATOR_URL` | — | Facilitator URL. Defaults to `https://x402-jpyc.vercel.app` |
| `PRIVATE_KEY` | ✅ Client | Private key of the wallet paying with JPYC |
| `SERVER_URL` | — | Server URL for the client. Defaults to `http://localhost:3000` |

---

## Payment Flow (detail)

| Step | Who | What |
|---|---|---|
| 1 | Client → Server | `GET /api/premium` with no payment |
| 2 | Server → Client | `402` with `payTo`, `amount`, `token` |
| 3 | Client | Signs EIP-3009 `TransferWithAuthorization` off-chain (no gas) |
| 4 | Client → Server | `GET /api/premium` with `X-PAYMENT` header (base64 encoded signed authorization) |
| 5 | Server → Facilitator | `POST /api/verify` — checks signature validity and amount |
| 6 | Server → Facilitator | `POST /api/settle` — executes on-chain `transferWithAuthorization`, marks nonce as used |
| 7 | Server → Client | `200` with content |

**Replay attack prevention**: The nonce in each EIP-3009 authorization is random (32 bytes). After `settle`, the nonce is recorded on-chain and cannot be reused.

---

## Customizing

### Change the price

Edit `AMOUNT` in `server/index.ts`:

```ts
const AMOUNT = "1000000"; // 1 JPYC (6 decimals)
```

| Value | JPYC |
|---|---|
| `100000` | 0.1 JPYC |
| `1000000` | 1 JPYC |
| `10000000` | 10 JPYC |

### Change the endpoint

Replace `/api/premium` with your own path and content in `server/index.ts`.

---

## Production Notes

- **Use HTTPS**: The `X-PAYMENT` header contains a signed authorization. Always use TLS in production.
- **Private key management**: Never use a raw private key in production. Use a hardware wallet, HSM, or KMS.
- **Rate limiting**: Per-API-key rate limiting is handled by the facilitator. Add IP-based rate limiting if needed.

---

## Troubleshooting

**`Missing required environment variable: X402_API_KEY`**
Make sure `.env` exists in the project root with a valid `X402_API_KEY`.

**`payment-info failed: 401`**
The API key is invalid or not found. Check the dashboard.

**`EADDRINUSE: address already in use :::3000`**
```bash
kill $(lsof -t -i:3000)
```

**`Payment verification failed`**
- Check that the paying wallet has enough JPYC
- Check that the wallet approved JPYC spending (should not be needed with EIP-3009)
- Check the facilitator logs in the dashboard

---

## Proof of First Transaction

| Field | Value |
|---|---|
| Date | 2026-04-10 |
| txHash | [0x35c00930...](https://polygonscan.com/tx/0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f) |
| Block | 85338927 (Polygon mainnet) |
| Token | [JPYC](https://polygonscan.com/token/0xe7c3d8c9a439fede00d2600032d5db0be71c3c29) |

---

---

# x402-jpyc-example（日本語）

[x402プロトコル](https://x402.org)を使ったJPYC決済のリファレンス実装です。

## これは何か

Polygon上のJPYC（日本円ステーブルコイン）でAPIの従量課金を実現する最小構成のサンプルです。

- **サーバー**: 支払いがなければ402を返し、ファシリテーター経由で支払いを検証・確定する
- **クライアント**: EIP-3009署名を生成し、`X-PAYMENT`ヘッダーに載せて送信する

クライアント側にガス代は不要。オンチェーン送金はファシリテーターが代行します。

---

## 仕組み

```
クライアント                  サーバー                    ファシリテーター
  │                              │                               │
  │── GET /api/premium ─────────>│                               │
  │                              │                               │
  │<─ 402 (payTo, amount, token)─│                               │
  │                              │                               │
  │ [EIP-3009署名をオフチェーンで生成]                           │
  │                              │                               │
  │── GET /api/premium ─────────>│                               │
  │   X-PAYMENT: <署名済み認可>  │── POST /api/verify ──────────>│
  │                              │<─ 200 OK ─────────────────────│
  │                              │                               │
  │                              │── POST /api/settle ──────────>│
  │                              │              [オンチェーン送金を実行]
  │                              │<─ 200 OK ─────────────────────│
  │                              │                               │
  │<─ 200 (コンテンツ) ─────────│                               │
```

---

## 必要なもの

- Node.js 18以上
- Polygon mainnet上にJPYCを持つウォレット
  - JPYCの購入: [jpyc.co.jp](https://jpyc.co.jp)
  - トークンコントラクト: `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29`（小数点6桁）
- x402-jpycダッシュボードで発行したAPIキー
  - ダッシュボード: [x402-jpyc.vercel.app/dashboard](https://x402-jpyc.vercel.app/dashboard)
  - キー作成時に受取ウォレットアドレスを登録してください

---

## クイックスタート

### 1. クローンとインストール

```bash
git clone https://github.com/your-org/x402-jpyc-example
cd x402-jpyc-example

cd server && npm install && cd ..
cd client && npm install && cd ..
```

### 2. 環境変数の設定

`.env.example` を `.env` にコピーして値を設定します：

```bash
cp .env.example .env
```

```env
# x402-jpycダッシュボードで発行したAPIキー（受取アドレスに紐付き）
X402_API_KEY=jpyc_sk_...

# JPYCで支払うウォレットの秘密鍵
PRIVATE_KEY=0x...
```

> **警告:** `.env` は絶対にコミットしないでください。`.gitignore` に設定済みです。

### 3. サーバーを起動

```bash
cd server
npm run dev
```

起動ログの例：

```
payTo:   0x3f02...         ← ファシリテーターから取得した受取アドレス
network: eip155:137
token:   0xe7c3...
Server listening at http://localhost:3000
```

### 4. クライアントを実行

```bash
cd client
npm start
```

実行結果の例：

```
Step 1: 402を受信...
payTo:   0x3f02...
amount:  1000000

Step 2: EIP-3009署名を生成...

Step 3: サーバーに送信...
Status: 200
{"data":"Premium content here"}

JPYC x402 決済成功！
```

---

## 環境変数一覧

| 変数名 | 必須 | 説明 |
|---|---|---|
| `X402_API_KEY` | ✅ サーバー | ダッシュボードで発行したAPIキー。受取アドレスに紐付いています |
| `X402_FACILITATOR_URL` | ✅ サーバー | ファシリテーターURL。ダッシュボードで確認してください |
| `PRIVATE_KEY` | ✅ クライアント | JPYCで支払うウォレットの秘密鍵 |
| `SERVER_URL` | — | クライアントが接続するサーバーURL。省略時は `http://localhost:3000` |

---

## 決済フロー（詳細）

| ステップ | 誰が | 何をするか |
|---|---|---|
| 1 | クライアント → サーバー | 支払いなしで `GET /api/premium` |
| 2 | サーバー → クライアント | `402` で `payTo`・`amount`・`token` を通知 |
| 3 | クライアント | EIP-3009 `TransferWithAuthorization` をオフチェーンで署名（ガス不要） |
| 4 | クライアント → サーバー | `X-PAYMENT` ヘッダー付きで `GET /api/premium` |
| 5 | サーバー → ファシリテーター | `POST /api/verify` — 署名と金額を検証 |
| 6 | サーバー → ファシリテーター | `POST /api/settle` — オンチェーンで `transferWithAuthorization` を実行、nonceを使用済みに |
| 7 | サーバー → クライアント | `200` でコンテンツを返す |

**リプレイアタック対策**: EIP-3009認可のnonceはランダム32バイトです。settle後にnonceがオンチェーンに記録され、同じ署名の使い回しができません。

---

## カスタマイズ

### 価格を変更する

`server/index.ts` の `AMOUNT` を編集：

```ts
const AMOUNT = "1000000"; // 1 JPYC（小数点6桁）
```

| 値 | JPYC |
|---|---|
| `100000` | 0.1 JPYC |
| `1000000` | 1 JPYC |
| `10000000` | 10 JPYC |

### エンドポイントを変更する

`server/index.ts` の `/api/premium` を任意のパスとコンテンツに変更してください。

---

## 本番運用時の注意

- **HTTPSを使用すること**: `X-PAYMENT` ヘッダーには署名済み認可が含まれます。本番環境では必ずTLSを使用してください。
- **秘密鍵の管理**: 本番環境では生の秘密鍵を使わないこと。ハードウェアウォレット・HSM・KMSを使用してください。
- **レートリミット**: APIキー単位のレートリミットはファシリテーター側で管理されます。IP単位の制限が必要な場合はサーバー側に追加してください。

---

## よくあるエラー

**`Missing required environment variable: X402_API_KEY`**
プロジェクトルートに `.env` が存在し、`X402_API_KEY` が設定されているか確認してください。

**`payment-info failed: 401`**
APIキーが無効または未登録です。ダッシュボードを確認してください。

**`EADDRINUSE: address already in use :::3000`**
```bash
kill $(lsof -t -i:3000)
```

**`Payment verification failed`**
- 支払いウォレットにJPYCが十分あるか確認してください
- ダッシュボードのログでファシリテーター側のエラーを確認してください

---

## 最初の取引の証明

| 項目 | 値 |
|---|---|
| 日時 | 2026-04-10 |
| txHash | [0x35c00930...](https://polygonscan.com/tx/0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f) |
| ブロック | 85338927 (Polygon mainnet) |
| トークン | [JPYC](https://polygonscan.com/token/0xe7c3d8c9a439fede00d2600032d5db0be71c3c29) |
