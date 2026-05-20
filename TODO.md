# アンケート強化 TODO

実装順序：① かゆみNRS → ② 感染徴候 → ③ 部位別外用頻度 → ④ 悪化因子

> **共通ルール:** 各フェーズで以下4ファイルをセットで変更する
> 1. `gas/patient_form.html` — 入力UI追加
> 2. `gas/Code.gs` `submitPatientReport` — 新フィールドを受け取り・保存
> 3. `gas/Code.gs` `setupSheets()` — PatientReportsシートの列ヘッダー追加
> 4. `gas/doctor_dashboard.html` — 新項目を表示

---

## ① かゆみNRS（0〜10スライダー）

**難易度:** 低 / **影響範囲:** 1ファイル追加 + GAS小修正

### patient_form.html
- [x] 症状スコアセクションの直後にNRSスライダーを追加
  - `<input type="range" min="0" max="10">` + 数値リアルタイム表示
  - ラベル: 「かゆみの強さ（0=全くない、10=最もひどい）」
  - 変数名: `nrsScore`（初期値: null、未回答を許容）

### gas/Code.gs
- [x] `submitPatientReport` のペイロードに `nrsScore` を受け取る
- [x] PatientReports シートに `nrsScore` 列を追記して保存
- [x] `setupSheets()` のPatientReportsヘッダー配列に `'nrsScore'` を追加

### gas/doctor_dashboard.html
- [x] レポートカードにNRSスコアを表示（数値 + バー or 色分けチップ）

---

## ② 感染徴候チェック

**難易度:** 低〜中 / **影響範囲:** チェックボックス複数 + JSON保存

### patient_form.html
- [x] 感染徴候セクションを追加
  - チェックボックス（複数選択可）:
    - `infection_impetigo` — とびひのような症状（かさぶた・膿）
    - `infection_crust` — 黄色いかさぶた
    - `infection_exudate` — 浸出液（じゅくじゅく）
    - `infection_pain` — 痛み・熱感
  - 「当てはまるものをすべて選んでください（なければスキップ）」
  - 変数名: `infectionSigns`（配列、例: `["impetigo", "crust"]`）

### gas/Code.gs
- [x] `submitPatientReport` に `infectionSignsJson` を追加（JSON.stringify）
- [x] `setupSheets()` に `'infectionSignsJson'` 列を追加

### gas/doctor_dashboard.html
- [x] 感染徴候あり → 赤いアラートバッジで強調表示
- [x] 選択された徴候名を日本語で列挙表示

---

## ③ 部位別外用頻度

**難易度:** 高 / **影響範囲:** シート構造変更・縦持ち設計

> **設計:** 横持ち禁止。薬剤・部位の組み合わせを行ごとに保存する縦持ち形式。

### 縦持ちデータ構造
```javascript
// topicalUseJson の中身（JSON配列）
[
  { drug: "モイゼルト軟膏", part: "顔・首", freq: "毎日" },
  { drug: "モイゼルト軟膏", part: "体幹前面", freq: "2日に1回" },
  { drug: "ロコイド軟膏",   part: "腕",     freq: "週3回" },
]
```

### patient_form.html
- [ ] 前回処方薬 × 部位の組み合わせを自動生成して表示
  - `patientContext.lastDrugs` から薬剤一覧を取得
  - 部位: 顔・首 / 体幹前面 / 体幹後面 / 腕 / 足
  - 各セルに頻度ボタン: 毎日 / 2日に1回 / 週3回 / 週2回 / 塗っていない
- [ ] 「使用していない薬はスキップ」説明文を追加
- [ ] 変数名: `topicalUse`（配列）

### gas/Code.gs
- [ ] `submitPatientReport` に `topicalUseJson` を追加（JSON.stringify）
- [ ] `setupSheets()` に `'topicalUseJson'` 列を追加

### gas/doctor_dashboard.html
- [ ] 薬剤ごと・部位別の使用頻度を表形式で表示

---

## ④ 悪化因子

**難易度:** 低 / **影響範囲:** チェックボックス複数 + JSON保存

### patient_form.html
- [ ] 悪化因子セクションを追加
  - チェックボックス（複数選択可）:
    - `trigger_sweat` — 汗
    - `trigger_dry` — 乾燥・空気の乾き
    - `trigger_pollen` — 花粉・ほこり
    - `trigger_pool` — プール
    - `trigger_clothes` — 衣類・繊維
    - `trigger_food` — 食べ物
    - `trigger_stress` — ストレス・疲れ
    - `trigger_other` — その他（自由記述欄）
  - 「この1週間で症状が悪化したと思う原因は？（なければスキップ）」
  - 変数名: `triggers`（配列）+ `triggerNote`（自由記述）

### gas/Code.gs
- [ ] `submitPatientReport` に `triggersJson`・`triggerNote` を追加
- [ ] `setupSheets()` に `'triggersJson'`・`'triggerNote'` 列を追加

### gas/doctor_dashboard.html
- [ ] 悪化因子を色付きタグで表示
- [ ] 自由記述があれば表示

---

## 共通：年齢別フォーム分岐（③以降に実装）

| ageGroup | 対象 | 対応 |
|---|---|---|
| infant / child1 / child3 | 0〜6歳 | 保護者回答モード（「お子さんの」という表現） |
| child10 | 7〜11歳 | 保護者メイン＋本人のかゆみNRS・睡眠 |
| adult | 12歳以上 | 本人回答モード |

- [ ] `patientContext.ageGroup` を使ってフォームのラベル・質問文を切り替える
- [ ] child10 は NRS を「本人に聞いてください」と保護者に促す

---

## clasp push チェックリスト

各フェーズ完了後:
- [ ] `cd gas && clasp push`
- [ ] GASエディタ → デプロイを管理 → 新バージョン作成
- [ ] `setupSheets()` を手動実行（新列を既存シートに追加する場合は手動追記も検討）
- [ ] E2Eテスト（QR生成 → スキャン → 入力 → 送信 → Sheets確認）
