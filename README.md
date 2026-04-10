# x402-jpyc-example

Example implementation of JPYC payments using the x402 protocol.

## What is this?

Server and client example for paying with JPYC (Japanese Yen stablecoin)
via the x402 protocol on Polygon mainnet.

## Prerequisites

- EVM wallet (e.g. MetaMask)
- JPYC on Polygon mainnet (get it at [jpyc.co.jp](https://jpyc.co.jp))
- A small amount of MATIC for gas (a few cents worth)
- Node.js 18 or later

## Step by Step

### 1. Get JPYC

1. Go to [JPYC EX (jpyc.co.jp)](https://jpyc.co.jp) and complete My Number Card (マイナンバーカード) verification
2. Purchase JPYC via bank transfer — it will be issued to your wallet
3. Add the Polygon network to MetaMask if you haven't already
4. Add the JPYC token to MetaMask:
   - Contract address: `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29`
   - Symbol: JPYC
   - Decimals: 18

### 2. Permit2 Approval (first time only)

The client handles this automatically on first run. Permit2 approval is a one-time transaction that allows the x402 facilitator to move JPYC on your behalf using EIP-712 signatures — no gas is needed for subsequent payments.

### 3. Set Environment Variables

**Server side** — the wallet that will *receive* JPYC:

| Variable | Description | Example |
|----------|-------------|---------|
| `EVM_ADDRESS` | Wallet address to receive JPYC (42 chars, starts with `0x`) | `0xD111...890D2` |

**Client side** — the wallet that will *pay* with JPYC:

| Variable | Description | Example |
|----------|-------------|---------|
| `PRIVATE_KEY` | Private key of the paying wallet (66 chars, starts with `0x`) | `0xabc1...def2` |

> **Warning:** Never share or commit your private key. Add `.env` to `.gitignore`.

### 4. Start the Server

```bash
cd server
npm install
export EVM_ADDRESS=0x...
npm run dev
# → Server listening at http://localhost:4021
```

### 5. Run the Client

```bash
cd client
npm install
export PRIVATE_KEY=0x...
npx tsx jpyc.ts
# → 200 OK {"report":{"weather":"sunny","temperature":70}}
```

## Architecture

```
Client
  │
  │  1. GET /weather (no payment)
  ▼
Server
  │
  │  2. 402 Payment Required
  ▼
Client
  │  3. Generate Permit2 EIP-712 signature (off-chain, no gas)
  │  4. GET /weather with X-PAYMENT header
  ▼
Server
  │
  │  5. POST /api/verify
  ▼
x402-jpyc facilitator
  │  6. Execute Permit2.permitTransferFrom on-chain
  │  7. { isValid: true }
  ▼
Server
  │
  │  8. 200 OK
  ▼
Client
```

## Troubleshooting

**`EADDRINUSE: address already in use :::4021`**
Another process is using port 4021. Kill it and restart:
```bash
kill $(lsof -t -i:4021)
```

**`Missing required environment variable: EVM_ADDRESS` / `PRIVATE_KEY`**
Export the variable in the same terminal session before running:
```bash
export EVM_ADDRESS=0x...
```

**`Transaction failed` / `insufficient funds`**
Your wallet may not have enough MATIC to cover gas. Send a small amount (≈0.01 MATIC) to your wallet on Polygon mainnet.

## Proof of First Transaction

| Field | Value |
|-------|-------|
| Date | 2026-04-10 |
| txHash | [0x35c00930...](https://polygonscan.com/tx/0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f) |
| Block | 85338927 (Polygon mainnet) |
| Token | [JPYC](https://polygonscan.com/token/0xe7c3d8c9a439fede00d2600032d5db0be71c3c29) |
| Flow | evm-erc20-transfer (first) → Permit2 (current) |

---

# x402-jpyc-example（日本語）

JPYCでx402決済を行うサンプル実装です。

## これは何か

x402プロトコルを使ってJPYC（日本円ステーブルコイン）でAPIアクセス料金を支払う、
サーバーとクライアントのサンプル実装です。Polygon mainnet上で動作します。

## 必要なもの

- EVMウォレット（MetaMaskなど）
- Polygon mainnet上のJPYC（取得方法: [jpyc.co.jp](https://jpyc.co.jp)）
- ガス代用のMATIC（数円分）
- Node.js 18以上

## 手順

### 1. JPYCを取得する

1. [JPYC EX（jpyc.co.jp）](https://jpyc.co.jp) でマイナンバーカード認証を完了する
2. 銀行振込でJPYCを購入 — ウォレットに発行される
3. MetaMaskにPolygonネットワークを追加する（未設定の場合）
4. MetaMaskにJPYCトークンを追加する：
   - コントラクトアドレス: `0xe7c3d8c9a439fede00d2600032d5db0be71c3c29`
   - シンボル: JPYC
   - 小数点以下の桁数: 18

### 2. Permit2のapprove（初回のみ）

クライアントが初回実行時に自動でapproveします。これはx402ファシリテーターがJPYCを代理送金できるよう許可するための1回限りのトランザクションです。以降の決済はEIP-712署名のみでガス代がかかりません。

### 3. 環境変数の設定

**サーバー側** — JPYCを「受け取る」ウォレット：

| 変数名 | 説明 | 例 |
|--------|------|----|
| `EVM_ADDRESS` | JPYCの受取ウォレットアドレス（`0x`から始まる42文字） | `0xD111...890D2` |

**クライアント側** — JPYCで「支払う」ウォレット：

| 変数名 | 説明 | 例 |
|--------|------|----|
| `PRIVATE_KEY` | 支払いウォレットの秘密鍵（`0x`から始まる66文字） | `0xabc1...def2` |

> **警告:** 秘密鍵は絶対に公開・コミットしないこと。`.env` を `.gitignore` に追加してください。

### 4. サーバーを起動する

```bash
cd server
npm install
export EVM_ADDRESS=0x...
npm run dev
# → Server listening at http://localhost:4021
```

### 5. クライアントを実行する

```bash
cd client
npm install
export PRIVATE_KEY=0x...
npx tsx jpyc.ts
# → 200 OK {"report":{"weather":"sunny","temperature":70}}
```

## アーキテクチャ

```
クライアント
  │
  │  1. GET /weather（支払いなし）
  ▼
サーバー
  │
  │  2. 402 Payment Required
  ▼
クライアント
  │  3. Permit2 EIP-712署名を生成（オフチェーン、ガス不要）
  │  4. X-PAYMENTヘッダー付きでGET /weather
  ▼
サーバー
  │
  │  5. POST /api/verify
  ▼
x402-jpyc facilitator
  │  6. Permit2.permitTransferFromをオンチェーンで実行
  │  7. { isValid: true }
  ▼
サーバー
  │
  │  8. 200 OK
  ▼
クライアント
```

## よくあるエラー

**`EADDRINUSE: address already in use :::4021`**
ポート4021が別プロセスに使われています。終了させて再起動してください：
```bash
kill $(lsof -t -i:4021)
```

**`Missing required environment variable: EVM_ADDRESS` / `PRIVATE_KEY`**
実行前に同じターミナルセッションで環境変数をexportしてください：
```bash
export EVM_ADDRESS=0x...
```

**`Transaction failed` / `insufficient funds`**
MATICのガス代が不足している可能性があります。Polygon mainnet上のウォレットに少量のMATIC（≈0.01 MATIC）を送金してください。

## 最初の取引の証明

| 項目 | 値 |
|------|----|
| 日時 | 2026-04-10 |
| txHash | [0x35c00930...](https://polygonscan.com/tx/0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f) |
| ブロック | 85338927 (Polygon mainnet) |
| トークン | [JPYC](https://polygonscan.com/token/0xe7c3d8c9a439fede00d2600032d5db0be71c3c29) |
| フロー | evm-erc20-transfer（初回）→ Permit2（現在） |
