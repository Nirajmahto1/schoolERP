// ──────────────────────────────────────────────
// School ERP — API Client Layer
// Central fetch wrapper for all backend API calls
// ──────────────────────────────────────────────

export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

interface ApiOptions extends RequestInit {
  token?: string;
}

class ApiError extends Error {
  status: number;
  detail: string;
  errors?: Record<string, string[]>;

  constructor(status: number, detail: string, errors?: Record<string, string[]>) {
    super(detail);
    this.status = status;
    this.detail = detail;
    this.errors = errors;
  }
}

// ── Token auto-refresh ──
// The access token lives 15 minutes; the refresh token 30 days. When a call
// comes back 401, try ONE refresh + retry before surfacing the error. The
// single-flight promise keeps a burst of parallel 401s to a single refresh
// round-trip (refresh is ROTATING — a second concurrent refresh with the same
// token would fail as "reused" and log the user out).
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('erp_refresh_token') : null;
  if (!refreshToken) return false;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        // Raw fetch on purpose — apiRequest would attach the expired access
        // token and recurse into this handler.
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return false;
        const pair = await res.json();
        localStorage.setItem('erp_token', pair.accessToken);
        localStorage.setItem('erp_refresh_token', pair.refreshToken);
        window.dispatchEvent(new CustomEvent('erp:token-refreshed', { detail: { accessToken: pair.accessToken } }));
        return true;
      } catch {
        return false;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

async function apiRequest<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
  const { token, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    // FormData sets its own multipart boundary header — a JSON content-type
    // here would corrupt the upload.
    ...(fetchOptions.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    ...(fetchOptions.headers as Record<string, string> || {}),
  };

  // Get token from localStorage if not provided
  const authToken = token || (typeof window !== 'undefined' ? localStorage.getItem('erp_token') : null);
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  // NOTE: branch/school are intentionally NOT sent as headers. The gateway
  // mints an audience-bound assertion per request; the legacy x-branch-id /
  // x-school-id headers are stripped at the edge and never trusted downstream.

  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;

  let res = await fetch(url, {
    ...fetchOptions,
    headers,
  });

  // Expired access token: refresh once, then retry the original request with
  // the new token. Never retry non-GETs blindly? No — the gateway rejected
  // this request before it reached any service logic (401 = auth failure), so
  // a retry cannot double-apply anything.
  if (res.status === 401 && !token && typeof window !== 'undefined'
      && !url.includes('/auth/refresh') && !url.includes('/auth/login')) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await fetch(url, {
        ...fetchOptions,
        headers: { ...headers, Authorization: `Bearer ${localStorage.getItem('erp_token')}` },
      });
    }
  }

  if (!res.ok) {
    // Refresh also dead (or retry failed): the session is truly over. Clear
    // stale credentials so the next navigation lands on the login page.
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('erp_token');
      localStorage.removeItem('erp_refresh_token');
    }
    const errorBody = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(res.status, errorBody.detail || errorBody.title || 'Request failed', errorBody.errors);
  }

  // Handle 204 No Content
  if (res.status === 204) return undefined as T;

  return res.json();
}

// ── Auth API ──
export const authApi = {
  login: (email: string, password: string, totp?: string) => {
    const body: Record<string, string> = { email, password };
    if (totp) body.totp = totp;
    return apiRequest<{
      accessToken: string;
      refreshToken: string;
      user: any;
      mfaRequired?: boolean;
      mfaToken?: string;
    }>('/auth/login', { method: 'POST', body: JSON.stringify(body) });
  },

  /** Identity + permission resolution (identity-service /auth/me, assertion-gated). */
  me: () => apiRequest<{
    id: string;
    email: string;
    branchId: string | null;
    roles: string[];
    permissions: string[];
    assertionPermissions: string[];
    impersonatedBy: string | null;
  }>('/auth/me'),

  verifyMfa: (mfaToken: string, totp: string) =>
    apiRequest<{ accessToken: string; refreshToken: string; user: any }>('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ mfaToken, totp }),
    }),

  // NOTE: /auth/register was removed in Phase 0 — anyone could mint a
  // SUPER_ADMIN. User creation is invite-only and lives behind auth.

  refresh: (refreshToken: string) =>
    apiRequest<{ accessToken: string }>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),

  /** Reissue the session scoped to another branch (owner/assigned admins only). */
  switchBranch: (branchId: string) =>
    apiRequest<{ accessToken: string; refreshToken: string; branchId: string; user?: any }>('/auth/switch-branch', {
      method: 'POST',
      body: JSON.stringify({ branchId }),
    }),

  logout: () =>
    apiRequest<void>('/auth/logout', { method: 'POST' }),
};

// ── Students API ──
// Per-row report from the bulk import endpoint (student-service 3.2).
export interface ImportReport {
  mode: 'dry-run' | 'commit';
  summary: { total: number; valid: number; invalid: number };
  rows: Array<{
    row: number;
    admissionNo?: string;
    ok: boolean;
    errors: Array<{ field?: string; message: string }>;
  }>;
  committed?: Array<{ row: number; admissionNo: string; studentId: string; action: 'created' | 'updated' }>;
  failed?: Array<{ row: number; admissionNo: string; message: string }>;
}

export const studentApi = {
  list: (params?: { search?: string; classId?: string; sectionId?: string; limit?: number; cursor?: string }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.classId) qs.set('classId', params.classId);
    if (params?.sectionId) qs.set('sectionId', params.sectionId);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.cursor) qs.set('cursor', params.cursor);
    return apiRequest<{ data: any[]; meta: any }>(`/students?${qs}`);
  },

  get: (id: string) => apiRequest<any>(`/students/${id}`),

  // Bulk Excel import (Phase 8.5 flagship). Two modes over ONE endpoint so
  // the preview error report is byte-identical to what commit would do:
  //   dry-run → per-row validation report, nothing written
  //   commit  → writes only rows that passed the same validation
  importStudents: async (file: File, mode: 'dry-run' | 'commit') => {
    const b64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    return apiRequest<ImportReport>(`/students/import?mode=${mode}`, {
      method: 'POST',
      body: JSON.stringify({ file: b64 }),
    });
  },

  getDashboard: () => apiRequest<any>('/students/dashboard'),

  getProfile: () => apiRequest<any>('/students/profile'),

  getMyClasses: () => apiRequest<any>('/students/my-classes'),

  getMyAttendance: () => apiRequest<any>('/students/my-attendance'),

  getMyResults: () => apiRequest<any>('/students/my-results'),

  getMyFees: () => apiRequest<any>('/students/my-fees'),

  getMyTimetable: () => apiRequest<any>('/students/my-timetable'),

  getMyLibrary: () => apiRequest<any>('/students/my-library'),

  getMyAnnouncements: () => apiRequest<any>('/students/my-announcements'),

  getMyTransport: () => apiRequest<any>('/students/my-transport'),

  updateProfile: (data: { firstName: string; lastName: string; phone?: string }) =>
    apiRequest<any>('/students/profile', { method: 'PUT', body: JSON.stringify(data) }),

  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    apiRequest<any>('/students/change-password', { method: 'POST', body: JSON.stringify(data) }),

  create: (data: any) =>
    apiRequest<any>('/students', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: any) =>
    apiRequest<any>(`/students/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  delete: (id: string) =>
    apiRequest<void>(`/students/${id}`, { method: 'DELETE' }),
};

// ── Parents API ──
export const parentApi = {
  list: (search?: string) => {
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    return apiRequest<{ data: any[] }>(`/parents?${qs}`);
  },
  update: (id: string, data: any) =>
    apiRequest<any>(`/parents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  getMeChildrenSummary: () =>
    apiRequest<any>('/parents/me/children-summary'),
};

// ── Staff API ──
export const staffApi = {
  // Staff-service /staff list: no search/department filters server-side (the
  // list returns the branch's active staff); filtering happens client-side.
  list: () =>
    apiRequest<{ data: any[] }>(`/staff`),

  get: (id: string) => apiRequest<any>(`/staff/${id}`),

  create: (data: any) =>
    apiRequest<any>('/staff', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: any) =>
    apiRequest<any>(`/staff/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  delete: (id: string) =>
    apiRequest<void>(`/staff/${id}`, { method: 'DELETE' }),

  getPayroll: (params?: { month?: number; year?: number }) => {
    const qs = new URLSearchParams();
    if (params?.month) qs.set('month', String(params.month));
    if (params?.year) qs.set('year', String(params.year));
    return apiRequest<{ data: any[] }>(`/staff/payroll?${qs}`);
  },

  generatePayroll: (data: { month: number; year: number; branchId: string }) =>
    apiRequest<any>('/staff/payroll/generate', { method: 'POST', body: JSON.stringify(data) }),
};

// ── HR API (staff-service /hr — Phase 3.7 records, leaves, payroll) ──
export const hrApi = {
  list: (params?: { q?: string; department?: string }) => {
    const qs = new URLSearchParams();
    if (params?.q) qs.set('q', params.q);
    if (params?.department) qs.set('department', params.department);
    return apiRequest<{ data: any[] }>(`/hr?${qs}`);
  },

  /** Full HR profile: staff row + branch assignments + leave + payroll. */
  get: (id: string) => apiRequest<{ data: any }>(`/hr/${id}`),

  /** List identity documents (Aadhaar etc.) on file for a staff member. */
  documents: (id: string) => apiRequest<{ data: any[] }>(`/hr/${id}/documents`),

  /**
   * Upload an identity document (multipart). `file` is a File from the
   * staff form's <input type="file">; type is the DocumentType enum value.
   */
  uploadDocument: (id: string, file: File, type: string) => {
    const form = new FormData();
    form.append('file', file);
    form.append('type', type);
    return apiRequest<any>(`/hr/${id}/documents`, { method: 'POST', body: form });
  },

  create: (data: {
    employeeId: string;
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    gender: string;
    designation: string;
    department: string;
    password?: string;
    qualification?: string;
    experience?: number;
    joinDate: string;
    salary: number;
    address: string;
    phone: string;
    email?: string;
    /** Academic leadership ticks — extra role assignments on the account. */
    isHod?: boolean;
    isAcademicHead?: boolean;
  }) => apiRequest<any>('/hr', { method: 'POST', body: JSON.stringify(data) }),

  getLeaves: () => apiRequest<{ data: any[] }>('/hr/leaves'),

  decideLeave: (id: string, status: 'APPROVED' | 'REJECTED' | 'CANCELLED') =>
    apiRequest<any>(`/hr/leaves/${id}/decision`, { method: 'POST', body: JSON.stringify({ status }) }),

  /** Idempotent per (staff, month, year) — re-running corrects nothing, duplicates nothing. */
  runPayroll: (data: { month: number; year: number; allowances?: number; deductions?: number }) =>
    apiRequest<{ month: number; year: number; staffCount: number; totalNet: number; processed: any[] }>(
      '/hr/payroll/run', { method: 'POST', body: JSON.stringify(data) },
    ),

  getPayroll: (params?: { month?: number; year?: number }) => {
    const qs = new URLSearchParams();
    if (params?.month) qs.set('month', String(params.month));
    if (params?.year) qs.set('year', String(params.year));
    return apiRequest<{ data: any[] }>(`/hr/payroll?${qs}`);
  },

  markPaid: (id: string) => apiRequest<any>(`/hr/payroll/${id}/pay`, { method: 'POST' }),
};

// ── Exams API (exam-service — entry → verify → publish workflow) ──
export const examApi = {
  list: () => apiRequest<{ data: any[] }>('/exams/examinations'),

  create: (data: {
    name: string;
    academicYearId: string;
    startDate: string;
    endDate: string;
    subjects: Array<{ subjectId: string; examDate: string; startTime: string; endTime: string; maxMarks: number; passingMarks: number }>;
  }) => apiRequest<any>('/exams/examinations', { method: 'POST', body: JSON.stringify(data) }),

  /** Workflow transitions: ENTRY→SUBMITTED→VERIFIED→PUBLISHED. */
  setStatus: (id: string, status: 'SUBMITTED' | 'VERIFIED' | 'PUBLISHED') =>
    apiRequest<any>(`/exams/examinations/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),

  enterMarks: (data: {
    examSubjectId: string;
    marks: Array<{ studentId: string; marksObtained?: number | null; isAbsent?: boolean; isExempt?: boolean; remarks?: string }>;
  }) => apiRequest<any>('/exams/marks', { method: 'POST', body: JSON.stringify(data) }),

  /** Only available once the exam is PUBLISHED. */
  getReportCard: (examinationId: string, studentId: string) =>
    apiRequest<{ data: {
      examination: { id: string; name: string; publishedAt: string };
      student: { id: string; name: string; admissionNo: string; class: string; section: string };
      subjects: Array<{ subject: string; code: string; maxMarks: number; marksObtained: number | null; percent: number | null; grade: string | null; isAbsent: boolean; isExempt: boolean }>;
      total: { marks: number; maxMarks: number; percent: number; grade: string };
    } }>(`/exams/report-card/${examinationId}/${studentId}`),
};

// ── Attendance API ──
export const attendanceApi = {
  getDaily: (params: { date: string; classId?: string; sectionId?: string }) => {
    const qs = new URLSearchParams({ date: params.date });
    if (params.classId) qs.set('classId', params.classId);
    if (params.sectionId) qs.set('sectionId', params.sectionId);
    return apiRequest<{ data: any[]; summary: any }>(`/attendance/daily?${qs}`);
  },

  // Attendance-service daily marking (session + upsert records + summary rebuild).
  // The old /go/attendance/burst-mark stub wrote to a legacy table with no
  // branch scope and is incompatible with the session-based schema.
  mark: (data: {
    date: string;
    classId: string;
    sectionId: string;
    records: { studentId: string; status: string; remarks?: string }[];
    markedBy?: string;
  }) => apiRequest<{ count: number; sessionId: string; message: string }>('/attendance/mark', {
    method: 'POST',
    body: JSON.stringify(data)
  }),

  getStudentHistory: (studentId: string, params?: { startDate?: string; endDate?: string }) => {
    const qs = new URLSearchParams();
    if (params?.startDate) qs.set('startDate', params.startDate);
    if (params?.endDate) qs.set('endDate', params.endDate);
    return apiRequest<{ data: any[]; stats: any }>(`/attendance/student/${studentId}?${qs}`);
  },

  getSummary: (params: { month: number; year: number; classId?: string }) => {
    const qs = new URLSearchParams({ month: String(params.month), year: String(params.year) });
    if (params.classId) qs.set('classId', params.classId);
    return apiRequest<any>(`/attendance/summary?${qs}`);
  },
};

export const teacherApi = {
  getMyClasses: () => apiRequest<any[]>('/teacher/my-classes'),
  getStudents: (className: string, sectionName: string) => apiRequest<{ data: any[] }>(`/teacher/students?className=${className}&sectionName=${sectionName}`),
  getDailyAttendance: (date: string, className: string, sectionName: string) => apiRequest<{ data: any[] }>(`/teacher/attendance?date=${date}&className=${className}&sectionName=${sectionName}`),
  markAttendance: (payload: any) => apiRequest<{ message: string; count: number }>('/teacher/attendance', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  getMarks: (className: string, sectionName: string) => apiRequest<{ data: any[] }>(`/teacher/marks?className=${className}&sectionName=${sectionName}`),
  submitMarks: (payload: any) => apiRequest<{ message: string; count: number }>('/teacher/marks', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  getLeaveRequests: () => apiRequest<any[]>('/teacher/leave-requests'),
  createLeaveRequest: (payload: any) => apiRequest<any>('/teacher/leave-requests', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  getMyLibrary: () => apiRequest<any[]>('/teacher/my-library'),
  getMyAnnouncements: () => apiRequest<any[]>('/teacher/my-announcements'),
  getMyTransport: () => apiRequest<any[]>('/teacher/my-transport'),
  getProfile: () => apiRequest<any>('/teacher/profile'),
  updateProfile: (payload: any) => apiRequest<any>('/teacher/profile', {
    method: 'PUT',
    body: JSON.stringify(payload)
  }),
  changePassword: (payload: any) => apiRequest<any>('/teacher/change-password', {
    method: 'POST',
    body: JSON.stringify(payload)
  }),
  getMyTimetable: () => apiRequest<{ className: string; timetable: any[] }>('/teacher/timetable'),
  getDashboard: () => apiRequest<any>('/teacher/dashboard'),
};

// ── Fee API ──
export const feeApi = {
  getStructures: () =>
    apiRequest<{ data: any[] }>('/fees/fee-structures'),

  createStructure: (data: any) =>
    apiRequest<any>('/fees/fee-structures', { method: 'POST', body: JSON.stringify(data) }),

  getInvoices: (params?: { studentId?: string; status?: string; limit?: number; cursor?: string }) => {
    const qs = new URLSearchParams();
    if (params?.studentId) qs.set('studentId', params.studentId);
    if (params?.status) qs.set('status', params.status);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.cursor) qs.set('cursor', params.cursor);
    return apiRequest<{ data: any[]; meta: any }>(`/fees/invoices?${qs}`);
  },

  createInvoice: (data: {
    studentId: string;
    academicYearId: string;
    /** One line per fee head: { feeHeadId, amount, discount?, description? } */
    lines: Array<{ feeHeadId: string; amount: number; discount?: number; description?: string }>;
    dueDate: string;
    periodStart?: string;
    periodEnd?: string;
  }) =>
    apiRequest<any>('/fees/invoices', { method: 'POST', body: JSON.stringify(data) }),

  recordPayment: (data: { studentId: string; academicYearId: string; amount: number; method: string; invoiceIds?: string[]; idempotencyKey?: string }) =>
    apiRequest<any>('/fees/payments', { method: 'POST', body: JSON.stringify(data) }),

  getDefaulters: () =>
    apiRequest<{ data: any[] }>('/fees/defaulters'),

  getReports: () =>
    apiRequest<any>('/fees/reports'),

  // ── Razorpay checkout (BUILD_PLAN 4.1) ──
  createCheckoutOrder: (data: { studentId: string; academicYearId: string; invoiceIds?: string[] }) =>
    apiRequest<{ paymentId: string; orderId: string; amount: number; currency: string; keyId: string | null; invoices: Array<{ id: string; invoiceNo: string; dueDate: string; outstanding: number }> }>(
      '/fees/checkout/orders',
      { method: 'POST', body: JSON.stringify(data) },
    ),

  verifyCheckout: (data: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) =>
    apiRequest<{ captured: boolean; reason?: string; payment?: { id: string; receiptNo: string | null } }>(
      '/fees/checkout/verify',
      { method: 'POST', body: JSON.stringify(data) },
    ),

  runReconcile: () =>
    apiRequest<{ checked: number; captured: Array<{ paymentId: string; gatewayPaymentId: string }>; mismatches: unknown[] }>(
      '/fees/reconcile/run',
      { method: 'POST' },
    ),

  // ── Receipts (BUILD_PLAN 4.1.4) ──
  /** Latest receipt for an invoice (payments are linked by allocations). */
  getInvoiceReceipt: (invoiceId: string) =>
    apiRequest<{ data: Array<{ id: string; receiptNo: string | null; paidAt: string | null; status: string }>; }>(
      `/fees/payments?invoiceId=${invoiceId}&status=SUCCESS&limit=1`,
    ),

  sendReceipt: (paymentId: string, channels?: string[]) =>
    apiRequest<{ queued: number; channels: string[]; guardians: number }>(
      `/fees/payments/${paymentId}/receipt/send`,
      { method: 'POST', body: JSON.stringify(channels ? { channels } : {}) },
    ),
};

// ── Academic Years ──
export const yearApi = {
  list: () => apiRequest<{ data: any[] }>('/academics/academic-years'),
};

// ── Timetable API ──
export const timetableApi = {
  get: (sectionId: string) =>
    apiRequest<{ data: any[] }>(`/academics/timetable?sectionId=${encodeURIComponent(sectionId)}`),

  // Every section's slots in the branch — powers the live "teacher is busy
  // elsewhere" grey-out across the whole school, not just this section.
  getAll: () =>
    apiRequest<{ data: any[] }>('/academics/timetable?all=1'),

  createSlot: (data: { sectionId: string; subjectId: string; staffId?: string; day: string; startTime: string; endTime: string; room?: string }) =>
    apiRequest<any>('/academics/timetable/slots', { method: 'POST', body: JSON.stringify(data) }),

  deleteSlot: (id: string) =>
    apiRequest<void>(`/academics/timetable/slots/${id}`, { method: 'DELETE' }),

  // Full-branch generation via the Go constraint solver. periods ≤ 8; the
  // default grid already puts lunch after period 4 (45-min periods, 30-min
  // break). keepSectionIds freezes sections the user locked in the UI.
  generate: (data: {
    periods?: number;
    periodTimes?: Array<{ start: string; end: string }>;
    subjectPeriods?: Record<string, number>;
    keepSectionIds?: string[];
    seed?: number;
  }) =>
    apiRequest<{
      status: 'solved' | 'infeasible';
      persisted: number;
      skipped: Array<{ sectionId: string; subjectId: string; reason: string }>;
      stats: { attempts: number; nodesExplored: number; elapsedMs: number; placements: number };
      violations: Array<{ rule: string; detail: string }> | null;
    }>('/academics/timetable/generate', { method: 'POST', body: JSON.stringify(data), timeout: 60_000 } as never),
};

// ── Communication API ──
export const communicationApi = {
  getAnnouncements: () =>
    apiRequest<{ data: any[] }>('/communication/announcements', { method: 'GET' }),

  getDispatchLogs: () =>
    apiRequest<{ data: any[] }>('/communication/dispatch-logs'),

  dispatch: (data: { title?: string; content: string; channel?: string; targetRoles?: string[]; classIds?: string[]; sectionIds?: string[] }) =>
    apiRequest<{ announcementId: string; queued: number; audience: { guardians: number; staff: number } }>('/communication/dispatch', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  createAnnouncement: (data: { title: string; content: string; type: string; targetRoles: string[] }) =>
    apiRequest<any>('/communication/announcements', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteAnnouncement: (id: string) =>
    apiRequest<void>(`/communication/announcements/${id}`, { method: 'DELETE' }),
};

// ── Academics API ──
export const academicApi = {
  getClasses: () =>
    apiRequest<{ data: any[] }>('/academics/classes'),

  createClass: (data: any) =>
    apiRequest<any>('/academics/classes', { method: 'POST', body: JSON.stringify(data) }),

  updateClass: (id: string, data: { name?: string; numericOrder?: number }) =>
    apiRequest<any>(`/academics/classes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteClass: (id: string) =>
    apiRequest<void>(`/academics/classes/${id}`, { method: 'DELETE' }),

  getSections: (classId: string) =>
    apiRequest<{ data: any[] }>(`/academics/sections?classId=${classId}`),

  createSection: (data: any) =>
    apiRequest<any>('/academics/sections', { method: 'POST', body: JSON.stringify(data) }),

  updateSection: (id: string, data: { name?: string; capacity?: number }) =>
    apiRequest<any>(`/academics/sections/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),

  deleteSection: (id: string) =>
    apiRequest<void>(`/academics/sections/${id}`, { method: 'DELETE' }),

  getSubjects: (classId?: string) =>
    apiRequest<{ data: any[] }>(`/academics/subjects${classId ? `?classId=${classId}` : ''}`),

  createSubject: (data: any) =>
    apiRequest<any>('/academics/subjects', { method: 'POST', body: JSON.stringify(data) }),

  deleteSubject: (id: string) =>
    apiRequest<void>(`/academics/subjects/${id}`, { method: 'DELETE' }),

  assignTeacher: (data: { subjectId: string; staffId: string }) =>
    apiRequest<any>('/academics/subject-teachers', { method: 'POST', body: JSON.stringify(data) }),

  removeTeacher: (id: string) =>
    apiRequest<void>(`/academics/subject-teachers/${id}`, { method: 'DELETE' }),

  getExaminations: () =>
    apiRequest<{ data: any[] }>('/academics/examinations'),

  createExamination: (data: any) =>
    apiRequest<any>('/academics/examinations', { method: 'POST', body: JSON.stringify(data) }),

  deleteExamination: (id: string) =>
    apiRequest<void>(`/academics/examinations/${id}`, { method: 'DELETE' }),

  getResults: (examinationId: string) =>
    apiRequest<{ data: any[] }>(`/academics/exam-results/${examinationId}`),

  submitResults: (examSubjectId: string, results: { studentId: string; marks: number; remarks?: string }[]) =>
    apiRequest<any>(`/academics/exam-results`, {
      method: 'POST',
      body: JSON.stringify({ results: results.map(r => ({ ...r, examSubjectId })) }),
    }),
};

// ── Library API ──
export const libraryApi = {
  getBooks: (params?: { search?: string; category?: string }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.category) qs.set('category', params.category);
    return apiRequest<{ data: any[] }>(`/library/books?${qs}`);
  },

  issueBook: (data: { bookId: string; studentId: string; staffId?: string; dueDate: string }) =>
    apiRequest<any>('/library/issue', { method: 'POST', body: JSON.stringify(data) }),

  getIssues: () =>
    apiRequest<{ data: any[] }>('/library/issues'),

  returnBook: (issueId: string) =>
    apiRequest<any>(`/library/return/${issueId}`, { method: 'POST' }),
};

// ── Transport API ──
export const transportApi = {
  getRoutes: () =>
    apiRequest<{ data: any[] }>('/transport/routes'),

  getVehicles: () =>
    apiRequest<{ data: any[] }>('/transport/vehicles'),
};

// ── AI Service (proxied through API gateway with JWT) ──
export const aiApi = {
  generateTimetable: (data: { classId: string; sectionId: string; teachers: any[]; subjects: any[] }) =>
    apiRequest<any>('/ai/timetable/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getStudentPerformance: (studentId: string) =>
    apiRequest<any>(`/ai/analytics/student-performance/${studentId}`),
};

// ── Analytics service (FastAPI, Phase 7.1 — real DB-backed dashboards) ──
export const analyticsApi = {
  getDashboard: () => apiRequest<any>('/analytics/dashboard'),

  /** Daily present/absent/late + rate for the trailing N days. */
  getAttendanceTrend: (days = 30) =>
    apiRequest<any[]>(`/analytics/attendance?days=${days}`),

  /** Ranked list with reasons — never a black-box score. */
  getAtRisk: (limit = 50, branchId?: string) =>
    apiRequest<any[]>(`/analytics/at-risk?limit=${limit}${branchId ? `&branchId=${branchId}` : ''}`),

  /** Invoiced → collected → pending by invoice status. */
  getFeeFunnel: (academicYearId?: string) =>
    apiRequest<any>(`/analytics/fees${academicYearId ? `?academicYearId=${academicYearId}` : ''}`),

  /** Grade-band distribution per subject over published results. */
  getPerformance: () => apiRequest<any[]>('/analytics/performance'),

  /** Periods/week per teacher from the live timetable. */
  getTeacherWorkload: () => apiRequest<any[]>('/analytics/teacher-workload'),

  /** All branches of the caller's school side by side (management view). */
  getBranchComparison: () => apiRequest<any[]>('/analytics/branch-comparison'),

  /** Excel export — the service sets the attachment filename. */
  exportAtRiskXlsx: () => '/analytics/export/at-risk.xlsx',
  exportBranchComparisonXlsx: () => '/analytics/export/branch-comparison.xlsx',
};

export const adminApi = {
  getDashboard: () => apiRequest<any>('/admin/dashboard'),
};

// ── First-run setup + branch management (provision-service) ──
export const setupApi = {
  /** Has the first-run wizard been completed? Drives the page redirect. */
  status: () => apiRequest<{ provisioned: boolean }>('/setup/status'),
  /** School profile for the dashboard chrome (sidebar/topbar branding). */
  profile: () => apiRequest<{ name: string; code: string; logoUrl: string | null }>('/setup/school'),
  /**
   * One-shot bootstrap: school + first branch + owner account. `logo` is a
   * File from the wizard's <input type="file"> — sent as multipart/form-data
   * so the binary reaches provision-service untouched (no base64 bloat).
   */
  complete: (body: {
    schoolName: string;
    schoolCode: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
    phone?: string;
    email?: string;
    branchName?: string;
    branchCode?: string;
    adminEmail: string;
    adminPassword: string;
    logo?: File | null;
  }) => {
    const { logo, ...fields } = body;
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && value !== '') form.append(key, String(value));
    }
    if (logo) form.append('logo', logo);
    return apiRequest<{ ok: boolean; schoolId: string; branchId: string; adminUserId: string; logoUrl: string | null }>('/setup', {
      method: 'POST',
      body: form,
    });
  },
};

export const branchApi = {
  list: () => apiRequest<any[]>('/branches'),
  add: (body: { name: string; code: string; address?: string; phone?: string; email?: string; minLatitude?: number; maxLatitude?: number; minLongitude?: number; maxLongitude?: number; lateAfterMinutes?: number }) =>
    apiRequest<{ ok: boolean; branchId: string }>('/branches', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: { name?: string; address?: string; phone?: string; email?: string; isActive?: boolean; minLatitude?: number | null; maxLatitude?: number | null; minLongitude?: number | null; maxLongitude?: number | null; lateAfterMinutes?: number | null }) =>
    apiRequest<{ ok: boolean }>(`/branches/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  admins: (id: string) =>
    apiRequest<BranchAdmin[]>(`/branches/${id}/admins`),
  assignAdmin: (
    id: string,
    body: { userId?: string; email?: string; password?: string; firstName?: string; lastName?: string; phone?: string; roleCode?: 'BRANCH_ADMIN' | 'PRINCIPAL' },
  ) =>
    apiRequest<{ ok: boolean; userId: string; email: string; name: string | null; created: boolean }>(
      `/branches/${id}/admins`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  removeAdmin: (id: string, userId: string) =>
    apiRequest<{ ok: boolean; removed: number }>(`/branches/${id}/admins/${userId}`, { method: 'DELETE' }),
};

export interface BranchAdmin {
  assignmentId: string;
  userId: string;
  email: string;
  name: string | null;
  phone: string | null;
  roleCode: string;
  isActive: boolean;
  lastLogin: string | null;
}

// Export the base request function for custom endpoints
export { apiRequest, ApiError };


