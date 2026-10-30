# 創作キャラクター専用 Misskey

この公開 fork は、本人1人と選択した創作キャラ／機能Botのためのローカルサーバです。
**インターネットに公開せず、LAN/VPNとホストのファイアウォールで到達範囲を制限してください。**
連合無効はネットワークのアクセス制御や、全ファイル／未認証APIの非公開化を意味しません。
初期設定画面を他人に開かせないでください。

## 開発PCで起動

Node.js、Git、Docker Desktop、リポジトリ指定のpnpmが必要です。Nodeの対応版は
`packages/backend/package.json` の `engines` を参照してください。
今回の開発起動は Node 24.16.0 / Docker Desktop 28.5.1 で確認しています。
pnpm が PATH にない場合は `npm exec --yes --package=pnpm@12.14.0 -- pnpm ...` で実行できます。

新しい隔離checkoutのルートから：

```powershell
node scripts\setup-creations-dev.mjs
docker compose -f compose.creations.yml up -d --wait
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm migrate
corepack pnpm start
```

`http://localhost:61820` で本人の初回管理者を作成します。既存の `default.yml` やDB設定は
setupスクリプトが読み出したり上書きしたりしません。既存設定がある場合はエラーで止まります。
DB/Redis はこの開発用composeのloopbackポート `65432` / `56379` と独立volumeを使います。
終了はアプリのターミナルでCtrl+C、DB/Redisは次で停止します（volumeは残ります）：

```powershell
docker compose -f compose.creations.yml stop
```

スマホで使う場合は、初回利用前に `.config/default.yml` の `url` をLAN/VPNで到達できる
固定ホスト名に設定し、HTTPSリバースプロキシとファイアウォールを用意してください。
稼働開始後のMisskey URL変更は避けてください。常設環境の自動構築は含みません。

## カタログと許諾

管理画面 → **創作キャラクター** (`/admin/creations`) で
CreationsAI の `ai-dataset\manifest.jsonl` の絶対パスを指定して読み込みます。
作品単位の `works\*.json` の `characters[]` も読めます。
全作品を含むJSONLでは `_type === 'character'` の行だけを対象にします。

依存する公開契約は
[radiann-kswg/100BeautiesLab_CreationsDB#47](https://github.com/radiann-kswg/100BeautiesLab_CreationsDB/pull/47)
（統合先 `addon-ai-tag`、head `a6ed104622adc2ed8ce243bd16f579494a14f481`）と
[radiann-kswg/100BeautiesLab_CreationsAI#3](https://github.com/radiann-kswg/100BeautiesLab_CreationsAI/pull/3)
（head `825097ebd0774737e2ee8943ed72791cc3fc2566`）です。
これらのPRと、既定ブランチ／公開Workerに反映済みのデータを混同しないでください。
同refのカタログは11作品738件ですが、現時点でRP許可済みは0件です。

実行条件は **`text_rp_inference.status === 'allowed'`、`allowed === true`、
正規 `record_identity`、許可済みテキスト本文のすべてが揃うこと**です。
原本の `AI_TextRP_Allowed` が補完後trueのものだけを使い、
`AI_Optout`、考案者の `isOwner`、画像や学習用の許可から推論許可を推定しません。
既存学習・画像／デザインの設定は変更しません。

未確認のキャラは、権利者の許諾を確認し、DBの**該当レコード**の
`AI_TextRP_Allowed` を明示的にtrueにしてから、CreationsAIの手順で再生成し、
アプリのカタログを読み直してそのキャラだけ有効化してください。
アプリ内に独自の許諾上書きはありません。既存DB pinを無断で更新せず、
生成に使うDB ref／公開APIの許諾反映も確認してください。

登録キーは `work_key + db_key + 全index条件`（複合Indexの分類を含む）です。
表示名や番号だけでは識別しません。初めて選んだときだけ決定的なユーザー名の
ローカルBotアカウントを1つ作り、通常会話と機能Botで共有します。
無効化してもアカウントや投稿は削除しません。カタログ欠落・不許可への変更時は生成を停止します。

参照本文はAI側の限定projectionに対し、アプリでも同じ名前／人称／性格／趣味／
好み／会話パターンの許可テキストキーだけを再抽出します。
画像、デザイン、AIHints、任意オブジェクト、旧RP Markdownは送信しません。

## 外部LLMと予算

秘密鍵は新しいサーバプロセスの環境に設定します。既存Botの主コピー、`.env`、
旧Misskeyトークンから自動回収しません。鍵をチャット、コマンド引数、ログ、
リポジトリに貼らないでください。`CREATIONS_OPENAI_API_KEY` /
`CREATIONS_GEMINI_API_KEY` が通常会話用、
`CREATIONS_ANTHROPIC_API_KEY` が下記の独立Bot用です。
サービス／ターミナルの秘密情報入力機能から設定し、アプリを起動し直してください。

管理画面でOpenAIまたはGeminiとモデルを明示選択し、現在の料金・為替から
**入力／出力100万トークン当たりの概算円単価**を入力します。
別providerへのフォールバックはしません。Geminiは有料APIだけを使ってください。
保存・学習利用条件の確認チェックがない間は送信しません。

通常会話、自発投稿、自然文振り分けは月3000円の同じ概算台帳です。
入力UTF-8 byte数と出力上限で事前予約し、応答のusageで精算します。
単価未設定、usage不明、通信失敗はゼロ扱いせず予約額を残します。
費用不明と予算到達時は停止理由を管理画面に表示し、返信時には運用エラーも通知します。
料金・トークン計数・為替・税の変化を含む**実請求額の厳密な保証ではありません**。
費用不明後は残された予約を確認し、停止理由を解消して明示的に再起動してください。
月境界・日境界は日本時間です。

確認した提供元資料（2026-10-30）：

- [OpenAI API Data controls](https://developers.openai.com/api/docs/guides/your-data):
  API入力は明示opt-inなしに学習に使われませんが、通常は不正利用監視等の保持があり、
  `store:false` はすべての保持をなくす指定ではありません。
- [Gemini API Terms](https://ai.google.dev/gemini-api/terms):
  無料枠は製品改善・人手レビュー対象になり得るため使用しません。
  有効な課金アカウントを関連付けたPaid Servicesの非学習条件と保持・利用制限を確認してください。
- [Anthropic commercial API data use](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training):
  商用APIの入力／出力は通常学習に使われません。feedback等の別opt-inを行わず、
  保持・例外条件を別途確認してください。

このアプリは学習／ファインチューニング、画像入力、検索・長期記憶・自動要約を行いません。

## APHRNTs_100 / Tarot-byFateLineDealer

```powershell
node scripts\creations-bots\install.mjs all
```

Python 3.11+（venv/pip付き）が必要です。Windows Storeの `python` aliasだけでは動きません。
installerは既存の `py -3` / `uv python find` も探索し、専用venvを作ります。
グローバルPATHや既存Botのコピーを変更しません。
詳細、固定ref、ライセンス、実際に再利用する関数、テストは
[`scripts/creations-bots/README.md`](../scripts/creations-bots/README.md) にあります。
元ソースとCC BY-NCライセンスは独立した無視対象checkoutに保持し、AGPLへ混入しません。

管理画面でそれぞれモデル（空欄は元Botの既定値）、別の月間概算予算、
1実行当たりの保守的概算円額、データ利用条件を設定し、起動／停止します。
1実行概算が不明なら起動できません。Bot台帳は通常会話3000円枠と独立です。
キャラ欄で利用する機能を選びます。普通に話しかけると中央のAIが会話／許可機能／確認に
振り分け、どれか1つだけを実行・投稿します。LLM出力をコードやshellコマンドにはしません。
元Botの受信ループ、自動投稿、過去の会話記憶は起動せず、画像添付も行いません。

本人から**明示メンション**された投稿だけが自動返信対象です。
独り言、暗黙の返信先、Bot投稿／Bot間メンションは起動条件ではありません。
スレッドは本人と対象キャラのものだけ、直近参照もそのキャラ自身のpublic/home投稿だけです。
public投稿への返信はローカルpublic、homeへはhome、その他の制限投稿へは本人だけへの
specified返信とし、Botのフォロワーへ公開範囲を広げません。
LTLの「返信を含む」フィルターでpublic返信を閲覧できます。

自発投稿は選択キャラで明示的に許可した場合だけです。未フォローは全員合計12件/日まで、
フォロー中はその枠外でキャラごとに日別4～6件を上限にします。
普通のAIと機能Botで枠を二重化せず、返信は自発枠に含みません。
有効な機能Botがある場合、自発枠は通常投稿と許可機能を順番に使い、
機能Botの生成費用はそれぞれの別予算へ記録します。
停止中の穴埋めはせず、再起動後は新しい時刻へ散らします。
失敗／クラッシュ時の枠は安全側に消費したままにするため、生成できない日は上限より少なくなります。

## 保管と障害時

会話はこのサーバのDB、個別設定・重複処理・概算台帳は無視対象の
`.config/creations.sqlite`（WAL等を含む）に保存します。これらをgitに含めないでください。
初期化設定・DB volume・ドライブ・バックアップも本人の管理対象です。
旧投稿、フォロー、リスト、画像の移行はありません。
独立BotにはMisskeyの受信／投稿トークンを渡さず、中央サービスが内部で投稿するため、
旧トークンは不要です。手動で別クライアントを接続するなら新サーバで発行し直してください。

重複防止は投稿IDを生成前に永続claimする**at-most-once**方式です。
生成／投稿の境界でクラッシュすると返信を失う可能性がありますが、自動再実行による
二重返信はしません。理由を解消して本人が新しいメンションを投稿してください。
停止操作は実行中の通常生成・既知workerも中断し、中断後の結果を投稿しません。
