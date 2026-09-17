// ──────────────────────────────────────────────
// English strings — the source of truth for every locale.
// Flat dot-keys: grep-friendly, no nested-object merge surprises.
// ──────────────────────────────────────────────

export const en = {
  // ── Navigation ──
  'nav.dashboard': 'Dashboard',
  'nav.profile': 'My Profile',
  'nav.branches': 'Branches',
  'nav.students': 'Students',
  'nav.staff': 'Staff & HR',
  'nav.academics': 'Academics',
  'nav.timetableBuilder': 'Timetable Builder',
  'nav.attendance': 'Attendance',
  'nav.fees': 'Fees',
  'nav.communication': 'Communication',
  'nav.library': 'Library',
  'nav.transport': 'Transport',
  'nav.exams': 'Exams',
  'nav.settings': 'Settings',
  'nav.myClasses': 'My Classes',
  'nav.myAttendance': 'My Attendance',
  'nav.myResults': 'My Results',
  'nav.myFees': 'My Fees',
  'nav.timetable': 'Timetable',
  'nav.announcements': 'Announcements',
  'nav.childOverview': 'Child Overview',
  'nav.childAttendance': "Child's Attendance",
  'nav.childResults': "Child's Results",
  'nav.results': 'Results',
  'nav.ptm': 'PTM Schedule',
  'nav.takeAttendance': 'Take Attendance',
  'nav.enterMarks': 'Enter Marks',
  'nav.leaveRequest': 'Leave Request',
  'nav.feeCollection': 'Fee Collection',
  'nav.expenseTracker': 'Expense Tracker',
  'nav.payroll': 'Payroll',
  'nav.financialReports': 'Financial Reports',
  'nav.invoicing': 'Invoicing',
  'nav.budgets': 'Budgets',

  // ── Topbar / session ──
  'topbar.logout': 'Logout',
  'topbar.language': 'Language',
  'topbar.switchBranch': 'Switch branch',

  // ── Common actions ──
  'action.save': 'Save',
  'action.saving': 'Saving…',
  'action.cancel': 'Cancel',
  'action.close': 'Close',
  'action.delete': 'Delete',
  'action.edit': 'Edit',
  'action.add': 'Add',
  'action.retry': 'Retry',
  'action.done': 'Done',
  'action.search': 'Search',
  'action.import': 'Import Excel',
  'action.export': 'Export',
  'action.back': 'Back',

  // ── States ──
  'state.loading': 'Loading…',
  'state.empty': 'Nothing here yet',
  'state.error': 'Something went wrong',
  'state.offline': "You're offline",
  'state.queued': '{{count}} queued',

  // ── Attendance ──
  'attendance.title': 'Attendance',
  'attendance.markAllPresent': 'All Present',
  'attendance.markAllAbsent': 'All Absent',
  'attendance.reset': 'Reset',
  'attendance.save': 'Save Attendance',
  'attendance.saveOffline': 'Save Offline',
  'attendance.unmarked': '{{count}} unmarked',
  'attendance.present': 'Present',
  'attendance.absent': 'Absent',
  'attendance.late': 'Late',
  'attendance.syncQueued': 'Sync {{count}} queued',
  'attendance.syncing': 'Syncing…',

  // ── Students ──
  'students.title': 'Students',
  'students.register': 'Register Student',
  'students.searchPlaceholder': 'Search by name, admission no…',
  'students.allClasses': 'All Classes',
  'students.importTitle': 'Import students from Excel',
  'students.importHint': 'Upload the admission sheet, preview validation, then commit. Existing admission numbers are updated, not duplicated.',
  'students.selectFile': 'Select file',
  'students.validatePreview': 'Validate & preview',
  'students.totalRows': 'Total rows',
  'students.ready': 'Ready',
  'students.withErrors': 'With errors',
  'students.fixRows': 'Fix these rows in the file, re-upload to re-validate',
  'students.importN': 'Import {{count}} student(s)',
  'students.imported': '{{created}} imported, {{failed}} failed',
  'students.importAnother': 'Import another file',

  // ── Login ──
  'login.title': 'EduCore ERP',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.signIn': 'Sign in',
  'login.invalidCredentials': 'Invalid email or password',

  // ── Import modal (shared bits) ──
  'import.requiredColumns': 'Required columns',
  'import.optionalColumns': 'Optional columns',
  'import.chooseAnother': '← Choose another file',
};
