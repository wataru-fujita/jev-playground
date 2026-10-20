# jev-playground

TypeSafe の AI モデル JEV を、手を動かして理解するための小さなアプリです。
Hugging Face のモデルを選び、用途と端末を決めて、JEV に「説明文だけ」と「数値データ」の 2 通りで判定させます。コードで計算した結果と並べて比べられます。

背景と、試して分かったことは、Zenn の記事にまとめています。
[JEV を理解するために、Hugging Face のモデルと手持ちの端末を題材にした判定アプリを作った](https://zenn.dev/wataru_fujita/articles/jev-model-judge-app-local)

## 中身

| フォルダ | 内容 |
|---|---|
| [`local/`](local/) | 自分の PC で動く版。Node.js だけで動く小さなサーバーと、1 枚の HTML。Tailscale 経由で、スマホから見ることもできる |
| [`azure/`](azure/) | Azure Static Web Apps + Functions に置く版。合言葉(人ごとにも発行できる)で API を守る |

どちらも、同じ画面と同じ質問を使っています。`eval.js`(容量と速さの計算)は、`local/public/`、`azure/app/`、`azure/api/src/` に、同じ内容を置いています。

## 必要なもの

- Node.js(`local/` は、`node file.ts` で TypeScript を直接実行できる Node.js 22.18 以降または 24 を想定)
- JEV の API キー(TypeSafe のコンソールで発行し、環境変数 `TYPESAFE_API_KEY` に入れる)

JEV の料金は、公式の models ページで、入力 100 万トークンあたり 0.042 ドル、出力は無料と書かれています(2026 年 10 月時点)。この画面での判定は、1 回あたり 0.0001 ドル未満でした(手元で測った範囲)。

## 端末の設定

端末の容量と帯域の定義は、`devices.example.json` にあります。最初の端末は筆者の自作 PC(Radeon RX Vega 56 / VRAM 8GB、メモリ 16GB)で、「VRAM に載らない」「メインメモリに溢れて遅い」といった、弱い端末での判定の挙動を見るための例として残しています。自分の PC を入れたいときは、これをコピーして `devices.json` を作り、書き換えます。`devices.json` は Git の対象外です。ファイルがなければ、例のほうを読み込みます。

```json
{
  "id": "home-pc",
  "name": "自作PC(Vega 56)",
  "default": true,
  "pools": [
    { "name": "VRAM(HBM2)", "gb": 8, "bw": 410, "ratio": 1 },
    { "name": "メインメモリ(DDR4)", "gb": 16, "bw": 34, "ratio": 0.75 }
  ]
}
```

- `pools`: 端末が持つメモリの領域。`gb` は容量、`bw` は帯域(GB/s)、`ratio` はモデルに使える割合です
- `default`: 最初から選択された状態にするか

帯域の数値は、公開資料などに基づく目安です。機種によっては暫定値なので、正確さが必要なときは、公式の仕様を確認してください。

## キーの置き場所

`.env` に `TYPESAFE_API_KEY` を書いて読み込みます。**OneDrive などの同期フォルダに置くと、キーがクラウドにコピーされます。** 同期されない場所に置いて、`JEV_ENV_FILE` で指すのがおすすめです。`.env` は Git の対象外です。

## 動かす

- PC で動かす: [`local/`](local/) で `npm install` し、`npm start`(`local/.env` を読みます)。http://localhost:3210 を開く。`.env` を別の場所に置いたときは、`node --env-file=<パス> server.ts`
- スマホから見る(Tailscale): `npm run start:vpn`(Windows)。サーバーは、Tailscale の IP だけで待ち受けます(`0.0.0.0` では待ち受けません。この画面は API のクレジットを使うため)。`JEV_ENV_FILE` で `.env` の場所を指せます
- Azure に置く: [`azure/README.md`](azure/README.md)

## 未検証のこと

- 速さの計算式(帯域 ÷ サイズ × 0.5)と、用途ごとの最低ラインは、仮置きの値です
- JEV の確率が、実際の正解率とどれくらい合うかは、評価していません
