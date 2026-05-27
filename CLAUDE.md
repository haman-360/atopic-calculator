# Atopic Calculator — システム概要

はまこどもクリニック向けアトピー性皮膚炎軟膏処方支援システム。

---

## 1. プロジェクト全体構成

```
atopic-calculator/
├── atopic_calculator.html   # メイン処方計算アプリ（医師用・GitHub Pages）
├── reception.html           # QRコード発行画面（受付スタッフ用）
└── gas/
    ├── Code.gs              # GASサーバー本体（API・バリデーション）
    ├── patient_form.html    # 患者アンケートフォーム（QRスキャン後）
    ├── doctor_dashboard.html # 医師確認ダッシュボード（iPad用）
    └── shared_styles.html   # 共通CSS
```

**ホスティング:**
- フロントエンド: GitHub Pages (`https://haman-360.github.io/atopic-calculator/`)
- バックエンド: Google Apps Script (GAS)
- DB: Google Sheets（4シート構成）

---

## 2. 患者フロー全体図

```
① 受付 (reception.html)
   受付スタッフが診察券番号と受診日を入力（生年月日の入力欄なし）
   → 4桁トークン生成
   → GAS POST: registerToken（PatientRegistryのD〜G列を更新。新規患者の場合は行を追加するが birthdate は空）
   → QRコード表示

② 患者アンケート (patient_form.html via QRスキャン)
   患者がスマホでQRスキャン
   → URL: {GAS_URL}?page=form&p={患者番号}&t={トークン}
   → GAS: getPatientContext（トークン検証 + 前回処方内容取得）
   → 患者が入力:
       - 全体症状スコア（0〜4）
       - 薬の残量（前回処方薬ごと）
       - POEMスコア（7項目 × 0〜4点）
   → GAS POST: submitPatientReport（PatientReportsに保存）

③ 医師確認 (doctor_dashboard.html)
   医師がダッシュボードにアクセス（secret-protected）
   → 未確認レポート一覧表示
   → 症状スコア・POEM・残薬確認
   → コメント入力 + 次回受診日入力 → 保存

④ 処方計算 (atopic_calculator.html)
   医師が処方計算ツールを使用
   → 薬剤・部位・頻度・期間を入力
   → FTU計算・処方量計算・スケジュール生成
   → 保存: VisitHistoryに記録
```

---

## 3. Google Sheets 構造

### PatientRegistry（患者台帳）
| 列 | 内容 |
|---|---|
| patientNo | 患者番号（テキスト、先頭0保持） |
| birthdate | 生年月日（YYYY-MM-DD）|
| notes | メモ |
| tokenHash | SHA256(salt + token) |
| tokenSalt | ランダムソルト |
| tokenExpiresAt | 有効期限（7日間） |
| isActive | 有効フラグ |

**患者マスタ登録の運用：**
- `patientNo`（A列）と `birthdate`（B列）は**スプレッドシートに直接入力**するのが正しい運用
  - A列はテキスト書式に設定してから入力（先頭0が消えないように）
  - B列は `2020-04-01` 形式（テキスト書式推奨）
- `reception.html` は birthdate を扱わないため、初診登録時は必ずスプレッドシートへ直接入力する
- QR発行（`reception.html`）はトークン列（D〜G）のみ更新する
- birthdate は `getPatientContext` で年齢計算（ageLabel・ageGroup）に使用されるため、空だと患者フォームの年齢表示が機能しない

### VisitHistory（処方履歴）
| 列 | 内容 |
|---|---|
| patientNo | 患者番号 |
| visitDate | 受診日 |
| nextVisitDate | 次回受診予定日 |
| drugsJson | 処方内容JSON（薬名・部位・頻度・g数） |
| rxSummaryText | テキスト要約 |

### PatientReports（患者アンケート回答）
| 列 | 内容 |
|---|---|
| reportId | UUID |
| patientNo | 患者番号 |
| submittedAt | 送信日時 |
| symptomScore | 全体症状スコア（0〜4） |
| symptomNotes | 自由記述 |
| poemJson | POEMスコアJSON（7項目） |
| medicationJson | 残薬情報JSON |
| doctorComment | 医師コメント |
| nextAppointment | 次回受診日（医師入力） |
| commentAt | コメント保存日時 |
| status | 'pending' / 'reviewed' / 'assessed' |

### AuditLog（認証ログ）
| 列 | 内容 |
|---|---|
| timestamp | 日時 |
| patientNo | 患者番号 |
| action | 操作内容 |

### ClinicalAssessments（医師による重症度評価）
| 列 | 内容 |
|---|---|
| assessmentId | UUID |
| patientNo | 患者番号 |
| visitDate | 受診日（YYYY-MM-DD） |
| assessedAt | 評価日時（ISO8601） |
| easiHead | EASI頭頸部スコア |
| easiTrunk | EASI体幹スコア |
| easiUpperLimb | EASI上肢スコア |
| easiLowerLimb | EASI下肢スコア |
| easiTotal | EASI合計（GAS側で自動計算） |
| easiSeverity | 重症度ラベル（clear/mild/moderate/severe/very_severe） |
| iga | IGAスコア（0〜4） |
| lesionMapJson | 部位別皮疹JSON（将来用） |
| notes | 所見メモ |
| easiRawJson | EASI入力元データJSON（{head,trunk,upperLimb,lowerLimb} × {E,I,Ex,L,A}） |

---

## 4. GAS API 一覧（Code.gs）

### doGet — ページ配信・JSONデータ取得
| パラメータ | 説明 |
|---|---|
| `?page=form&p={patientNo}&t={token}` | 患者フォームを表示 |
| `?page=dashboard&secret={CLINIC_SECRET}` | 医師ダッシュボードを表示 |
| `?page=patientContext&p={patientNo}&t={token}` | 患者コンテキストをJSON返却 |
| `?page=getAssessment&id={assessmentId}` | 評価1件をJSON返却 |
| `?page=getAssessmentByVisit&p={patientNo}&d={visitDate}` | 指定受診日の評価一覧をJSON返却 |
| `?page=getAssessmentList&p={patientNo}` | 患者の評価全履歴をJSON返却（降順） |

### doPost — データ操作
| action | 呼び出し元 | 処理 |
|---|---|---|
| `registerToken` | reception.html | トークン生成・PatientRegistryのトークン列（D〜G）を更新。birthdate は送らない（空文字）。新規患者行を作る場合も birthdate 空 |
| `saveVisit` | atopic_calculator.html | 処方内容をVisitHistoryに保存 |
| `getPatientContext` | patient_form.html | トークン検証・前回処方取得 |
| `submitPatientReport` | patient_form.html | アンケート回答をPatientReportsに保存 |
| `getDashboardData` | doctor_dashboard.html | 未確認・確認済みレポート取得 |
| `saveComment` | doctor_dashboard.html | 医師コメント保存・status='reviewed' |
| `saveAssessment` | doctor_dashboard.html | EASI/IGA評価をClinicalAssessmentsに保存・JSONで返却 |

---

## 5. 患者フォーム（patient_form.html）仕様

### 認証フロー
1. GASテンプレート変数 `<?= patientNo ?>` でURLパラメータを注入（URLSearchParamsは使用不可）
2. `google.script.run.getPatientContext(patientNo, token)` で検証
3. 成功 → フォーム表示。失敗 → エラー画面

### 入力項目

**1. 全体症状スコア（symptomScore）**
- 0: なし / 1: 軽度 / 2: 中等度 / 3: 高度 / 4: 最重度
- 任意で自由記述メモ

**2. 残薬確認（medicationRemain）**
- 前回処方薬ごとに4段階ボタン:
  - 0: ❌ なし / 1: 🟠 ほとんどない / 2: 🟡 少し残ってる / 3: 💊 たくさん残ってる

**3. POEMスコア（poemScores）**

| キー | 質問内容 |
|---|---|
| itch | かゆみ |
| sleep | 睡眠への影響 |
| bleed | 出血 |
| weep | 浸出液 |
| crack | 皮膚のひび割れ |
| flake | 皮膚のむけ |
| dry | 乾燥 |

各項目: 0=症状なし / 1=1〜2日 / 2=3〜4日 / 3=5〜6日 / 4=毎日

### 送信データ構造
```javascript
{
  patientNo: "00123",
  token: "1234",
  symptomScore: 2,
  symptomNotes: "かゆみが強い",
  poemScores: { itch: 3, sleep: 2, bleed: 0, weep: 1, crack: 2, flake: 1, dry: 3 },
  medicationRemain: [
    { drugName: "モイゼルト軟膏", remainLevel: 2 },
    { drugName: "ロコイド軟膏", remainLevel: 0 }
  ]
}
```

### フォームに表示される前回情報（getPatientContextより）
```javascript
{
  valid: true,
  birthdate: "2020-04-01",
  ageLabel: "6歳1か月",
  ageGroup: "child10",        // infant / child1 / child3 / child10 / adult
  lastVisitDate: "2026-05-06",
  nextVisitDate: "2026-05-20",
  lastDrugs: "モイゼルト軟膏、ロコイド軟膏",
  lastRxSummary: "モイゼルト軟膏を顔・首に5/6〜5/20 1日1回..."
}
```

---

## 6. 処方計算アプリ（atopic_calculator.html）概要

### 薬剤データ（PRESETS）
```javascript
[
  { name: "モイゼルト軟膏",              tubeg: 28, gPerFTU: 0.35, mixed: false },
  { name: "コレクチム軟膏",              tubeg: 10, gPerFTU: 0.5,  mixed: false },
  { name: "プロトピック軟膏",            tubeg: 5,  gPerFTU: 0.2,  mixed: false },
  { name: "ロコイド軟膏",                tubeg: 10, gPerFTU: 0.3,  mixed: false },
  { name: "リンデロンV軟膏",             tubeg: 10, gPerFTU: 0.3,  mixed: false },
  { name: "リンデロンVクリーム",         tubeg: 10, gPerFTU: 0.3,  mixed: false },
  { name: "アンテベート軟膏",            tubeg: 10, gPerFTU: 0.3,  mixed: false },
  { name: "ベタメタゾン軟膏",            tubeg: 10, gPerFTU: 0.3,  mixed: false },
  { name: "ベタメタゾンクリーム",        tubeg: 30, gPerFTU: 0.5,  mixed: false },
  { name: "ロコイド/ヘパリン混合軟膏",   tubeg: 10, gPerFTU: 0.5,  mixed: true  },
  { name: "ベタメタゾン/ヘパリン混合軟膏", tubeg: 10, gPerFTU: 0.5, mixed: true },
  { name: "ヒルドイドクリーム",          tubeg: 25, gPerFTU: 0.5,  mixed: false },
  { name: "ヒルドイドソフト軟膏",        tubeg: 25, gPerFTU: 0.5,  mixed: false },
  { name: "ブイタマークリーム",          tubeg: 15, gPerFTU: 0.5,  mixed: false },
  { name: "その他（手入力）",             tubeg: 10, gPerFTU: 0.5,  custom: true },
]
```

### FTU値（年齢グループ別 × 部位別）
| 部位 | 乳児 | 1-2歳 | 3-5歳 | 6-10歳 | 成人 |
|---|---|---|---|---|---|
| 顔・首 | 1.0 | 1.5 | 1.5 | 2.0 | 2.5 |
| 腕（片腕） | 1.0 | 1.5 | 2.0 | 2.5 | 4.0 |
| 体幹前面 | 1.0 | 2.0 | 3.0 | 3.5 | 7.0 |
| 体幹後面 | 1.5 | 3.0 | 3.5 | 5.0 | 7.0 |
| 足（片足） | 1.5 | 2.0 | 3.0 | 4.5 | 8.0 |

### 処方量計算式
```
onceTotalG = Σ(部位ごとのFTU × gPerFTU × 両側係数)
neededG    = onceTotalG × 使用頻度(日換算) × 日数
netG       = neededG - 残量g
prescribedG = チューブ単位に切り上げ(netG)
```

### タブ構成
1. **処方量計算結果** — 計算表（必要量・残量・処方量）
2. **テキスト出力** — カルテ貼り付け用テキスト
3. **患者向け共有** — 印刷・QR用患者向け説明カード
4. **スケジュール** — Ganttチャート + 画像共有（html2canvas）

---

## 7. 医師ダッシュボード（doctor_dashboard.html）

### 表示項目（レポートカードごと）
- 患者ID・年齢ラベル
- 症状スコア（色分けチップ）
- POEMスコア（7項目グリッド + 合計点 + 重症度ラベル）
- 残薬状況（薬ごと色分け）
- 前回処方内容（VisitHistoryから）
- 医師コメント入力欄 + 次回受診日

### POEM重症度判定
| 合計点 | 重症度 |
|---|---|
| 0 | 症状なし |
| 1〜5 | 軽症 |
| 6〜12 | 中等症 |
| 13〜24 | 重症 |
| 25〜28 | 最重症 |

---

## 8. デプロイ情報

- **GASデプロイID:** `AKfycbyYlP8b_E-X4tDYZQm6uDn3cbsaAcAezMjsJw4coN_nW-QCTbLqMtz0tkNShej1gLApYw`
- **ベースURL:** `https://script.google.com/macros/s/AKfycbyYlP8b_E-X4tDYZQm6uDn3cbsaAcAezMjsJw4coN_nW-QCTbLqMtz0tkNShej1gLApYw/exec`
- 患者フォーム: `...exec?page=form&p={患者番号}&t={トークン}`
- 医師ダッシュボード: `...exec?page=dashboard&secret=（スクリプトプロパティ参照）`

## スクリプトプロパティ（GASエディタで設定）
| プロパティ名 | 内容 |
|---|---|
| `SHEET_ID` | Google SheetsのスプレッドシートID |
| `CLINIC_SECRET` | 医師ダッシュボードアクセス用パスワード |

## ローカル開発
```bash
cd gas
clasp push
# GASエディタ → デプロイを管理 → 鉛筆アイコン → 新しいバージョン → デプロイ
```

---

## 9. 注意事項

- `CLINIC_SECRET` はソースコードに書かず、スクリプトプロパティで管理
- `patient_form.html` のパラメータ取得は `<?= patientNo ?>` テンプレート変数方式（URLSearchParamsは使えない）
- `Code.gs`（英語ファイル名）のみ使用。`コード.gs`（日本語）はGASエディタ上で削除済み
- 混合軟膏（mixed: true）はFTUではなくg単位で表示（チューブではなく容器のため）
- アンケート拡張時は `submitPatientReport` のペイロード + PatientReportsシート列 + `setupSheets()` を同時に更新する

---

## 10. アンケート強化計画（2026-05 設計）

### 追加する項目（優先順）
1. **かゆみNRS**（0〜10）← 最優先・1ファイル変更のみ
2. **感染徴候チェック**（とびひ様・黄色痂皮・浸出液・痛み）
3. **部位別外用頻度**（部位 × 薬剤 × 頻度）← シート構造変更あり
4. **悪化因子**（汗・乾燥・花粉・プール・衣類など）
5. **年齢別フォーム分岐**（ageGroupはすでにgetPatientContextが返している）

### 設計方針
- 部位別外用頻度は**縦持ち**で保存（横持ち禁止・薬剤変更時に破綻するため）
- PatientReportsに `topicalUseJson` 列を追加する
- 患者フォームはスマホ完結・シンプルさ優先
- トークン認証の仕組みは変更しない

### 年齢別フォーム分岐方針
| ageGroup | 対象年齢 | 回答モード |
|---|---|---|
| infant / child1 / child3 | 0〜6歳 | 保護者回答モード |
| child10 | 7〜11歳 | 保護者メイン＋本人のかゆみ・睡眠 |
| adult | 12歳以上 | 本人回答モード |

### 拡張時の必須手順（セットで行う）
1. `gas/patient_form.html` — 入力UIを追加
2. `gas/Code.gs` の `submitPatientReport` — ペイロードの新フィールドを受け取り・保存
3. `gas/Code.gs` の `setupSheets()` — PatientReportsシートの列ヘッダーを追加
4. `gas/doctor_dashboard.html` — 新項目を表示（必要に応じて）

---

## 11. TODO

- [ ] 患者フォームE2Eテスト（QR生成→スキャン→認証→送信→Sheets反映確認）
- [ ] 医師ダッシュボードの動作確認
- [ ] POEMスコアの推移グラフ・経過観察機能
- [ ] VisitHistoryへの処方履歴の自動同期

---

## 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-05-20 | かゆみNRS実装・動作確認済み |
| 2026-05-20 | 感染徴候チェック実装・動作確認済み |
| 2026-05-21 | 悪化因子実装・動作確認済み |
| 2026-05-21 | 患者連携・年齢自動設定実装 |
| 2026-05-21 | QR認証フロー動作確認済み |
| 2026-05-22 | ClinicalAssessmentsシート追加・EASI/IGA評価API実装（saveAssessment/getAssessment/getAssessmentByVisit/getAssessmentList） |
| 2026-05-22 | ダッシュボードにEASI/IGA入力セクション追加（リアルタイム計算・保存・既存評価読み込み・EASI済みバッジ） |
| 2026-05-22 | ダッシュボードにClaude治療相談プロンプト生成機能追加（全データ自動組み立て・クリップボードコピー） |
| 2026-05-22 | ダッシュボードにスコア時系列グラフ追加（Chart.js、POEM/NRS/EASI/IGA、2軸、患者カード上部） |
| 2026-05-22 | reception.html の入力欄を「診察券番号 + 受診日」のみに整理（生年月日入力欄を削除済み）。患者マスタ（birthdate）はスプレッドシート直接入力で管理 |

---

## 12. コミットルール

- コミット前に必ずメッセージ案を提示し、承認を得てからコミットすること
- **conventional commits形式** で日本語で書くこと

### プレフィックス一覧
| プレフィックス | 用途 |
|---|---|
| `feat` | 新機能の追加 |
| `fix` | バグ修正 |
| `chore` | ビルド・設定・依存関係など |
| `refactor` | 機能変更を伴わないコード整理 |
| `docs` | ドキュメントのみの変更 |

### フォーマット
```
<プレフィックス>: <概要（日本語）>

- 変更点1
- 変更点2
```

### 例
```
feat: 疾患固定QRルートと初診患者フローを追加

- DailyPINシートで日次PINを自動生成する仕組みを実装
- validateFixedAuthNew / registerBirthdateAndGetContext を追加
- 初診患者は生年月日入力後にPatientRegistryへ自動登録
```

---

## 13. トラブルシューティング実績

### GASのURLパラメータが届かない
- **原因：** `clasp push` 後に新バージョンのデプロイを作成していなかった。`/exec` URL はバージョン指定されたデプロイを実行するため、push だけでは反映されない
- **対策：** `clasp push` 後は必ず GASエディタ → デプロイを管理 → 鉛筆アイコン → 「新しいバージョン」でデプロイ

### google.script.run でシリアライズエラー（`Uncaught jtUnderstand this error`）
- **原因：** `getValues()` が返す Sheets の日付セルが Date オブジェクトのまま `google.script.run` の戻り値に含まれ、クライアント側のシリアライズに失敗した
- **対策：** `google.script.run` で返すオブジェクトに Date を含めない。`Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd')` で必ず文字列変換してから返す
