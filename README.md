# x402-jpyc-example

Example implementation of JPYC payments using the x402 protocol.

## What is this?

Server and client example for paying with JPYC (Japanese Yen stablecoin)
via the x402 protocol on Polygon mainnet.

## Prerequisites

- JPYC on Polygon mainnet
- Polygon wallet with MATIC for gas
- [x402-jpyc facilitator](https://x402-jpyc.vercel.app) running

## Architecture

```
Client → Server → x402-jpyc facilitator → Polygon mainnet (Permit2)
```

## Payment Flow

1. Client sends GET /weather (no payment)
2. Server responds with 402 + payment requirements
3. Client signs a Permit2 EIP-712 permit (off-chain, no gas)
4. Client sends X-PAYMENT header with the permit signature
5. Facilitator executes `Permit2.permitTransferFrom` on-chain
6. Server returns 200 OK with weather data

## Quick Start

### Server

```bash
cd server
npm install
export EVM_ADDRESS=0x...   # wallet address to receive JPYC
npm run dev
# → Server listening at http://localhost:4021
```

### Client

```bash
cd client
npm install
export PRIVATE_KEY=0x...   # wallet private key (must hold JPYC)
npx tsx jpyc.ts
# → 200 OK {"report":{"weather":"sunny","temperature":70}}
```

## Facilitator

**URL:** https://x402-jpyc.vercel.app

Handles Permit2 signature verification and on-chain settlement for JPYC.

## Proof of First Transaction

| Field   | Value |
|---------|-------|
| Date    | 2026-04-10 |
| txHash  | [0x35c00930...](https://polygonscan.com/tx/0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f) |
| Block   | 85338927 (Polygon mainnet) |
| Token   | [JPYC](https://polygonscan.com/token/0xe7c3d8c9a439fede00d2600032d5db0be71c3c29) |
| Flow    | evm-erc20-transfer (first) → Permit2 (current) |

---

# x402-jpyc-example（日本語）

JPYCでx402決済を行うサンプル実装です。

## これは何か

x402プロトコルを使ってJPYC（日本円ステーブルコイン）でAPIアクセス料金を支払う、
サーバーとクライアントのサンプル実装です。Polygon mainnet上で動作します。

## 必要なもの

- Polygon mainnet上のJPYC
- ガス代用のMATIC（初回のPermit2 approve のみ必要）
- [x402-jpyc facilitator](https://x402-jpyc.vercel.app)

## アーキテクチャ

```
クライアント → サーバー → x402-jpyc facilitator → Polygon mainnet (Permit2)
```

## 決済フロー

1. クライアントが GET /weather を送信（支払いなし）
2. サーバーが 402 + 支払い要件を返す
3. クライアントが Permit2 EIP-712 署名を生成（オフチェーン、ガス不要）
4. X-PAYMENT ヘッダーに署名を入れて再送信
5. ファシリテーターがオンチェーンで `Permit2.permitTransferFrom` を実行
6. サーバーが 200 OK を返す

## クイックスタート

### サーバー起動

```bash
cd server
npm install
export EVM_ADDRESS=0x...   # JPYC受取アドレス
npm run dev
```

### クライアント実行

```bash
cd client
npm install
export PRIVATE_KEY=0x...   # JPYCを持つウォレットの秘密鍵
npx tsx jpyc.ts
```

## Facilitator

**URL:** https://x402-jpyc.vercel.app

JPYCのPermit2署名を検証し、オンチェーン決済を実行します。

## 最初の取引の証明

| 項目 | 値 |
|------|-----|
| 日時 | 2026-04-10 |
| txHash | [0x35c00930...](https://polygonscan.com/tx/0x35c00930d65a47dc00c86f686df9175ed1b1c4db731687acac2658e3432b8c8f) |
| ブロック | 85338927 (Polygon mainnet) |
| トークン | [JPYC](https://polygonscan.com/token/0xe7c3d8c9a439fede00d2600032d5db0be71c3c29) |
| フロー | evm-erc20-transfer（初回）→ Permit2（現在） |
