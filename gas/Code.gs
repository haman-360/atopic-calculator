// ===== 設定 =====
// GASエディタの「プロジェクトの設定 → スクリプト プロパティ」で以下を設定してください:
//   プロパティ名: SHEET_ID       値: Google SheetsのスプレッドシートID
//   プロパティ名: CLINIC_SECRET  値: 医師ダッシュボード用の任意のパスワード文字列
const PROPS = PropertiesService.getScriptProperties();
const SHEET_ID = PROPS.getProperty('SHEET_ID');
const CLINIC_SECRET = PROPS.getProperty('CLINIC_SECRET');

// ===== PatientRegistry 列定義（0始まり） =====
// [0] patientNo  [1] birthdate  [2] notes
// [3] tokenHash  [4] tokenSalt  [5] tokenExpiresAt  [6] isActive

// ===== ルーティング =====
function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || 'form';

  if (page === 'form') {
    const tmpl = HtmlService.createTemplateFromFile('patient_form');
    tmpl.patientNo = (e && e.parameter && e.parameter.p) || '';
    tmpl.token     = (e && e.parameter && e.parameter.t) || '';
    return tmpl.evaluate()
      .setTitle('症状報告フォーム — はまこどもクリニック')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
  }

  if (page === 'dashboard') {
    if (!e || !e.parameter || e.parameter.secret !== CLINIC_SECRET) {
      return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:40px;">アクセスが拒否されました</p>');
    }
    return HtmlService.createTemplateFromFile('doctor_dashboard')
      .evaluate()
      .setTitle('カルテダッシュボード — はまこどもクリニック')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
  }

  return HtmlService.createHtmlOutput('<p style="font-family:sans-serif;padding:40px;">ページが見つかりません</p>');
}

// ===== POST ルーティング（no-cors / fire-and-forget） =====
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'registerToken') {
      registerToken_(data.patientNo, data.token, data.salt, data.expires, data.birthdate || '');
    } else if (data.action === 'saveVisit') {
      saveVisit_(data.patientNo, data.visitDate, data.nextVisitDate, data.drugsJson, data.rxSummaryText);
    }
  } catch (err) {
    // fire-and-forget なのでエラーは握り潰す
  }
  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

// ===== HtmlService include ヘルパー =====
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ===== トークン登録 =====
function registerToken_(patientNo, plainToken, salt, expiresAt, birthdate) {
  const sheet = getSheet_('PatientRegistry');
  const data = sheet.getDataRange().getValues();

  let rowIdx = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(patientNo)) { rowIdx = i + 1; break; }
  }

  const hash = hashToken_(salt, plainToken);

  if (rowIdx < 0) {
    // 新規行: patientNo, birthdate, notes(空), tokenHash, tokenSalt, tokenExpiresAt, isActive
    // A列をテキスト書式に設定してから値を書き込む（先頭0を保持するため）
    sheet.appendRow([String(patientNo), birthdate, '', hash, salt, expiresAt, true]);
    const newRow = sheet.getLastRow();
    sheet.getRange(newRow, 1).setNumberFormat('@');
    sheet.getRange(newRow, 1).setValue(String(patientNo));
  } else {
    // birthdateが渡されていれば更新
    if (birthdate) sheet.getRange(rowIdx, 2).setValue(birthdate);
    // D〜G列: tokenHash, tokenSalt, tokenExpiresAt, isActive
    sheet.getRange(rowIdx, 4, 1, 4).setValues([[hash, salt, expiresAt, true]]);
  }
}

// ===== トークン検証 =====
function validateToken_(patientNo, plainToken) {
  const sheet = getSheet_('PatientRegistry');
  const data = sheet.getDataRange().getValues();
  const auditSheet = getSheet_('AuditLog');

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[0]) !== String(patientNo)) continue;
    if (!row[6]) { // isActive（G列）
      auditLog_(auditSheet, patientNo, 'token_inactive');
      return { valid: false, reason: 'inactive' };
    }
    const expiresAt = new Date(row[5]); // tokenExpiresAt（F列）
    if (new Date() > expiresAt) {
      auditLog_(auditSheet, patientNo, 'token_expired');
      return { valid: false, reason: 'expired' };
    }
    const hash = hashToken_(String(row[4]), plainToken); // tokenSalt（E列）
    if (hash !== String(row[3])) { // tokenHash（D列）
      auditLog_(auditSheet, patientNo, 'token_invalid');
      return { valid: false, reason: 'invalid' };
    }
    auditLog_(auditSheet, patientNo, 'token_valid');
    return {
      valid: true,
      birthdate: row[1] || '', // birthdate（B列）
      notes: row[2] || ''      // notes（C列）
    };
  }
  auditLog_(auditSheet, patientNo, 'token_invalid');
  return { valid: false, reason: 'invalid' };
}

// ===== 患者コンテキスト取得（患者フォームから呼ばれる） =====
function getPatientContext(patientNo, token) {
  const validation = validateToken_(patientNo, token);
  if (!validation.valid) return validation;

  // VisitHistory から最新処方を取得
  const vhSheet = getSheet_('VisitHistory');
  const vhData = vhSheet.getDataRange().getValues();
  let lastVisit = null;
  for (let i = 1; i < vhData.length; i++) {
    const row = vhData[i];
    if (String(row[0]) !== String(patientNo)) continue;
    if (!lastVisit || row[1] > lastVisit.visitDate) {
      lastVisit = {
        visitDate: row[1],
        nextVisitDate: row[2],
        drugsJson: row[3] ? JSON.parse(row[3]) : [],
        rxSummaryText: row[4] || ''
      };
    }
  }

  return {
    valid: true,
    ageLabel: calcAgeLabel_(validation.birthdate),
    ageGroup: calcAgeGroup_(validation.birthdate),
    notes: validation.notes,
    lastVisit: lastVisit
  };
}

// ===== 患者フォーム送信 =====
function submitPatientReport(reportData) {
  const validation = validateToken_(reportData.patientNo, reportData.token);
  if (!validation.valid) return { ok: false, reason: validation.reason };

  const sheet = getSheet_('PatientReports');
  const reportId = Utilities.getUuid();
  sheet.appendRow([
    reportId,                                                     // [0] A reportId
    String(reportData.patientNo),                                 // [1] B patientNo
    new Date().toISOString(),                                     // [2] C submittedAt
    reportData.symptomScore,                                      // [3] D symptomScore
    reportData.nrsScore !== undefined ? reportData.nrsScore : '', // [4] E nrsScore
    JSON.stringify(reportData.infectionSigns || []),              // [5] F infectionSignsJson
    reportData.symptomNotes || '',                                // [6] G symptomNotes
    JSON.stringify(reportData.poemScores || {}),                  // [7] H poemJson
    JSON.stringify(reportData.medicationRemain || []),            // [8] I medicationJson
    '', // [9]  J doctorComment
    '', // [10] K nextAppointment
    '', // [11] L commentAt
    'pending' // [12] M status
  ]);
  // B列（patientNo）をテキスト書式に設定（先頭0を保持するため）
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, 2).setNumberFormat('@');
  sheet.getRange(newRow, 2).setValue(String(reportData.patientNo));
  return { ok: true, reportId: reportId };
}

// ===== 処方履歴保存 =====
function saveVisit_(patientNo, visitDate, nextVisitDate, drugsJson, rxSummaryText) {
  const sheet = getSheet_('VisitHistory');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(patientNo) && String(data[i][1]) === String(visitDate)) {
      sheet.getRange(i + 1, 3, 1, 3).setValues([[nextVisitDate, JSON.stringify(drugsJson), rxSummaryText]]);
      return;
    }
  }
  sheet.appendRow([String(patientNo), visitDate, nextVisitDate, JSON.stringify(drugsJson), rxSummaryText]);
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, 1).setNumberFormat('@');
  sheet.getRange(newRow, 1).setValue(String(patientNo));
}

// ===== 医師ダッシュボード: データ取得 =====
function getDashboardData() {
  const prSheet = getSheet_('PatientReports');
  const prData = prSheet.getDataRange().getValues();
  const vhSheet = getSheet_('VisitHistory');
  const vhData = vhSheet.getDataRange().getValues();
  const regSheet = getSheet_('PatientRegistry');
  const regData = regSheet.getDataRange().getValues();

  // PatientRegistry をマップ化（birthdate, notes）
  const patientMap = {};
  for (let i = 1; i < regData.length; i++) {
    const pno = String(regData[i][0]);
    patientMap[pno] = {
      birthdate: regData[i][1] || '',
      notes: regData[i][2] || ''
    };
  }

  // VisitHistory を最新処方マップ化
  const lastRxMap = {};
  for (let i = 1; i < vhData.length; i++) {
    try {
      const pno = String(vhData[i][0]);
      if (!lastRxMap[pno] || vhData[i][1] > lastRxMap[pno].visitDate) {
        let drugsJson = [];
        try { drugsJson = vhData[i][3] ? JSON.parse(vhData[i][3]) : []; } catch(e) {}
        lastRxMap[pno] = {
          visitDate: dateToStr_(vhData[i][1]),
          nextVisitDate: dateToStr_(vhData[i][2]),
          drugsJson: drugsJson,
          rxSummaryText: vhData[i][4] || ''
        };
      }
    } catch(e) {}
  }

  const pending = [], reviewed = [];
  for (let i = 1; i < prData.length; i++) {
    try {
      const row = prData[i];
      const pno = String(row[1]).trim();
      const reg = patientMap[pno] || patientMap[pno.replace(/^0+/, '')] || {};
      let infectionSigns = [], poemScores = {}, medicationRemain = [];
      try { infectionSigns = row[5] ? JSON.parse(row[5]) : []; } catch(e) {} // F infectionSignsJson
      try { poemScores    = row[7] ? JSON.parse(row[7]) : {}; } catch(e) {}  // H poemJson
      try { medicationRemain = row[8] ? JSON.parse(row[8]) : []; } catch(e) {} // I medicationJson
      const entry = {
        reportId: row[0],
        patientNo: pno,
        ageLabel: calcAgeLabel_(reg.birthdate),
        patientNotes: reg.notes || '',
        submittedAt: row[2] ? new Date(row[2]).toISOString() : '',
        symptomScore: row[3],                                    // D
        nrsScore: row[4] !== '' ? row[4] : null,                 // E
        infectionSigns: infectionSigns,                          // F
        symptomNotes: row[6],                                    // G
        poemScores: poemScores,                                  // H
        medicationRemain: medicationRemain,                      // I
        doctorComment: row[9] || '',                             // J
        nextAppointment: dateToStr_(row[10]),                    // K
        commentAt: row[11] ? new Date(row[11]).toISOString() : '', // L
        status: row[12] || 'pending',                            // M
        lastRx: lastRxMap[pno] || null,
        rowIndex: i + 1
      };
      if (entry.status === 'pending') pending.push(entry);
      else reviewed.push(entry);
    } catch(e) {}
  }

  pending.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  reviewed.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

  return { pending, reviewed };
}

// ===== 医師コメント保存 =====
function saveComment(reportId, comment, nextAppointment) {
  const sheet = getSheet_('PatientReports');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(reportId).trim()) {
      const row = i + 1;
      sheet.getRange(row, 10).setValue(comment);
      sheet.getRange(row, 11).setValue(nextAppointment);
      sheet.getRange(row, 12).setValue(new Date().toISOString());
      sheet.getRange(row, 13).setValue('reviewed');
      return { ok: true };
    }
  }
  // デバッグ用：何件あるか・最初のIDを返す
  return { ok: false, reason: 'not_found', count: data.length - 1, firstId: String(data[1] ? data[1][0] : '') };
}

// ===== 年齢計算ユーティリティ =====
function calcAgeLabel_(birthdate) {
  if (!birthdate) return '';
  const birth = new Date(birthdate);
  if (isNaN(birth.getTime())) return '';
  const now = new Date();
  let years = now.getFullYear() - birth.getFullYear();
  let months = now.getMonth() - birth.getMonth();
  if (months < 0) { years--; months += 12; }
  if (years < 1) return months + 'か月';
  if (years < 3) return years + '歳' + (months > 0 ? months + 'か月' : '');
  return years + '歳';
}

function calcAgeGroup_(birthdate) {
  if (!birthdate) return 'child3';
  const birth = new Date(birthdate);
  if (isNaN(birth.getTime())) return 'child3';
  const now = new Date();
  const months = (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
  if (months < 12)  return 'infant';
  if (months < 36)  return 'child1';
  if (months < 72)  return 'child3';
  if (months < 132) return 'child10';
  return 'adult';
}

// ===== ユーティリティ =====
function getSheet_(name) {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
}

function hashToken_(salt, token) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt + token,
    Utilities.Charset.UTF_8
  );
  return bytes.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

function dateToStr_(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  return String(v).substring(0, 10);
}

function auditLog_(sheet, patientNo, action) {
  sheet.appendRow([new Date().toISOString(), String(patientNo), action]);
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, 2).setNumberFormat('@');
  sheet.getRange(newRow, 2).setValue(String(patientNo));
}

// ===== デバッグ用（GASエディタから実行して実行ログを確認） =====
function debugDashboard() {
  try {
    const prSheet = getSheet_('PatientReports');
    const prData = prSheet.getDataRange().getValues();
    Logger.log('PatientReports 行数: ' + prData.length);
    for (let i = 0; i < prData.length; i++) {
      Logger.log('行' + i + ': ' + JSON.stringify(prData[i].map(v => String(v).substring(0, 30))));
    }

    const result = getDashboardData();
    Logger.log('pending件数: ' + result.pending.length);
    Logger.log('reviewed件数: ' + result.reviewed.length);
    if (result.pending.length > 0) Logger.log('pending[0]: ' + JSON.stringify(result.pending[0]));
  } catch(e) {
    Logger.log('エラー: ' + e.message + '\n' + e.stack);
  }
}

// ===== スプレッドシート初期設定（初回のみ手動実行） =====
function setupSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  const sheets = {
    'PatientRegistry': ['patientNo', 'birthdate', 'notes', 'tokenHash', 'tokenSalt', 'tokenExpiresAt', 'isActive'],
    'VisitHistory':    ['patientNo', 'visitDate', 'nextVisitDate', 'drugsJson', 'rxSummaryText'],
    'PatientReports':  ['reportId', 'patientNo', 'submittedAt', 'symptomScore', 'nrsScore', 'infectionSignsJson', 'symptomNotes', 'poemJson', 'medicationJson', 'doctorComment', 'nextAppointment', 'commentAt', 'status'],
    'AuditLog':        ['timestamp', 'patientNo', 'action']
  };

  for (const [name, headers] of Object.entries(sheets)) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e8f5e9');
    }
    // patientNo列をテキスト書式に設定（先頭0を保持するため）
    // PatientRegistry・VisitHistory: A列, PatientReports・AuditLog: B列
    if (['PatientRegistry', 'VisitHistory'].includes(name)) {
      sheet.getRange('A:A').setNumberFormat('@');
    } else if (['PatientReports', 'AuditLog'].includes(name)) {
      sheet.getRange('B:B').setNumberFormat('@');
    }
  }

  Logger.log('シート初期設定が完了しました');
}

// ===== PatientRegistry スキーマ移行（旧8列→新7列） =====
// GASエディタから一度だけ実行してください（既存データがある場合のみ）
function migratePatientRegistry() {
  const sheet = getSheet_('PatientRegistry');
  const data = sheet.getDataRange().getValues();
  if (data.length === 0) return;

  // ヘッダー行を新しい列名に書き換え
  const newHeaders = ['patientNo', 'birthdate', 'notes', 'tokenHash', 'tokenSalt', 'tokenExpiresAt', 'isActive'];
  sheet.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);

  // 旧8列の場合: B=patientName, C=defaultAgeGroup, D=notes → B=birthdate(空), C=notes, D=tokenHash...
  // 列Bをbirthdate（空）に、列CをnotesにするためC列（defaultAgeGroup）を削除
  if (data[0].length >= 8) {
    sheet.deleteColumn(3); // defaultAgeGroup列(C)を削除 → D以降が1列ずつ前にシフト
    // B列（旧patientName）をbirthdate（空）に上書き
    const rows = sheet.getLastRow();
    if (rows > 1) {
      sheet.getRange(2, 2, rows - 1, 1).clearContent(); // B列（名前）を空欄に
    }
    Logger.log('移行完了: ' + (rows - 1) + '件の患者レコードを処理しました');
  } else {
    Logger.log('既に新スキーマです');
  }
}
