# アトピー性皮膚炎処方支援システム — システム設計書

> はまこどもクリニック向け。最終更新: 2026-05-28

---

## 1. システム全体構成

```
atopic-calculator/
├── atopic_calculator.html     # 処方計算アプリ（医師用・GitHub Pages）
├── reception.html             # QRコード発行画面（受付スタッフ用）
└── gas/
    ├── Code.gs                # GASサーバー本体（API・バリデーション）
    ├── patient_form.html      # 患者アンケートフォーム（QRスキャン後）
    ├── doctor_dashboard.html  # 医師確認ダッシュボード（iPad用）
    └── shared_styles.html     # 共通CSS
```

**ホスティング:**
- フロントエンド: GitHub Pages (`https://haman-360.github.io/atopic-calculator/`)
- バックエンド: Google Apps Script (GAS)
- DB: Google Sheets（6シート構成）

**デプロイ情報:**
- GASデプロイID: `AKfycbyYlP8b_E-X4tDYZQm6uDn3cbsaAcAezMjsJw4coN_nW-QCTbLqMtz0tkNShej1gLApYw`
- ベースURL: `https://script.google.com/macros/s/AKfycbyY.../exec`

---

## 2. 患者フロー全体図

2種類の認証フローが並存している。

### フロー A: 個別QR認証（reception.html 経由）

```
① 受付 (reception.html)
   受付スタッフが診察券番号 + 受診日を入力
   → 4桁トークン + ソルトをブラウザで生成
   → GAS doPost: registerToken（PatientRegistryのD〜G列を更新）
   → 患者ごとのQRコードを表示

② 患者アンケート (patient_form.html)
   患者がQRスキャン
   → URL: {GAS_URL}?page=form&p={患者番号}&t={トークン}
   → GASテンプレート変数 <?= patientNo ?> でパラメータ注入
   → google.script.run.getPatientContext(patientNo, token) で検証
   → 成功: フォーム表示 / 失敗: エラー画面
```

**認証の仕組み:**
- SHA-256(salt + token) をハッシュ化してシートに保存
- 有効期限: 7日間
- `isActive` フラグで無効化可能

### フロー B: 固定QR認証（DailyPIN方式）

```
① クリニックが院内に固定QRを掲示
   → URL: {GAS_URL}?mode=fixed&form=atopic_dermatitis

② 患者がQRスキャン
   → 診察券番号 + 当日PIN を入力
   → google.script.run.validateFixedAuthNew(patientNo, pin) で検証
   
   既存患者（birthdate登録済み）:
   → 認証成功 → status='existing' → フォーム表示
   
   新患（birthdate未登録 or PatientRegistry未登録）:
   → status='new' → 生年月日入力画面へ
   → google.script.run.registerBirthdateAndGetContext(patientNo, pin, birthdate)
   → PatientRegistryに自動登録 → フォーム表示
```

**DailyPINの仕組み:**
- GASトリガーで毎朝8時(JST)に `generateDailyPin()` が自動実行
- 4桁ランダムPINをDailyPINシートに記録（date / pin / enabled）
- 受付スタッフが当日PINを患者に口頭または貼り紙で伝える
- PIN検証はJST当日かつ `enabled=true` の行のみ有効

### フロー C: アンケート送信 → 医師確認

```
③ 患者がフォームを送信
   → google.script.run.submitPatientReport / submitPatientReportFixed2
   → PatientReportsシートに保存（status='pending'）

④ 医師がダッシュボードで確認
   → ?page=dashboard&secret={CLINIC_SECRET}
   → 症状スコア・POEM・残薬・EASI/IGA入力
   → コメント + 次回受診日を保存（status='reviewed' or 'assessed'）

⑤ 医師が処方計算ツールで処方
   → atopic_calculator.html で計算
   → saveVisit で VisitHistory に保存
```

---

## 3. Google Sheets 構造（6シート）

### PatientRegistry（患者台帳）
| 列 | キー | 内容 |
|---|---|---|
| A | patientNo | 患者番号（テキスト書式、先頭0保持） |
| B | birthdate | 生年月日（YYYY-MM-DD、テキスト推奨） |
| C | notes | メモ |
| D | tokenHash | SHA256(salt + token) |
| E | tokenSalt | ランダムソルト |
| F | tokenExpiresAt | 有効期限（7日間） |
| G | isActive | 有効フラグ |

**運用ルール:**
- `patientNo`（A列）・`birthdate`（B列）はスプレッドシートに直接入力が正式運用
- reception.html はトークン列（D〜G）のみ更新。birthdate は送らない
- 固定QRフローで初診患者が生年月日を入力した場合のみGASが自動登録

### VisitHistory（処方履歴）
| 列 | キー | 内容 |
|---|---|---|
| A | patientNo | 患者番号 |
| B | visitDate | 受診日 |
| C | nextVisitDate | 次回受診予定日 |
| D | drugsJson | 処方内容JSON |
| E | rxSummaryText | テキスト要約 |

### PatientReports（患者アンケート回答）
| 列 | キー | 内容 |
|---|---|---|
| A | reportId | UUID |
| B | patientNo | 患者番号 |
| C | submittedAt | 送信日時（ISO8601） |
| D | symptomScore | 全体症状スコア（0〜4） |
| E | nrsScore | かゆみNRS（0〜10） |
| F | infectionSignsJson | 感染徴候JSON配列 |
| G | symptomNotes | 自由記述 |
| H | poemJson | POEMスコアJSON（7項目） |
| I | medicationJson | 残薬情報JSON |
| J | doctorComment | 医師コメント |
| K | nextAppointment | 次回受診日（医師入力） |
| L | commentAt | コメント保存日時 |
| M | status | `pending` / `reviewed` / `assessed` |
| N | triggersJson | 悪化因子JSON配列 |
| O | triggerNote | 悪化因子メモ |
| P | topicalUseJson | 部位別外用状況JSON |

### AuditLog（認証ログ）
| 列 | キー | 内容 |
|---|---|---|
| A | timestamp | 日時 |
| B | patientNo | 患者番号 |
| C | action | 操作内容 |

**記録されるaction値:**
- `token_valid` / `token_invalid` / `token_expired` / `token_inactive`
- `fixed_auth_ok` / `fixed_auth_fail` / `fixed_auth_new_patient`
- `fixed_birthdate_registered` / `fixed_new_patient_registered`
- `fixed_submit_ok`

### ClinicalAssessments（医師による重症度評価）
| 列 | キー | 内容 |
|---|---|---|
| A | assessmentId | UUID |
| B | patientNo | 患者番号 |
| C | visitDate | 受診日（YYYY-MM-DD） |
| D | assessedAt | 評価日時（ISO8601） |
| E | easiHead | EASI頭頸部スコア |
| F | easiTrunk | EASI体幹スコア |
| G | easiUpperLimb | EASI上肢スコア |
| H | easiLowerLimb | EASI下肢スコア |
| I | easiTotal | EASI合計 |
| J | easiSeverity | 重症度ラベル |
| K | iga | IGAスコア（0〜4） |
| L | lesionMapJson | 部位別皮疹JSON（将来用） |
| M | notes | 所見メモ |
| N | easiRawJson | EASI入力元データJSON |

**EASI重みの年齢分岐（8歳未満=小児）:**

| 部位 | 小児重み | 成人重み |
|---|---|---|
| 頭頸部 | 0.2 | 0.1 |
| 体幹 | 0.3 | 0.3 |
| 上肢 | 0.2 | 0.2 |
| 下肢 | 0.3 | 0.4 |

### DailyPIN（日次PIN管理）
| 列 | キー | 内容 |
|---|---|---|
| A | date | 日付（YYYY-MM-DD、テキスト書式） |
| B | pin | 4桁PIN |
| C | enabled | 有効フラグ（true/false） |

---

## 4. GAS API 一覧（Code.gs）

### doGet — ページ配信・JSONデータ取得

| パラメータ | 説明 |
|---|---|
| `?mode=fixed&form=atopic_dermatitis` | 固定QR用患者フォームを表示 |
| `?page=form&p={patientNo}&t={token}` | 個別QR用患者フォームを表示 |
| `?page=dashboard&secret={CLINIC_SECRET}` | 医師ダッシュボードを表示 |
| `?page=patientContext&p={patientNo}&t={token}` | 患者コンテキストをJSON返却 |
| `?page=getAssessment&id={assessmentId}` | 評価1件をJSON返却 |
| `?page=getAssessmentByVisit&p={patientNo}&d={visitDate}` | 指定受診日の評価をJSON返却 |
| `?page=getAssessmentList&p={patientNo}` | 患者の評価全履歴をJSON返却（降順） |

### google.script.run（クライアント→GAS呼び出し）

| 関数名 | 呼び出し元 | 処理 |
|---|---|---|
| `getPatientContext(patientNo, token)` | patient_form.html（個別QR） | トークン検証・前回処方取得 |
| `validateFixedAuthNew(patientNo, pin)` | patient_form.html（固定QR） | DailyPIN + 患者番号で認証。既存患者はコンテキスト返却、新患は `status='new'` |
| `registerBirthdateAndGetContext(patientNo, pin, birthdate)` | patient_form.html（固定QR新患） | PIN再検証 + birthdate登録 + コンテキスト返却 |
| `submitPatientReport(reportData)` | patient_form.html（個別QR） | トークン再検証してPatientReportsに保存 |
| `submitPatientReportFixed2(patientNo, pin, reportData)` | patient_form.html（固定QR） | PIN再検証してPatientReportsに保存 |
| `getDashboardData()` | doctor_dashboard.html | pending/reviewed レポート一覧取得 |
| `saveComment(reportId, comment, nextAppointment)` | doctor_dashboard.html | 医師コメント保存・status='reviewed' |
| `saveAssessment(data)` | doctor_dashboard.html | EASI/IGA評価を保存・status='assessed' |
| `getAssessmentList(patientNo)` | doctor_dashboard.html | 患者の評価履歴取得 |
| `getPatientConsultData(patientNo)` | doctor_dashboard.html | Claude相談用包括データ取得（処方歴・レポート5件・評価全件） |

### doPost（reception.html から fetch）

| action | 処理 |
|---|---|
| `registerToken` | PatientRegistryのトークン列（D〜G）を更新。新規患者は行追加。birthdate は空 |
| `saveVisit` | VisitHistoryに処方内容を保存（同日同患者は上書き） |
| `saveAssessment` | ClinicalAssessmentsに評価を保存（JSON返却） |

**注意: doPost はno-cors / fire-and-forgetのため、`registerToken` と `saveVisit` はレスポンスを使わない。`saveAssessment` のみJSONを返す。**

---

## 5. 患者フォーム入力項目（patient_form.html）

### アンケート項目

**1. 全体症状スコア**（symptomScore: 0〜4）
- 0: なし / 1: 軽度 / 2: 中等度 / 3: 高度 / 4: 最重度

**2. かゆみNRS**（nrsScore: 0〜10）
- 0〜10の数値スライダーまたはボタン

**3. 感染徴候チェック**（infectionSigns: 配列）
- とびひ様 / 黄色痂皮 / 浸出液 / 痛み など

**4. 残薬確認**（medicationRemain: 配列）
- 前回処方薬ごとに4段階:
  - 0: ❌ なし / 1: 🟠 ほとんどない / 2: 🟡 少し残ってる / 3: 💊 たくさん残ってる

**5. POEMスコア**（poemScores: 7項目 × 0〜4点）

| キー | 質問 |
|---|---|
| itch | かゆみ |
| sleep | 睡眠への影響 |
| bleed | 出血 |
| weep | 浸出液 |
| crack | 皮膚のひび割れ |
| flake | 皮膚のむけ |
| dry | 乾燥 |

各項目: 0=症状なし / 1=1〜2日 / 2=3〜4日 / 3=5〜6日 / 4=毎日

**6. 悪化因子**（triggers: 配列 + triggerNote: テキスト）
- 汗・乾燥・花粉・プール・衣類など

**7. 部位別外用状況**（topicalUse: 配列）
- 縦持ち形式で保存（薬剤変更時の破綻を防ぐため）

### フォームに表示される前回情報（getPatientContext/validateFixedAuthNew より）

```json
{
  "valid": true,
  "ageLabel": "6歳1か月",
  "ageGroup": "child10",
  "notes": "メモ",
  "lastVisit": {
    "visitDate": "2026-05-06",
    "nextVisitDate": "2026-05-20",
    "drugsJson": [
      { "name": "モイゼルト軟膏", "partLabel": "顔・首", "freqLabel": "1日1回" }
    ],
    "rxSummaryText": "..."
  }
}
```

### 年齢グループ（ageGroup）

| ageGroup | 対象 |
|---|---|
| infant | 0〜11か月 |
| child1 | 1〜2歳 |
| child3 | 3〜5歳 |
| child10 | 6〜10歳 |
| adult | 11歳以上 |

---

## 6. 処方計算アプリ（atopic_calculator.html）

### 薬剤プリセット（PRESETS）

| 薬剤名 | チューブg | gPerFTU | 混合 |
|---|---|---|---|
| モイゼルト軟膏 | 28 | 0.35 | - |
| コレクチム軟膏 | 10 | 0.5 | - |
| プロトピック軟膏 | 5 | 0.2 | - |
| ロコイド軟膏 | 10 | 0.3 | - |
| リンデロンV軟膏 | 10 | 0.3 | - |
| リンデロンVクリーム | 10 | 0.3 | - |
| アンテベート軟膏 | 10 | 0.3 | - |
| ベタメタゾン軟膏 | 10 | 0.3 | - |
| ベタメタゾンクリーム | 30 | 0.5 | - |
| ロコイド/ヘパリン混合軟膏 | 10 | 0.5 | ✓ |
| ベタメタゾン/ヘパリン混合軟膏 | 10 | 0.5 | ✓ |
| ヒルドイドクリーム | 25 | 0.5 | - |
| ヒルドイドソフト軟膏 | 25 | 0.5 | - |
| ブイタマークリーム | 15 | 0.5 | - |
| その他（手入力） | 10 | 0.5 | custom |

混合軟膏（mixed: true）はFTUではなくg単位で表示。

### FTU値（年齢グループ × 部位）

| 部位 | 乳児 | 1-2歳 | 3-5歳 | 6-10歳 | 成人 |
|---|---|---|---|---|---|
| 顔・首 | 1.0 | 1.5 | 1.5 | 2.0 | 2.5 |
| 腕（片腕） | 1.0 | 1.5 | 2.0 | 2.5 | 4.0 |
| 体幹前面 | 1.0 | 2.0 | 3.0 | 3.5 | 7.0 |
| 体幹後面 | 1.5 | 3.0 | 3.5 | 5.0 | 7.0 |
| 足（片足） | 1.5 | 2.0 | 3.0 | 4.5 | 8.0 |

### 処方量計算式

```
onceTotalG  = Σ(部位のFTU × gPerFTU × 両側係数)
neededG     = onceTotalG × 使用頻度(日換算) × 日数
netG        = neededG - 残量g
prescribedG = チューブ単位で切り上げ(netG)
```

### タブ構成

1. **処方量計算結果** — 計算表（必要量・残量・処方量）
2. **テキスト出力** — カルテ貼り付け用テキスト
3. **患者向け共有** — 印刷・QR用患者向け説明カード
4. **スケジュール** — Ganttチャート + 画像共有（html2canvas）

---

## 7. 医師ダッシュボード（doctor_dashboard.html）

### レポートカードの表示項目

- 患者ID・年齢ラベル・メモ
- スコア時系列グラフ（Chart.js、POEM/NRS/EASI/IGA、2軸）
- 症状スコア（色分けチップ）
- かゆみNRS
- 感染徴候チェック
- POEMスコア（7項目グリッド + 合計点 + 重症度ラベル）
- 悪化因子
- 残薬状況（薬ごと色分け）
- 前回処方内容（レポート送信日より前の VisitHistory から取得）
- EASI/IGA評価入力セクション（リアルタイム計算・保存・既存評価読み込み・EASI済みバッジ）
- 医師コメント入力欄 + 次回受診日
- Claude治療相談プロンプト生成ボタン（全データ自動組み立て・クリップボードコピー）

### POEM重症度判定

| 合計点 | 重症度 |
|---|---|
| 0 | 症状なし |
| 1〜5 | 軽症 |
| 6〜12 | 中等症 |
| 13〜24 | 重症 |
| 25〜28 | 最重症 |

### EASI重症度判定

| easiTotal | easiSeverity |
|---|---|
| 0 | clear |
| 0.1〜6 | mild |
| 6.1〜21 | moderate |
| 21.1〜50 | severe |
| 50.1〜 | very_severe |

### status フロー

```
pending → reviewed（医師コメント保存）
pending → assessed（EASI/IGA評価保存）
reviewed → assessed（EASI/IGA評価保存）
```

---

## 8. セキュリティ設計

### 認証の多層化

| 層 | 個別QRフロー | 固定QRフロー |
|---|---|---|
| 第1層 | 4桁トークン（7日有効、SHA-256ハッシュ） | 当日4桁DailyPIN |
| 第2層 | patientNo との対応チェック | patientNo 存在・isActive チェック |
| 第3層 | isActive フラグ | birthdate 登録（既存患者）または入力（新患） |
| 送信時再検証 | トークン再検証 | PIN再検証 |

### 医師ダッシュボード

- URL に `?secret={CLINIC_SECRET}` を必須
- `CLINIC_SECRET` はGASスクリプトプロパティで管理（コード外）

### 注意事項

- `CLINIC_SECRET` はソースコードに書かない
- `patient_form.html` のパラメータ取得は `<?= patientNo ?>` テンプレート変数方式（URLSearchParamsは使用不可）
- `google.script.run` で返すオブジェクトに Date を含めない（シリアライズエラー対策）
- アンダースコア末尾の関数（例: `saveAssessment_`）は `google.script.run` から直接呼び出せないため、公開ラッパーが必須

---

## 9. 既知の設計上の制約・技術的注意点

1. **clasp push 後は新バージョンのデプロイが必要**  
   `/exec` URLはバージョン指定デプロイを実行するため、`clasp push` だけでは反映されない。  
   GASエディタ → デプロイを管理 → 鉛筆アイコン → 新しいバージョン → デプロイ

2. **Sheets の Date オブジェクトをそのまま返さない**  
   `google.script.run` の戻り値に Date オブジェクトが含まれるとシリアライズエラー。  
   `Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd')` で必ず文字列変換してから返す。

3. **patientNo の先頭0保持**  
   A列はテキスト書式（`setNumberFormat('@')`）を設定してから値を書き込む。  
   新規行追加後に `setNumberFormat` + `setValue` の2ステップが必要。

4. **doPost はno-cors**  
   `registerToken` / `saveVisit` は fire-and-forget。レスポンスは使えない。  
   `saveAssessment` のみ JSON レスポンスを返す（これは `google.script.run` 経由ではなく doPost 経由）。

5. **reception.html は birthdate を扱わない**  
   初診登録時は必ずスプレッドシートへ直接入力するか、固定QRフローで患者が入力する。

---

## 10. 今後の拡張候補

| 優先度 | 内容 | 影響ファイル |
|---|---|---|
| 高 | 部位別外用頻度の入力UI改善（topicalUseJson） | patient_form.html, doctor_dashboard.html |
| 高 | 患者フォームの年齢別分岐（保護者/本人モード） | patient_form.html |
| 中 | POEMスコアの経時グラフ（患者単位） | doctor_dashboard.html |
| 中 | VisitHistoryへの処方履歴の自動同期 | Code.gs |
| 低 | 部位別皮疹マップ（lesionMapJson、将来用） | doctor_dashboard.html, Code.gs |

---

## 11. 開発コマンド

```bash
cd gas
clasp push
# → GASエディタ → デプロイを管理 → 鉛筆アイコン → 新しいバージョン → デプロイ
```

**初回セットアップ（GASエディタから手動実行）:**
```
setupSheets()          # 全シート初期化
setupDailyPinTrigger() # DailyPIN自動生成トリガー設定（毎朝8時JST）
```
