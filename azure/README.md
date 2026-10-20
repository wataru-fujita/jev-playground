# azure — Azure Static Web Apps + Functions 版

画面(静的ファイル)を Azure Static Web Apps(SWA)で配信し、API を SWA のマネージド関数(Azure Functions)で動かす版です。
Azure のリソースを作るところから試せるように、手順を残しています。

## 構成

```
azure/
  app/                       静的ファイル(画面)。SWA が配信する
    index.html               合言葉の入力欄 + 画面。API には x-app-password ヘッダを付けて呼ぶ
    eval.js                  容量・速さの計算(ブラウザ側)
    staticwebapp.config.json SWA の設定(API のランタイムは node:22)
  api/                       Azure Functions
    src/functions/api.js     /api/models, /api/questions, /api/judge
    src/lib.js               共通処理(合言葉の確認、Hugging Face の取得、JEV の呼び出し)
    src/eval.js              app/eval.js の複製(`npm run sync` で揃える)
    devices.example.json     端末の定義の例(自分用は devices.json を作る。下を参照)
```

## 合言葉(簡易認証)のしくみ

- 画面(HTML)は公開です。入っているのは、秘密ではないコードだけです。
- API は、リクエストのヘッダ `x-app-password` が合言葉と一致しないと 401 を返します。
- 合言葉は、アプリケーション設定に入れます。
  - `APP_PASSWORD`: 管理者用の合言葉(1 つ)。回数制限なし。
  - `APP_USERS`: 人ごとの合言葉。`名前:合言葉,名前:合言葉` の形で、名前は英数字・`_`・`-`。1 人につき 1 日 `DAILY_JUDGE_LIMIT` 回(既定 100)まで。
- 弱点: 総当たりを防ぐ仕組みは、失敗時の 0.8 秒待ちだけです。**長くて推測されにくい合言葉**にしてください。回数の制限はメモリ上の簡易なもので、再起動でリセットされます。
- 費用の上限は、JEV のクレジット残高です(前払いで、自動チャージをオフにしておく)。

## 端末の設定

端末(容量・帯域)の定義は `api/devices.example.json` にあります。自分の PC を入れたいときは、これをコピーして `api/devices.json` を作り、書き換えます(`devices.json` は Git の対象外です。Azure へのデプロイには、手元にあれば含まれます)。

## ローカルで動かす(Azure なし)

道具(未インストールなら):

```powershell
npm install -g @azure/static-web-apps-cli azure-functions-core-tools@4
npm --prefix api install
```

`.env` を用意します(`TYPESAFE_API_KEY` と、`APP_PASSWORD` または `APP_USERS`)。クラウド同期のフォルダには置かず、別の場所に作って `JEV_ENV_FILE` で指すのが安全です。

```powershell
$env:JEV_ENV_FILE = "C:\path\to\.env"
.\start-local.ps1
```

http://localhost:4280 で画面が開きます。Functions Core Tools が、手元の Node(新しすぎる場合)に対応していないときは、Node 22 のフォルダを `JEV_NODE22_BIN` に指定してください。

## Azure に置く手順(コマンドは、実行前に `--help` で確認してください)

リソースの関係: **サブスクリプション > リソースグループ > Static Web App**。
消すときは、リソースグループごと消せば、料金は止まります。

1. ログイン: `az login`
2. リソースグループ: `az group create -n rg-jev-learn -l eastasia`
3. Static Web App(Free): `az staticwebapp create -n swa-jev-learn -g rg-jev-learn -l eastasia --sku Free`
   - SWA が使えるリージョンは限られます。エラーが出たら、公式を確認してください。
4. アプリケーション設定(キーと合言葉。コードには書かない):
   `az staticwebapp appsettings set -n swa-jev-learn -g rg-jev-learn --setting-names TYPESAFE_API_KEY=... APP_PASSWORD=...`
5. デプロイ用トークンの取得(秘密です。チャットや Git に出さない):
   `az staticwebapp secrets list -n swa-jev-learn -g rg-jev-learn --query properties.apiKey -o tsv`
6. デプロイ: `swa deploy app --api-location api --env production`(トークンは環境変数 `SWA_CLI_DEPLOYMENT_TOKEN` に入れる)
7. 確認: 発行された `https://〜.azurestaticapps.net` を開いて、合言葉を入れる。
8. 後片付け: `az group delete -n rg-jev-learn`

予算アラートは、リソースを作る前に設定しておくと安心です(通知だけで、自動では止まりません)。

## 注意

- マネージド関数の制約: HTTP トリガーのみ。マネージド ID と Key Vault 参照は使えません([Microsoft Learn](https://learn.microsoft.com/azure/static-web-apps/apis-functions))。
- 判定ログ(`usage-log.jsonl`)は、Azure 版では出しません。トークン数と料金の目安は、画面の結果に出ます。誰が使ったかなどのログを見たいときは、Application Insights を有効にしてください(私の環境では未設定です)。
- Free プランでの関数の実行回数・時間の上限は、実行前に公式の quotas のページで確認してください。
