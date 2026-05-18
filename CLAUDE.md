# アトピーカルテ — プロジェクト情報

## (1) 当初やりたかったこと

はまこどもクリニックの診療フローをデジタル化する：

1. **患者来院時のQRコード問診**
   - 医師がアプリ上で患者IDと4桁トークンを生成 → QRコード作成
   - 患者がスマホでQRを読み取り、来院前アンケートを入力
   - 入力内容：薬の残量・症状スコア・POEMスコア・医師への質問
   - 送信 → Google Sheetsに自動保存

2. **医師によるiPadでの確認・コメント記入**
   - 患者の回答・前回処方履歴をiPad Chromeで確認
   - 「医師コメント」（処方方針・次回受診日）を入力して保存

3. **将来的にPOEMスコアを診療記録に活用**
   - 経過観察・症状の推移トラッキング

---

## (2) 現在の状況

### 完成済み
- [x] `gas/Code.gs` — GASサーバー本体（ルーティング・トークン管理・API関数）
- [x] `gas/patient_form.html` — 患者スマホ向けフォーム（症状・POEM・薬残量）
- [x] `gas/doctor_dashboard.html` — 医師iPad向けダッシュボード
- [x] `gas/shared_styles.html` — 共通CSS
- [x] `atopy_v9.html` に「📱 QRフォームを生成」ボタン追加
- [x] GASデプロイ済み

### デプロイ情報
- GASデプロイID: `AKfycbyYlP8b_E-X4tDYZQm6uDn3cbsaAcAezMjsJw4coN_nW-QCTbLqMtz0tkNShej1gLApYw`
- ベースURL: `https://script.google.com/macros/s/AKfycbyYlP8b_E-X4tDYZQm6uDn3cbsaAcAezMjsJw4coN_nW-QCTbLqMtz0tkNShej1gLApYw/exec`
- 患者フォーム: `...exec?page=form&p=患者番号&t=トークン`
- 医師ダッシュボード: `...exec?page=dashboard&secret=（スクリプトプロパティ参照）`

### 未解決の問題
- [ ] 患者フォームで「⚠️ QRコードが正しく読み取れませんでした」エラーが出る
  - 原因：GASはURLパラメータを `window.location.search` で取得できない
  - 対策済み：`patient_form.html` は `<?= patientNo ?>` テンプレート変数方式に修正済み
  - → 再デプロイ後の動作確認がまだ

---

## (3) TODO（今後の作業）

### 優先度：高（動作確認）
- [ ] `setupSheets()` をGASエディタから一度実行 → 4シートの自動作成
- [ ] `PatientRegistry` シートに患者情報を手入力（診察券番号・名前・年齢グループ・メモ）
- [ ] 患者フォームのE2Eテスト：QR生成→スキャン→認証→入力→送信→Sheets反映確認
- [ ] 医師ダッシュボードの動作確認（レポート表示・コメント保存）
- [ ] `atopy_v9.html` の `GAS_URL` を実際のデプロイURLに更新

### 優先度：中（運用準備）
- [ ] `VisitHistory` シートへの処方履歴入力（手動 or 同期ボタン）
- [ ] 患者フォームに表示される前回処方の確認
- [ ] iPad Chromeに医師ダッシュボードをブックマーク登録

### 優先度：低（将来機能）
- [ ] `atopy_v9.html` に「Sheetsへ同期」ボタン追加（処方履歴の自動送信）
- [ ] POEMスコアの推移グラフ・経過観察機能
- [ ] 患者フォームの回答をatopy_v9.htmlの診療記録に取り込む
- [ ] トークン5回失敗でロック機能のテスト・確認

---

## ファイル構成

```
gas/
├── Code.gs                # GASサーバー本体
├── patient_form.html      # 患者スマホ向けフォーム
├── doctor_dashboard.html  # 医師iPad向けダッシュボード
└── shared_styles.html     # 共通CSS（直接アクセス不可）
atopy_v9.html              # メインアプリ（localStorage・処方計算）
```

## スクリプト プロパティ（GASエディタで設定）
| プロパティ名 | 内容 |
|---|---|
| `SHEET_ID` | Google SheetsのスプレッドシートID |
| `CLINIC_SECRET` | 医師ダッシュボードアクセス用パスワード |

## Google Sheets 構成（4シート）
- `PatientRegistry` — 患者台帳・トークン管理
- `VisitHistory` — 処方履歴
- `PatientReports` — 患者フォーム回答
- `AuditLog` — トークン認証ログ

## ローカル開発
```bash
cd gas
clasp push
# GASエディタ → デプロイを管理 → 鉛筆アイコン → 新しいバージョン → デプロイ
```

## 注意事項
- `CLINIC_SECRET` はソースコードに書かず、スクリプトプロパティで管理
- `コード.gs`（日本語）はGASエディタ上で削除済み。`Code.gs`（英語）のみ使用
- `patient_form.html` のパラメータ取得は `<?= patientNo ?>` テンプレート変数方式（URLSearchParamsは使えない）
