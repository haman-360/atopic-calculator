// ===== 設定 =====
// GASエディタの「プロジェクトの設定 → スクリプト プロパティ」で以下を設定してください:
//   プロパティ名: SHEET_ID       値: Google SheetsのスプレッドシートID
//   プロパティ名: CLINIC_SECRET  値: 医師ダッシュボード用の任意のパスワード文字列
const PROPS = PropertiesService.getScriptProperties();
const SHEET_ID = PROPS.getProperty('SHEET_ID');
const CLINIC_SECRET = PROPS.getProperty('CLINIC_SECRET');

// ===== ルーティング =====
function doGet(e) {
  const page = (e && e.parameter && e.parameter.page) || 'form';

  if (page === 'form') {
    const tmpl = HtmlService.createTemplateFromFile('patient_form');
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

// atopy_v9.html からの POST（トークン登録, no-cors）
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action === 'registerToken') {
      registerToken_(data.patientNo, data.token, data.salt, data.expires);
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
function registerToken_(patientNo, plainToken, salt, expiresAt) {
  const sheet = getSheet_('PatientRegistry');
  const data = sheet.getDataRange().getValues();

  // patientNo が一致する行を探す
  let rowIdx = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(patientNo)) { rowIdx = i + 1; break; }
  }

  const hash = hashToken_(salt, plainToken);

  if (rowIdx < 0) {
    // 新規行として追加（患者名などは空欄のまま。後で手入力か同期で補完）
    sheet.appendRow([patientNo, '', '', '', hash, salt, expiresAt, true]);
  } else {
    // 既存行を更新（E=tokenHash, F=salt, G=expires, H=isActive）
    sheet.getRange(rowIdx, 5, 1, 4).setValues([[hash, salt, expiresAt, true]]);
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
    if (!row[7]) { // isActive=FALSE
      auditLog_(auditSheet, patientNo, 'token_inactive');
      return { valid: false, reason: 'inactive' };
    }
    const expiresAt = new Date(row[6]);
    if (new Date() > expiresAt) {
      auditLog_(auditSheet, patientNo, 'token_expired');
      return { valid: false, reason: 'expired' };
    }
    const hash = hashToken_(String(row[5]), plainToken);
    if (hash !== String(row[4])) {
      auditLog_(auditSheet, patientNo, 'token_invalid');
      return { valid: false, reason: 'invalid' };
    }
    auditLog_(auditSheet, patientNo, 'token_valid');
    return {
      valid: true,
      patientName: row[1] || '',
      ageGroup: row[2] || '',
      notes: row[3] || ''
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
    patientName: validation.patientName,
    ageGroup: validation.ageGroup,
    notes: validation.notes,
    lastVisit: lastVisit
  };
}

// ===== 患者フォーム送信 =====
function submitPatientReport(reportData) {
  // トークン再検証
  const validation = validateToken_(reportData.patientNo, reportData.token);
  if (!validation.valid) return { ok: false, reason: validation.reason };

  const sheet = getSheet_('PatientReports');
  const reportId = Utilities.getUuid();
  sheet.appendRow([
    reportId,
    reportData.patientNo,
    new Date().toISOString(),
    reportData.symptomScore,
    reportData.symptomNotes || '',
    JSON.stringify(reportData.poemScores || {}),
    JSON.stringify(reportData.medicationRemain || []),
    '', // doctorComment (空)
    '', // nextAppointment (空)
    '', // commentAt (空)
    'pending'
  ]);
  return { ok: true, reportId: reportId };
}

// ===== 医師ダッシュボード: データ取得 =====
function getDashboardData() {
  const prSheet = getSheet_('PatientReports');
  const prData = prSheet.getDataRange().getValues();
  const vhSheet = getSheet_('VisitHistory');
  const vhData = vhSheet.getDataRange().getValues();
  const regSheet = getSheet_('PatientRegistry');
  const regData = regSheet.getDataRange().getValues();

  // PatientRegistry をマップ化
  const patientMap = {};
  for (let i = 1; i < regData.length; i++) {
    patientMap[String(regData[i][0])] = { name: regData[i][1], notes: regData[i][3] };
  }

  // VisitHistory を最新処方マップ化
  const lastRxMap = {};
  for (let i = 1; i < vhData.length; i++) {
    const pno = String(vhData[i][0]);
    if (!lastRxMap[pno] || vhData[i][1] > lastRxMap[pno].visitDate) {
      lastRxMap[pno] = {
        visitDate: vhData[i][1],
        nextVisitDate: vhData[i][2],
        drugsJson: vhData[i][3] ? JSON.parse(vhData[i][3]) : [],
        rxSummaryText: vhData[i][4] || ''
      };
    }
  }

  // PatientReports を組み立て（pending を優先、新しい順）
  const pending = [], reviewed = [];
  for (let i = 1; i < prData.length; i++) {
    const row = prData[i];
    const pno = String(row[1]);
    const entry = {
      reportId: row[0],
      patientNo: pno,
      patientName: (patientMap[pno] || {}).name || pno,
      patientNotes: (patientMap[pno] || {}).notes || '',
      submittedAt: row[2],
      symptomScore: row[3],
      symptomNotes: row[4],
      poemScores: row[5] ? JSON.parse(row[5]) : {},
      medicationRemain: row[6] ? JSON.parse(row[6]) : [],
      doctorComment: row[7] || '',
      nextAppointment: row[8] || '',
      commentAt: row[9] || '',
      status: row[10] || 'pending',
      lastRx: lastRxMap[pno] || null,
      rowIndex: i + 1 // 1-indexed for Sheets
    };
    if (entry.status === 'pending') pending.push(entry);
    else reviewed.push(entry);
  }

  // 新しい順
  pending.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  reviewed.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));

  return { pending, reviewed };
}

// ===== 医師コメント保存 =====
function saveComment(reportId, comment, nextAppointment) {
  const sheet = getSheet_('PatientReports');
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === reportId) {
      const row = i + 1;
      sheet.getRange(row, 8).setValue(comment);           // H: doctorComment
      sheet.getRange(row, 9).setValue(nextAppointment);   // I: nextAppointment
      sheet.getRange(row, 10).setValue(new Date().toISOString()); // J: commentAt
      sheet.getRange(row, 11).setValue('reviewed');       // K: status
      return { ok: true };
    }
  }
  return { ok: false, reason: 'not_found' };
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

function auditLog_(sheet, patientNo, action) {
  sheet.appendRow([new Date().toISOString(), patientNo, action]);
}

// ===== スプレッドシート初期設定（初回のみ手動実行） =====
// Apps Script エディタから一度だけ実行してください
function setupSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  const sheets = {
    'PatientRegistry': ['patientNo', 'patientName', 'defaultAgeGroup', 'notes', 'tokenHash', 'tokenSalt', 'tokenExpiresAt', 'isActive'],
    'VisitHistory':    ['patientNo', 'visitDate', 'nextVisitDate', 'drugsJson', 'rxSummaryText'],
    'PatientReports':  ['reportId', 'patientNo', 'submittedAt', 'symptomScore', 'symptomNotes', 'poemJson', 'medicationJson', 'doctorComment', 'nextAppointment', 'commentAt', 'status'],
    'AuditLog':        ['timestamp', 'patientNo', 'action']
  };

  for (const [name, headers] of Object.entries(sheets)) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e8f5e9');
    }
  }

  Logger.log('シート初期設定が完了しました');
}
