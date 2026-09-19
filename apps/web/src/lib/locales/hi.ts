// ──────────────────────────────────────────────
// Hindi strings (हिन्दी) — Partial<typeof en>.
// Any key omitted here falls back to English automatically, so translation
// can land incrementally without ever blanking the UI.
// School-ERP register: "उपस्थिति" (attendance), "शुल्क" (fees),
// "समय-सारिणी" (timetable) — the words school staff actually use.
// ──────────────────────────────────────────────

import type { en } from './en';

export const hi: Partial<Record<keyof typeof en, string>> = {
  // ── Navigation ──
  'nav.dashboard': 'डैशबोर्ड',
  'nav.profile': 'मेरी प्रोफ़ाइल',
  'nav.branches': 'शाखाएँ',
  'nav.students': 'छात्र',
  'nav.staff': 'कर्मचारी एवं एचआर',
  'nav.academics': 'शैक्षणिक',
  'nav.timetableBuilder': 'समय-सारिणी निर्माता',
  'nav.attendance': 'उपस्थिति',
  'nav.attendanceDesk': 'उपस्थिति डेस्क',
  'nav.fees': 'शुल्क',
  'nav.communication': 'संचार',
  'nav.library': 'पुस्तकालय',
  'nav.transport': 'परिवहन',
  'nav.exams': 'परीक्षाएँ',
  'nav.settings': 'सेटिंग्स',
  'nav.myClasses': 'मेरी कक्षाएँ',
  'nav.myAttendance': 'मेरी उपस्थिति',
  'nav.myResults': 'मेरे परिणाम',
  'nav.myFees': 'मेरे शुल्क',
  'nav.timetable': 'समय-सारिणी',
  'nav.announcements': 'सूचनाएँ',
  'nav.childOverview': 'संतान अवलोकन',
  'nav.childAttendance': 'संतान की उपस्थिति',
  'nav.childResults': 'संतान के परिणाम',
  'nav.results': 'परिणाम',
  'nav.ptm': 'अभिभावक-शिक्षक बैठक',
  'nav.takeAttendance': 'उपस्थिति लें',
  'nav.enterMarks': 'अंक भरें',
  'nav.leaveRequest': 'अवकाश आवेदन',
  'nav.feeCollection': 'शुल्क संग्रह',
  'nav.expenseTracker': 'व्यय ट्रैकर',
  'nav.payroll': 'वेतन',
  'nav.financialReports': 'वित्तीय रिपोर्ट',
  'nav.invoicing': 'इनवॉइसिंग',
  'nav.budgets': 'बजट',

  // ── Topbar / session ──
  'topbar.logout': 'लॉग आउट',
  'topbar.language': 'भाषा',
  'topbar.switchBranch': 'शाखा बदलें',

  // ── Common actions ──
  'action.save': 'सहेजें',
  'action.saving': 'सहेजा जा रहा है…',
  'action.cancel': 'रद्द करें',
  'action.close': 'बंद करें',
  'action.delete': 'हटाएँ',
  'action.edit': 'संपादित करें',
  'action.add': 'जोड़ें',
  'action.retry': 'पुनः प्रयास',
  'action.done': 'पूर्ण',
  'action.search': 'खोजें',
  'action.import': 'एक्सेल आयात करें',
  'action.export': 'निर्यात',
  'action.back': 'वापस',

  // ── States ──
  'state.loading': 'लोड हो रहा है…',
  'state.empty': 'यहाँ अभी कुछ नहीं है',
  'state.error': 'कुछ गड़बड़ हो गई',
  'state.offline': 'आप ऑफ़लाइन हैं',
  'state.queued': '{{count}} कतार में',

  // ── Attendance ──
  'attendance.title': 'उपस्थिति',
  'attendance.markAllPresent': 'सभी उपस्थित',
  'attendance.markAllAbsent': 'सभी अनुपस्थित',
  'attendance.reset': 'रीसेट',
  'attendance.save': 'उपस्थिति सहेजें',
  'attendance.saveOffline': 'ऑफ़लाइन सहेजें',
  'attendance.unmarked': '{{count}} अचिह्नित',
  'attendance.present': 'उपस्थित',
  'attendance.absent': 'अनुपस्थित',
  'attendance.late': 'विलंब',
  'attendance.syncQueued': '{{count}} कतारित सिंक करें',
  'attendance.syncing': 'सिंक हो रहा है…',

  // ── Students ──
  'students.title': 'छात्र',
  'students.register': 'छात्र पंजीकृत करें',
  'students.searchPlaceholder': 'नाम या प्रवेश संख्या से खोजें…',
  'students.allClasses': 'सभी कक्षाएँ',
  'students.importTitle': 'एक्सेल से छात्र आयात करें',
  'students.importHint': 'प्रवेश शीट अपलोड करें, सत्यापन देखें, फिर सहेजें। मौजूद प्रवेश संख्याएँ अपडेट होती हैं, डुप्लिकेट नहीं बनतीं।',
  'students.selectFile': 'फ़ाइल चुनें',
  'students.validatePreview': 'सत्यापित करें और पूर्वावलोकन',
  'students.totalRows': 'कुल पंक्तियाँ',
  'students.ready': 'तैयार',
  'students.withErrors': 'त्रुटियों के साथ',
  'students.fixRows': 'फ़ाइल में इन पंक्तियों को ठीक करें, दोबारा अपलोड करें',
  'students.importN': '{{count}} छात्र आयात करें',
  'students.imported': '{{created}} आयात हुए, {{failed}} असफल',
  'students.importAnother': 'दूसरी फ़ाइल आयात करें',

  // ── Login ──
  'login.title': 'EduCore ERP',
  'login.email': 'ईमेल',
  'login.password': 'पासवर्ड',
  'login.signIn': 'साइन इन',
  'login.invalidCredentials': 'ईमेल या पासवर्ड गलत है',

  // ── Import modal (shared bits) ──
  'import.requiredColumns': 'आवश्यक कॉलम',
  'import.optionalColumns': 'वैकल्पिक कॉलम',
  'import.chooseAnother': '← दूसरी फ़ाइल चुनें',
};
