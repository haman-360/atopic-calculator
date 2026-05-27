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

  // 疾患固定QRルート: ?mode=fixed&form=xxx
  if (e && e.parameter && e.parameter.mode === 'fixed') {
    const formType = (e.parameter.form) || 'atopic_dermatitis';
    const tmpl = HtmlService.createTemplateFromFile('patient_form');
    tmpl.patientNo = '';
    tmpl.token     = '';
    tmpl.fixedMode = true;
    tmpl.formType  = formType;
    return tmpl.evaluate()
      .setTitle('症状報告フォーム — はまこどもクリニック')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
  }

  if (page === 'form') {
    const patientNo = (e && e.parameter && e.parameter.p) || '';
    const token     = (e && e.parameter && e.parameter.t) || '';
    const tmpl = HtmlService.createTemplateFromFile('patient_form');
    tmpl.patientNo = patientNo;
    tmpl.token     = token;
    tmpl.fixedMode = false;
    tmpl.formType  = '';
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

  if (page === 'patientContext') {
    const p = (e && e.parameter && e.parameter.p) || '';
    const t = (e && e.parameter && e.parameter.t) || '';
    const result = getPatientContext(p, t);
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(MimeType.JSON);
  }

  if (page === 'getAssessment') {
    const id = (e && e.parameter && e.parameter.id) || '';
    const result = getAssessment_(id);
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(MimeType.JSON);
  }

  if (page === 'getAssessmentByVisit') {
    const p = (e && e.parameter && e.parameter.p) || '';
    const d = (e && e.parameter && e.parameter.d) || '';
    const result = getAssessmentByVisit_(p, d);
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(MimeType.JSON);
  }

  if (page === 'getAssessmentList') {
    const p = (e && e.parameter && e.parameter.p) || '';
    const result = getAssessmentList_(p);
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(MimeType.JSON);
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
    } else if (data.action === 'saveAssessment') {
      const result = saveAssessment_(data);
      return ContentService.createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, reason: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
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
  Logger.log('[validateToken_] 開始 patientNo=' + patientNo + ' tokenLen=' + (plainToken ? plainToken.length : 0));
  const sheet = getSheet_('PatientRegistry');
  const data = sheet.getDataRange().getValues();
  Logger.log('[validateToken_] PatientRegistry 行数=' + data.length);
  const auditSheet = getSheet_('AuditLog');

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    Logger.log('[validateToken_] 行' + i + ': row[0]=' + JSON.stringify(String(row[0])) + ' patientNo=' + JSON.stringify(String(patientNo)) + ' 一致=' + (String(row[0]) === String(patientNo)));
    if (String(row[0]) !== String(patientNo)) continue;

    Logger.log('[validateToken_] 患者発見 isActive=' + row[6] + ' expiresAt=' + row[5]);
    if (!row[6]) { // isActive（G列）
      auditLog_(auditSheet, patientNo, 'token_inactive');
      return { valid: false, reason: 'inactive' };
    }
    const expiresAt = new Date(row[5]); // tokenExpiresAt（F列）
    const now = new Date();
    Logger.log('[validateToken_] 有効期限チェック now=' + now.toISOString() + ' expiresAt=' + expiresAt.toISOString() + ' 期限切れ=' + (now > expiresAt));
    if (now > expiresAt) {
      auditLog_(auditSheet, patientNo, 'token_expired');
      return { valid: false, reason: 'expired' };
    }
    const storedSalt = String(row[4]);
    const storedHash = String(row[3]);
    const calcHash = hashToken_(storedSalt, plainToken); // tokenSalt（E列）
    Logger.log('[validateToken_] ハッシュチェック storedHash=' + storedHash.substring(0,8) + '... calcHash=' + calcHash.substring(0,8) + '... 一致=' + (calcHash === storedHash));
    if (calcHash !== storedHash) { // tokenHash（D列）
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
  Logger.log('[validateToken_] 患者番号が見つからなかった patientNo=' + patientNo);
  auditLog_(auditSheet, patientNo, 'token_invalid');
  return { valid: false, reason: 'invalid' };
}

// ===== 患者コンテキスト取得（患者フォームから呼ばれる） =====
function getPatientContext(patientNo, token) {
  Logger.log('[getPatientContext] 開始 patientNo=' + patientNo);
  const validation = validateToken_(patientNo, token);
  Logger.log('[getPatientContext] validateToken_ 結果=' + JSON.stringify(validation));
  if (!validation.valid) return validation;

  const result = buildPatientContextPayload_(patientNo, validation.birthdate, validation.notes);
  Logger.log('[getPatientContext] 返却完了');
  return result;
}

// ===== 患者コンテキスト組み立て（トークン検証済みの場合に呼ぶ共通処理） =====
function buildPatientContextPayload_(patientNo, birthdate, notes) {
  const vhSheet = getSheet_('VisitHistory');
  const vhData = vhSheet.getDataRange().getValues();
  let lastVisit = null;
  for (let i = 1; i < vhData.length; i++) {
    const row = vhData[i];
    if (String(row[0]) !== String(patientNo)) continue;
    if (!lastVisit || row[1] > lastVisit.visitDate) {
      let parsedDrugs = [];
      if (row[3]) {
        try {
          const raw = JSON.parse(row[3]);
          parsedDrugs = raw.map(function(d) {
            return { name: d.name || '', partLabel: d.partLabel || '', freqLabel: d.freqLabel || '' };
          });
        } catch (e) {}
      }
      const fmtDate = function(v) {
        if (!v) return '';
        if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
        return String(v);
      };
      lastVisit = {
        visitDate: fmtDate(row[1]),
        nextVisitDate: fmtDate(row[2]),
        drugsJson: parsedDrugs,
        rxSummaryText: row[4] || ''
      };
    }
  }
  return {
    valid: true,
    ageLabel: calcAgeLabel_(birthdate),
    ageGroup: calcAgeGroup_(birthdate),
    notes: notes || '',
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
    'pending',                                                    // [12] M status
    JSON.stringify(reportData.triggers || []),                    // [13] N triggersJson
    reportData.triggerNote || '',                                 // [14] O triggerNote
    JSON.stringify(reportData.topicalUse || [])                   // [15] P topicalUseJson
  ]);
  // B列（patientNo）をテキスト書式に設定（先頭0を保持するため）
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, 2).setNumberFormat('@');
  sheet.getRange(newRow, 2).setValue(String(reportData.patientNo));
  return { ok: true, reportId: reportId };
}

// ===== 固定QR認証（新フロー）: 診察券番号 + PINのみで認証。初診は別途birthdate入力 =====
function validateFixedAuthNew(patientNo, pin) {
  // 1. DailyPIN チェック
  const pinSheet = getSheet_('DailyPIN');
  if (!pinSheet) {
    auditLog_(getSheet_('AuditLog'), patientNo || 'unknown', 'fixed_auth_fail');
    return { valid: false };
  }
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const pinData = pinSheet.getDataRange().getValues();
  let pinValid = false;
  for (let i = 1; i < pinData.length; i++) {
    if (String(pinData[i][0]).trim().substring(0, 10) === todayStr &&
        pinData[i][2] === true &&
        String(pinData[i][1]).trim() === String(pin).trim()) {
      pinValid = true;
      break;
    }
  }
  if (!pinValid) {
    auditLog_(getSheet_('AuditLog'), patientNo || 'unknown', 'fixed_auth_fail');
    return { valid: false };
  }

  // 2. PatientRegistry: patientNo 存在確認
  const regSheet = getSheet_('PatientRegistry');
  const regData = regSheet.getDataRange().getValues();
  for (let i = 1; i < regData.length; i++) {
    if (String(regData[i][0]) !== String(patientNo)) continue;
    if (!regData[i][6]) { // isActive false
      auditLog_(getSheet_('AuditLog'), patientNo, 'fixed_auth_fail');
      return { valid: false };
    }
    const rawBd = regData[i][1];
    const bdStr = (rawBd instanceof Date)
      ? Utilities.formatDate(rawBd, 'Asia/Tokyo', 'yyyy-MM-dd')
      : String(rawBd || '').trim();
    if (bdStr) {
      // 既存患者（birthdate あり）: そのままコンテキスト返却
      auditLog_(getSheet_('AuditLog'), patientNo, 'fixed_auth_ok');
      return Object.assign({ status: 'existing' }, buildPatientContextPayload_(String(patientNo), bdStr, regData[i][2] || ''));
    } else {
      // 初診患者（birthdate なし）: birthdate 入力が必要
      auditLog_(getSheet_('AuditLog'), patientNo, 'fixed_auth_new_patient');
      return { valid: true, status: 'new' };
    }
  }
  // PatientRegistryに存在しない患者も、PINが正しければ生年月日入力へ進む
  auditLog_(getSheet_('AuditLog'), patientNo || 'unknown', 'fixed_auth_new_patient');
  return { valid: true, status: 'new' };
}

// ===== 初診患者: 生年月日を登録してコンテキストを返す =====
function registerBirthdateAndGetContext(patientNo, pin, birthdate) {
  // PIN 再検証
  const pinSheet = getSheet_('DailyPIN');
  if (!pinSheet) return { valid: false };
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const pinData = pinSheet.getDataRange().getValues();
  let pinValid = false;
  for (let i = 1; i < pinData.length; i++) {
    if (String(pinData[i][0]).trim().substring(0, 10) === todayStr &&
        pinData[i][2] === true &&
        String(pinData[i][1]).trim() === String(pin).trim()) {
      pinValid = true;
      break;
    }
  }
  if (!pinValid) return { valid: false };

  // PatientRegistry: 患者行を見つけて birthdate を保存
  const regSheet = getSheet_('PatientRegistry');
  const regData = regSheet.getDataRange().getValues();
  for (let i = 1; i < regData.length; i++) {
    if (String(regData[i][0]) !== String(patientNo)) continue;
    if (!regData[i][6]) return { valid: false }; // isActive false
    regSheet.getRange(i + 1, 2).setValue(birthdate);
    auditLog_(getSheet_('AuditLog'), patientNo, 'fixed_birthdate_registered');
    return buildPatientContextPayload_(String(patientNo), birthdate, regData[i][2] || '');
  }
  // PatientRegistryに存在しない新規患者: 新規行を作成して登録
  regSheet.appendRow([String(patientNo), birthdate, '', '', '', '', true]);
  const newRow = regSheet.getLastRow();
  regSheet.getRange(newRow, 1).setNumberFormat('@');
  regSheet.getRange(newRow, 1).setValue(String(patientNo));
  auditLog_(getSheet_('AuditLog'), patientNo, 'fixed_new_patient_registered');
  return buildPatientContextPayload_(String(patientNo), birthdate, '');
}

// ===== 固定QRルート: アンケート送信（PIN + 患者番号のみで再検証） =====
function submitPatientReportFixed2(patientNo, pin, reportData) {
  // PIN 再検証
  const pinSheet = getSheet_('DailyPIN');
  if (!pinSheet) return { ok: false, reason: 'auth' };
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const pinData = pinSheet.getDataRange().getValues();
  let pinValid = false;
  for (let i = 1; i < pinData.length; i++) {
    if (String(pinData[i][0]).trim().substring(0, 10) === todayStr &&
        pinData[i][2] === true &&
        String(pinData[i][1]).trim() === String(pin).trim()) {
      pinValid = true;
      break;
    }
  }
  if (!pinValid) return { ok: false, reason: 'auth' };

  // 患者存在確認
  const regSheet = getSheet_('PatientRegistry');
  const regData = regSheet.getDataRange().getValues();
  let patientValid = false;
  for (let i = 1; i < regData.length; i++) {
    if (String(regData[i][0]) === String(patientNo) && regData[i][6]) {
      patientValid = true;
      break;
    }
  }
  if (!patientValid) return { ok: false, reason: 'auth' };

  // PatientReports に保存
  const sheet = getSheet_('PatientReports');
  const reportId = Utilities.getUuid();
  sheet.appendRow([
    reportId,
    String(patientNo),
    new Date().toISOString(),
    reportData.symptomScore,
    reportData.nrsScore !== undefined ? reportData.nrsScore : '',
    JSON.stringify(reportData.infectionSigns || []),
    reportData.symptomNotes || '',
    JSON.stringify(reportData.poemScores || {}),
    JSON.stringify(reportData.medicationRemain || []),
    '', '', '',
    'pending',
    JSON.stringify(reportData.triggers || []),
    reportData.triggerNote || '',
    JSON.stringify(reportData.topicalUse || [])
  ]);
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, 2).setNumberFormat('@');
  sheet.getRange(newRow, 2).setValue(String(patientNo));
  auditLog_(getSheet_('AuditLog'), patientNo, 'fixed_submit_ok');
  return { ok: true, reportId: reportId };
}

// ===== 固定QR認証: DailyPINと患者情報を検証し、患者コンテキストを返す =====
function validateFixedAuth(patientNo, birthdate, pin) {
  // 1. DailyPIN チェック（JST当日 + enabled=true）
  const pinSheet = getSheet_('DailyPIN');
  if (!pinSheet) {
    auditLog_(getSheet_('AuditLog'), patientNo || 'unknown', 'fixed_auth_fail');
    return { valid: false };
  }
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const pinData = pinSheet.getDataRange().getValues();
  let pinValid = false;
  for (let i = 1; i < pinData.length; i++) {
    const rowDate    = String(pinData[i][0]).trim().substring(0, 10);
    const rowPin     = String(pinData[i][1]).trim();
    const rowEnabled = pinData[i][2];
    if (rowDate === todayStr && rowEnabled === true && rowPin === String(pin).trim()) {
      pinValid = true;
      break;
    }
  }
  if (!pinValid) {
    auditLog_(getSheet_('AuditLog'), patientNo || 'unknown', 'fixed_auth_fail');
    return { valid: false };
  }

  // 2. PatientRegistry: patientNo + isActive + birthdate 一致チェック
  const regSheet = getSheet_('PatientRegistry');
  const regData = regSheet.getDataRange().getValues();
  for (let i = 1; i < regData.length; i++) {
    if (String(regData[i][0]) !== String(patientNo)) continue;
    if (!regData[i][6]) { // isActive
      auditLog_(getSheet_('AuditLog'), patientNo, 'fixed_auth_fail');
      return { valid: false };
    }
    const rawBd    = regData[i][1];
    const storedBd = (rawBd instanceof Date)
      ? Utilities.formatDate(rawBd, 'Asia/Tokyo', 'yyyy-MM-dd')
      : String(rawBd).trim().substring(0, 10);
    const inputBd  = String(birthdate).trim().substring(0, 10);
    if (storedBd !== inputBd) {
      auditLog_(getSheet_('AuditLog'), patientNo, 'fixed_auth_fail');
      return { valid: false };
    }
    // 認証成功
    auditLog_(getSheet_('AuditLog'), patientNo, 'fixed_auth_ok');
    return buildPatientContextPayload_(String(patientNo), regData[i][1] || '', regData[i][2] || '');
  }
  auditLog_(getSheet_('AuditLog'), patientNo || 'unknown', 'fixed_auth_fail');
  return { valid: false };
}

// ===== 固定QRルート: アンケート送信（再認証してから保存） =====
function submitPatientReportFixed(patientNo, birthdate, pin, reportData) {
  // 送信時に再検証
  const pinSheet = getSheet_('DailyPIN');
  if (!pinSheet) return { ok: false, reason: 'auth' };
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const pinData = pinSheet.getDataRange().getValues();
  let pinValid = false;
  for (let i = 1; i < pinData.length; i++) {
    const rowDate    = String(pinData[i][0]).trim().substring(0, 10);
    const rowPin     = String(pinData[i][1]).trim();
    const rowEnabled = pinData[i][2];
    if (rowDate === todayStr && rowEnabled === true && rowPin === String(pin).trim()) {
      pinValid = true;
      break;
    }
  }
  if (!pinValid) return { ok: false, reason: 'auth' };

  const regSheet = getSheet_('PatientRegistry');
  const regData = regSheet.getDataRange().getValues();
  let patientValid = false;
  for (let i = 1; i < regData.length; i++) {
    if (String(regData[i][0]) !== String(patientNo)) continue;
    if (!regData[i][6]) break;
    const rawBd2   = regData[i][1];
    const storedBd = (rawBd2 instanceof Date)
      ? Utilities.formatDate(rawBd2, 'Asia/Tokyo', 'yyyy-MM-dd')
      : String(rawBd2).trim().substring(0, 10);
    const inputBd  = String(birthdate).trim().substring(0, 10);
    if (storedBd === inputBd) patientValid = true;
    break;
  }
  if (!patientValid) return { ok: false, reason: 'auth' };

  // 検証通過 → PatientReports に保存
  const sheet = getSheet_('PatientReports');
  const reportId = Utilities.getUuid();
  sheet.appendRow([
    reportId,
    String(patientNo),
    new Date().toISOString(),
    reportData.symptomScore,
    reportData.nrsScore !== undefined ? reportData.nrsScore : '',
    JSON.stringify(reportData.infectionSigns || []),
    reportData.symptomNotes || '',
    JSON.stringify(reportData.poemScores || {}),
    JSON.stringify(reportData.medicationRemain || []),
    '', '', '',
    'pending',
    JSON.stringify(reportData.triggers || []),
    reportData.triggerNote || '',
    JSON.stringify(reportData.topicalUse || [])
  ]);
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, 2).setNumberFormat('@');
  sheet.getRange(newRow, 2).setValue(String(patientNo));
  auditLog_(getSheet_('AuditLog'), patientNo, 'fixed_submit_ok');
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

  // VisitHistory を患者ごとに整理（visitDate 降順）
  const vhByPatient = {};
  for (let i = 1; i < vhData.length; i++) {
    try {
      const pno = String(vhData[i][0]);
      if (!vhByPatient[pno]) vhByPatient[pno] = [];
      let drugsJson = [];
      try { drugsJson = vhData[i][3] ? JSON.parse(vhData[i][3]) : []; } catch(e) {}
      vhByPatient[pno].push({
        visitDate: dateToStr_(vhData[i][1]),
        nextVisitDate: dateToStr_(vhData[i][2]),
        drugsJson: drugsJson,
        rxSummaryText: vhData[i][4] || ''
      });
    } catch(e) {}
  }
  for (const pno in vhByPatient) {
    vhByPatient[pno].sort(function(a, b) { return b.visitDate.localeCompare(a.visitDate); });
  }

  // ClinicalAssessments から最新評価をマップ化
  const assessmentMap = {};
  try {
    const caSheet = getSheet_('ClinicalAssessments');
    if (caSheet) {
      const caData = caSheet.getDataRange().getValues();
      for (let i = 1; i < caData.length; i++) {
        const pno = String(caData[i][1]);
        const assessedAt = caData[i][3] ? String(caData[i][3]) : '';
        if (!assessmentMap[pno] || assessedAt > assessmentMap[pno].assessedAt) {
          assessmentMap[pno] = assessmentRowToObj_(caData[i]);
        }
      }
    }
  } catch(e) {}

  const pending = [], reviewed = [];
  for (let i = 1; i < prData.length; i++) {
    try {
      const row = prData[i];
      const pno = String(row[1]).trim();
      const reg = patientMap[pno] || patientMap[pno.replace(/^0+/, '')] || {};
      let infectionSigns = [], poemScores = {}, medicationRemain = [], triggers = [], topicalUse = [];
      try { infectionSigns   = row[5]  ? JSON.parse(row[5])  : []; } catch(e) {} // F infectionSignsJson
      try { poemScores       = row[7]  ? JSON.parse(row[7])  : {}; } catch(e) {} // H poemJson
      try { medicationRemain = row[8]  ? JSON.parse(row[8])  : []; } catch(e) {} // I medicationJson
      try { triggers         = row[13] ? JSON.parse(row[13]) : []; } catch(e) {} // N triggersJson
      try { topicalUse       = row[15] ? JSON.parse(row[15]) : []; } catch(e) {} // P topicalUseJson
      const entry = {
        reportId: row[0],
        patientNo: pno,
        birthdate: String(reg.birthdate || ''),
        ageLabel: calcAgeLabel_(reg.birthdate),
        ageGroup: calcAgeGroup_(reg.birthdate),
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
        triggers: triggers,                                      // N
        triggerNote: row[14] || '',                              // O
        topicalUse: topicalUse,                                  // P
        lastRx: (function() {
          // レポート送信日（JST）より前の訪問のみを「前回処方」として返す
          var reportDateStr = row[2] ? Utilities.formatDate(new Date(row[2]), 'Asia/Tokyo', 'yyyy-MM-dd') : '';
          var visits = vhByPatient[pno] || [];
          for (var vi = 0; vi < visits.length; vi++) {
            if (!reportDateStr || visits[vi].visitDate < reportDateStr) return visits[vi];
          }
          return null;
        })(),
        lastAssessment: assessmentMap[pno] || null,
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

// ===== Claude相談用：患者包括データ取得 =====
function getPatientConsultData(patientNo) {
  if (!patientNo) return { ok: false, reason: 'patientNo is required' };
  const pno = String(patientNo).trim();

  // 1. PatientRegistry
  const regSheet = getSheet_('PatientRegistry');
  const regData  = regSheet.getDataRange().getValues();
  let birthdate = '', notes = '';
  for (let i = 1; i < regData.length; i++) {
    if (String(regData[i][0]).trim() === pno) {
      birthdate = regData[i][1] ? dateToStr_(regData[i][1]) : '';
      notes     = String(regData[i][2] || '');
      break;
    }
  }

  // 2. VisitHistory: 該当患者の全件（visitDate 降順）
  const vhSheet = getSheet_('VisitHistory');
  const vhData  = vhSheet.getDataRange().getValues();
  const visits  = [];
  for (let i = 1; i < vhData.length; i++) {
    if (String(vhData[i][0]).trim() !== pno) continue;
    let drugsJson = [];
    try { drugsJson = vhData[i][3] ? JSON.parse(vhData[i][3]) : []; } catch(e) {}
    visits.push({
      visitDate:     dateToStr_(vhData[i][1]),
      nextVisitDate: dateToStr_(vhData[i][2]),
      drugsJson:     drugsJson,
      rxSummaryText: String(vhData[i][4] || '')
    });
  }
  visits.sort(function(a, b) { return b.visitDate.localeCompare(a.visitDate); });

  // 3. PatientReports: 直近5件（submittedAt 降順）、全フィールド
  const prSheet   = getSheet_('PatientReports');
  const prData    = prSheet.getDataRange().getValues();
  const allReports = [];
  for (let i = 1; i < prData.length; i++) {
    const row = prData[i];
    if (String(row[1]).trim() !== pno) continue;
    let infectionSigns = [], poemScores = {}, medicationRemain = [], triggers = [], topicalUse = [];
    try { infectionSigns   = row[5]  ? JSON.parse(row[5])  : []; } catch(e) {}
    try { poemScores       = row[7]  ? JSON.parse(row[7])  : {}; } catch(e) {}
    try { medicationRemain = row[8]  ? JSON.parse(row[8])  : []; } catch(e) {}
    try { triggers         = row[13] ? JSON.parse(row[13]) : []; } catch(e) {}
    try { topicalUse       = row[15] ? JSON.parse(row[15]) : []; } catch(e) {}
    allReports.push({
      reportId:        String(row[0]),
      submittedAt:     row[2] ? new Date(row[2]).toISOString() : '',
      symptomScore:    row[3],
      nrsScore:        row[4] !== '' && row[4] !== null ? row[4] : null,
      infectionSigns:  infectionSigns,
      symptomNotes:    String(row[6] || ''),
      poemScores:      poemScores,
      medicationRemain:medicationRemain,
      doctorComment:   String(row[9]  || ''),
      nextAppointment: dateToStr_(row[10]),
      status:          String(row[12] || 'pending'),
      triggers:        triggers,
      triggerNote:     String(row[14] || ''),
      topicalUse:      topicalUse
    });
  }
  allReports.sort(function(a, b) { return b.submittedAt.localeCompare(a.submittedAt); });
  const reports = allReports.slice(0, 5);

  // 4. ClinicalAssessments: 全件（visitDate 降順）
  const assessments = [];
  try {
    const caSheet = getOrCreateClinicalAssessmentsSheet_();
    if (caSheet) {
      const caData = caSheet.getDataRange().getValues();
      for (let i = 1; i < caData.length; i++) {
        if (String(caData[i][1]).trim() !== pno) continue;
        assessments.push(assessmentRowToObj_(caData[i]));
      }
      assessments.sort(function(a, b) { return b.visitDate.localeCompare(a.visitDate); });
    }
  } catch(e) {}

  return {
    ok:          true,
    patientNo:   pno,
    birthdate:   birthdate,
    ageLabel:    calcAgeLabel_(birthdate),
    notes:       notes,
    visits:      visits,
    reports:     reports,
    assessments: assessments
  };
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

// ===== PatientRegistry ヘッダー修正（1回だけ実行） =====
function fixPatientRegistryHeaders() {
  const sheet = getSheet_('PatientRegistry');
  const correctHeaders = ['patientNo', 'birthdate', 'notes', 'tokenHash', 'tokenSalt', 'tokenExpiresAt', 'isActive'];
  sheet.getRange(1, 1, 1, correctHeaders.length).setValues([correctHeaders]);
  sheet.getRange(1, 1, 1, correctHeaders.length).setFontWeight('bold').setBackground('#e8f5e9');
  Logger.log('ヘッダー修正完了: ' + correctHeaders.join(', '));
}

// ===== 特定患者の列データ確認（患者番号を書き換えて実行） =====
function debugPatientRow() {
  const PATIENT_NO = '01631';
  const sheet = getSheet_('PatientRegistry');
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  Logger.log('ヘッダー: ' + JSON.stringify(headers));
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) !== String(PATIENT_NO)) continue;
    Logger.log('行' + i + 'の列数: ' + data[i].length);
    for (let j = 0; j < data[i].length; j++) {
      const val = String(data[i][j]);
      Logger.log('  [' + j + '] ' + (headers[j] || '(ヘッダーなし)') + ' = ' + val.substring(0, 40));
    }
    break;
  }
}

// ===== デバッグ用: validateToken_ 直接テスト =====
function testValidateToken() {
  const PATIENT_NO = '01631';
  const TOKEN = '4695';
  try {
    const result = validateToken_(PATIENT_NO, TOKEN);
    Logger.log('validateToken_ 結果: ' + JSON.stringify(result));
  } catch(e) {
    Logger.log('例外: ' + e.message + '\n' + e.stack);
  }
}

// ===== デバッグ用: getPatientContext 手動実行（GASエディタからTOKENを書き換えて実行） =====
function debugGetPatientContext() {
  const PATIENT_NO = '01631';
  const TOKEN = 'XXXX'; // 実際のトークン4桁に書き換えてから実行
  try {
    const result = getPatientContext(PATIENT_NO, TOKEN);
    Logger.log('最終結果: ' + JSON.stringify(result));
  } catch(e) {
    Logger.log('例外: ' + e.message + '\n' + e.stack);
  }
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
    'PatientReports':  ['reportId', 'patientNo', 'submittedAt', 'symptomScore', 'nrsScore', 'infectionSignsJson', 'symptomNotes', 'poemJson', 'medicationJson', 'doctorComment', 'nextAppointment', 'commentAt', 'status', 'triggersJson', 'triggerNote', 'topicalUseJson'],
    'AuditLog':              ['timestamp', 'patientNo', 'action'],
    'ClinicalAssessments':   ['assessmentId', 'patientNo', 'visitDate', 'assessedAt', 'easiHead', 'easiTrunk', 'easiUpperLimb', 'easiLowerLimb', 'easiTotal', 'easiSeverity', 'iga', 'lesionMapJson', 'notes', 'easiRawJson'],
    'DailyPIN':              ['date', 'pin', 'enabled']
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
    if (['PatientRegistry', 'VisitHistory', 'DailyPIN'].includes(name)) {
      sheet.getRange('A:A').setNumberFormat('@');
    } else if (['PatientReports', 'AuditLog', 'ClinicalAssessments'].includes(name)) {
      sheet.getRange('B:B').setNumberFormat('@');
    }
  }

  Logger.log('シート初期設定が完了しました');
}

// ===== DailyPIN シート追加（既存デプロイ用・1回のみ実行） =====
function addDailyPinSheet() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('DailyPIN');
  if (!sheet) {
    sheet = ss.insertSheet('DailyPIN');
    const headers = ['date', 'pin', 'enabled'];
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e8f5e9');
    sheet.getRange('A:A').setNumberFormat('@');
    Logger.log('DailyPIN シートを作成しました');
  } else {
    Logger.log('DailyPIN シートはすでに存在します');
  }
}

// ===== DailyPIN: 当日分のPINを自動生成（毎朝トリガーから呼ばれる） =====
function generateDailyPin() {
  const sheet = getSheet_('DailyPIN');
  if (!sheet) return;
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  // 当日行が既にあればスキップ
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().substring(0, 10) === today) {
      Logger.log('DailyPIN: 当日行が既に存在します ' + today);
      return;
    }
  }

  // 4桁ランダムPIN（0000〜9999）
  const pin = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  sheet.appendRow([today, pin, true]);
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, 1).setNumberFormat('@');
  sheet.getRange(newRow, 1).setValue(today);
  Logger.log('DailyPIN生成: ' + today + ' / ' + pin);
}

// ===== DailyPIN: 毎朝8時の自動生成トリガーを設定（1回のみ実行） =====
function setupDailyPinTrigger() {
  // 既存のトリガーを削除して重複を防ぐ
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'generateDailyPin') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('generateDailyPin')
    .timeBased()
    .atHour(8)
    .everyDays(1)
    .inTimezone('Asia/Tokyo')
    .create();
  Logger.log('DailyPIN自動生成トリガーを設定しました（毎朝8時 JST）');
}

// ===== PatientReports: triggersJson / triggerNote 列追加（既存シート用・1回のみ実行） =====
function addTriggersColumns() {
  const sheet = getSheet_('PatientReports');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!headers.includes('triggersJson')) {
    sheet.getRange(1, headers.length + 1).setValue('triggersJson');
  }
  if (!headers.includes('triggerNote')) {
    const col = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].length + 1;
    sheet.getRange(1, col).setValue('triggerNote');
  }
  Logger.log('triggersJson / triggerNote 列を追加しました');
}

// ===== PatientReports: topicalUseJson 列追加（既存シート用・1回のみ実行） =====
function addTopicalUseColumn() {
  const sheet = getSheet_('PatientReports');
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!headers.includes('topicalUseJson')) {
    sheet.getRange(1, headers.length + 1).setValue('topicalUseJson');
  }
  Logger.log('topicalUseJson 列を追加しました');
}

// ===== ClinicalAssessments: シート取得/作成 =====
function getOrCreateClinicalAssessmentsSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName('ClinicalAssessments');
  if (!sheet) {
    sheet = ss.insertSheet('ClinicalAssessments');
    const headers = ['assessmentId', 'patientNo', 'visitDate', 'assessedAt', 'easiHead', 'easiTrunk', 'easiUpperLimb', 'easiLowerLimb', 'easiTotal', 'easiSeverity', 'iga', 'lesionMapJson', 'notes', 'easiRawJson'];
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e8f5e9');
    sheet.getRange('B:B').setNumberFormat('@');
  }
  return sheet;
}

// ===== google.script.run 用の公開ラッパー（アンダースコア付き関数は呼び出せないため） =====
function saveAssessment(data)          { return saveAssessment_(data); }
function getAssessmentList(patientNo)  { return getAssessmentList_(patientNo); }

// ===== ClinicalAssessments: 既存スプレッドシートへの1回限り追加（移行用） =====
function addClinicalAssessmentsSheet() {
  const sheet = getOrCreateClinicalAssessmentsSheet_();
  Logger.log('ClinicalAssessments シートを確認/作成しました: 行数=' + sheet.getLastRow());
}

// ===== EASI計算 =====
const EASI_WEIGHT_ADULT_ = { head: 0.1, trunk: 0.3, upperLimb: 0.2, lowerLimb: 0.4 };
const EASI_WEIGHT_CHILD_ = { head: 0.2, trunk: 0.3, upperLimb: 0.2, lowerLimb: 0.3 };

// birthdate と評価日から年齢を計算し、適切な重みを返す（8歳未満=小児、8歳以上=成人）
function getEasiWeight_(birthdate, refDate) {
  if (!birthdate) return EASI_WEIGHT_ADULT_;
  const bd = new Date(String(birthdate));
  if (isNaN(bd.getTime())) return EASI_WEIGHT_ADULT_;
  const ref = refDate ? new Date(String(refDate)) : new Date();
  let age = ref.getFullYear() - bd.getFullYear();
  const m = ref.getMonth() - bd.getMonth();
  if (m < 0 || (m === 0 && ref.getDate() < bd.getDate())) age--;
  return age < 8 ? EASI_WEIGHT_CHILD_ : EASI_WEIGHT_ADULT_;
}

function calcEasiPart_(part) {
  const signs = (part.E || 0) + (part.I || 0) + (part.Ex || 0) + (part.L || 0);
  return signs * (part.A || 0);
}

function calcEasi_(easi, birthdate, visitDate) {
  const w = getEasiWeight_(birthdate, visitDate);
  const head      = calcEasiPart_(easi.head      || {}) * w.head;
  const trunk     = calcEasiPart_(easi.trunk     || {}) * w.trunk;
  const upperLimb = calcEasiPart_(easi.upperLimb || {}) * w.upperLimb;
  const lowerLimb = calcEasiPart_(easi.lowerLimb || {}) * w.lowerLimb;
  const total = Math.round((head + trunk + upperLimb + lowerLimb) * 10) / 10;
  return { head, trunk, upperLimb, lowerLimb, total };
}

function getEasiSeverity_(total) {
  if (total === 0)   return 'clear';
  if (total <= 6)    return 'mild';
  if (total <= 21)   return 'moderate';
  if (total <= 50)   return 'severe';
  return 'very_severe';
}

// ===== ClinicalAssessments: 保存 =====
function saveAssessment_(data) {
  if (!data.patientNo || !data.visitDate) {
    return { ok: false, reason: 'patientNo and visitDate are required' };
  }

  // PatientRegistry から birthdate を取得して年齢適切な重みで計算
  const regSheet = getSheet_('PatientRegistry');
  const regData = regSheet.getDataRange().getValues();
  let birthdate = '';
  for (let i = 1; i < regData.length; i++) {
    if (String(regData[i][0]).trim() === String(data.patientNo).trim()) {
      birthdate = regData[i][1] ? String(regData[i][1]) : '';
      break;
    }
  }
  const easi = calcEasi_(data.easi || {}, birthdate, data.visitDate);
  const severity = getEasiSeverity_(easi.total);
  const assessmentId = Utilities.getUuid();
  const assessedAt = new Date().toISOString();

  const sheet = getOrCreateClinicalAssessmentsSheet_();
  sheet.appendRow([
    assessmentId,                        // [0]  assessmentId
    String(data.patientNo),              // [1]  patientNo
    String(data.visitDate),              // [2]  visitDate
    assessedAt,                          // [3]  assessedAt
    easi.head,                           // [4]  easiHead
    easi.trunk,                          // [5]  easiTrunk
    easi.upperLimb,                      // [6]  easiUpperLimb
    easi.lowerLimb,                      // [7]  easiLowerLimb
    easi.total,                          // [8]  easiTotal
    severity,                            // [9]  easiSeverity
    data.iga !== undefined ? data.iga : '', // [10] iga
    '',                                  // [11] lesionMapJson（将来用）
    data.notes || '',                    // [12] notes
    JSON.stringify(data.easi || {})      // [13] easiRawJson（入力元データ）
  ]);
  const newRow = sheet.getLastRow();
  sheet.getRange(newRow, 2).setNumberFormat('@');
  sheet.getRange(newRow, 2).setValue(String(data.patientNo));

  // reportId が渡された場合、対応するPatientReportのstatusを'assessed'に更新
  if (data.reportId) {
    const prSheet = getSheet_('PatientReports');
    const prData = prSheet.getDataRange().getValues();
    for (let i = 1; i < prData.length; i++) {
      if (String(prData[i][0]).trim() === String(data.reportId).trim()) {
        prSheet.getRange(i + 1, 13).setValue('assessed');
        break;
      }
    }
  }

  return { ok: true, assessmentId, easiTotal: easi.total, easiSeverity: severity };
}

// ===== ClinicalAssessments: 行→オブジェクト変換ヘルパー =====
function assessmentRowToObj_(row) {
  return {
    assessmentId:   String(row[0]),
    patientNo:      String(row[1]),
    visitDate:      dateToStr_(row[2]),
    assessedAt:     String(row[3]),
    easiHead:       row[4],
    easiTrunk:      row[5],
    easiUpperLimb:  row[6],
    easiLowerLimb:  row[7],
    easiTotal:      row[8],
    easiSeverity:   String(row[9]),
    iga:            row[10] !== '' ? row[10] : null,
    lesionMapJson:  String(row[11]),
    notes:          String(row[12]),
    easiRawJson:    row[13] ? (function(v){ try { return JSON.parse(v); } catch(e) { return null; } })(row[13]) : null
  };
}

// ===== ClinicalAssessments: assessmentId指定で取得 =====
function getAssessment_(assessmentId) {
  if (!assessmentId) return { ok: false, reason: 'assessmentId is required' };
  const sheet = getSheet_('ClinicalAssessments');
  if (!sheet) return { ok: false, reason: 'no_data' };
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(assessmentId).trim()) {
      return { ok: true, assessment: assessmentRowToObj_(data[i]) };
    }
  }
  return { ok: false, reason: 'not_found' };
}

// ===== ClinicalAssessments: patientNo + visitDate指定で取得 =====
function getAssessmentByVisit_(patientNo, visitDate) {
  if (!patientNo || !visitDate) return { ok: false, reason: 'patientNo and visitDate are required' };
  const sheet = getSheet_('ClinicalAssessments');
  if (!sheet) return { ok: true, assessments: [] };
  const data = sheet.getDataRange().getValues();
  const results = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === String(patientNo) && String(data[i][2]) === String(visitDate)) {
      results.push(assessmentRowToObj_(data[i]));
    }
  }
  return { ok: true, assessments: results };
}

// ===== ClinicalAssessments: patientNo指定で全履歴取得（assessedAt降順） =====
function getAssessmentList_(patientNo) {
  if (!patientNo) return { ok: false, reason: 'patientNo is required' };
  const sheet = getSheet_('ClinicalAssessments');
  if (!sheet) return { ok: true, assessments: [] };
  const data = sheet.getDataRange().getValues();
  const results = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1]) === String(patientNo)) {
      results.push(assessmentRowToObj_(data[i]));
    }
  }
  results.sort((a, b) => new Date(b.assessedAt) - new Date(a.assessedAt));
  return { ok: true, assessments: results };
}

// ===== ClinicalAssessments: easiRawJson 列追加（既存シート用・1回のみ実行） =====
function addEasiRawJsonColumn() {
  const sheet = getSheet_('ClinicalAssessments');
  if (!sheet) { Logger.log('ClinicalAssessments シートが存在しません'); return; }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (!headers.includes('easiRawJson')) {
    sheet.getRange(1, headers.length + 1).setValue('easiRawJson');
    Logger.log('easiRawJson 列を追加しました');
  } else {
    Logger.log('easiRawJson 列はすでに存在します');
  }
}

// ===== テスト用: saveAssessment_ 動作確認（GASエディタから実行） =====
function testSaveAssessment() {
  const data = {
    patientNo: '99999',
    visitDate: '2026-05-22',
    easi: {
      head:      { E: 2, I: 1, Ex: 1, L: 0, A: 3 },
      trunk:     { E: 1, I: 1, Ex: 0, L: 0, A: 2 },
      upperLimb: { E: 2, I: 2, Ex: 1, L: 1, A: 4 },
      lowerLimb: { E: 1, I: 1, Ex: 1, L: 0, A: 2 }
    },
    iga: 3,
    notes: 'テスト用データ'
  };
  try {
    const result = saveAssessment_(data);
    Logger.log('saveAssessment_ 結果: ' + JSON.stringify(result));
  } catch(e) {
    Logger.log('例外: ' + e.message + '\n' + e.stack);
  }
}

// ===== テスト用: getAssessmentList_ 動作確認（testSaveAssessment後に実行） =====
function testGetAssessmentList() {
  try {
    const result = getAssessmentList_('99999');
    Logger.log('getAssessmentList_ 件数: ' + result.assessments.length);
    if (result.assessments.length > 0) {
      Logger.log('最新: ' + JSON.stringify(result.assessments[0]));
    }
  } catch(e) {
    Logger.log('例外: ' + e.message + '\n' + e.stack);
  }
}

// ===== 既存EASIデータを年齢適切な重みで一括再計算（GASエディタから手動実行） =====
// 実行前に必ずスプレッドシートをバックアップしてください
function recalcEasiWithAgeWeights() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const caSheet = ss.getSheetByName('ClinicalAssessments');
  if (!caSheet) { Logger.log('ClinicalAssessments シートが見つかりません'); return; }

  // PatientRegistry から birthdate マップを作成
  const regSheet = ss.getSheetByName('PatientRegistry');
  const regData = regSheet.getDataRange().getValues();
  const birthdateMap = {};
  for (let i = 1; i < regData.length; i++) {
    birthdateMap[String(regData[i][0]).trim()] = regData[i][1] ? String(regData[i][1]) : '';
  }

  const data = caSheet.getDataRange().getValues();
  let updated = 0, skipped = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const patientNo  = String(row[1]).trim();
    const visitDate  = dateToStr_(row[2]);
    const rawJson    = row[13];

    if (!rawJson) { skipped++; continue; } // easiRawJson がない行はスキップ

    let easiRaw;
    try { easiRaw = JSON.parse(rawJson); } catch(e) { skipped++; continue; }

    const birthdate = birthdateMap[patientNo] || birthdateMap[patientNo.replace(/^0+/, '')] || '';
    const easi = calcEasi_(easiRaw, birthdate, visitDate);
    const severity = getEasiSeverity_(easi.total);

    const oldTotal = row[8];
    if (oldTotal === easi.total) { skipped++; continue; } // 変化なし

    // easiHead(E列=5), easiTrunk(F=6), easiUpperLimb(G=7), easiLowerLimb(H=8),
    // easiTotal(I=9), easiSeverity(J=10) を更新（列番号は1始まり）
    caSheet.getRange(i + 1, 5, 1, 6).setValues([[
      easi.head, easi.trunk, easi.upperLimb, easi.lowerLimb, easi.total, severity
    ]]);

    const w = getEasiWeight_(birthdate, visitDate);
    const mode = (w === EASI_WEIGHT_CHILD_) ? '小児' : '成人';
    Logger.log('更新: 行' + (i+1) + ' 患者' + patientNo + ' visitDate=' + visitDate
      + ' 重み=' + mode + ' ' + oldTotal + ' → ' + easi.total + ' (' + severity + ')');
    updated++;
  }

  Logger.log('完了: ' + updated + '件更新, ' + skipped + '件スキップ');
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
