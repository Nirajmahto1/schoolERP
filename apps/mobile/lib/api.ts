// ──────────────────────────────────────────────
// School ERP Mobile — API Client Layer
// Complete port of the web API client for React Native
// ──────────────────────────────────────────────
import AsyncStorage from '@react-native-async-storage/async-storage';

// In development, use 10.0.2.2 for Android Emulator to connect to localhost
// For iOS simulator, use localhost directly
const API_BASE = 'http://10.0.2.2:4000/api/v1';

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

async function apiRequest<T>(endpoint: string, options: ApiOptions = {}): Promise<T> {
  const { token, ...fetchOptions } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOptions.headers as Record<string, string> || {}),
  };

  // Get token from AsyncStorage if not provided
  const authToken = token || await AsyncStorage.getItem('erp_token');
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  // NOTE: branch/school are intentionally NOT sent as headers. The gateway
  // mints an audience-bound assertion per request; the legacy x-branch-id /
  // x-school-id headers are stripped at the edge and never trusted downstream.

  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;

  const res = await fetch(url, {
    ...fetchOptions,
    headers,
  });

  if (!res.ok) {
    // ── 401 → single-flight refresh → retry once (port of the web client) ──
    // The access token lives 15 minutes; without this every parent session
    // dies mid-payment. Refresh is ROTATING, so concurrent 401s must share
    // ONE refresh round-trip — a second concurrent refresh with the same
    // token fails as "reused" and logs the user out.
    if (res.status === 401 && !token) {
      const ok = await tryRefresh();
      if (ok) {
        const t = await AsyncStorage.getItem('erp_token');
        if (t) return apiRequest<T>(endpoint, { ...options, headers: { ...fetchOptions.headers, Authorization: `Bearer ${t}` } });
      }
    }
    const errorBody = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(res.status, errorBody.detail || errorBody.title || 'Request failed', errorBody.errors);
  }

  if (res.status === 204) return undefined as T;

  return res.json();
}

// Single-flight refresh — see the 401 handler in apiRequest.
let refreshInFlight: Promise<boolean> | null = null;
async function tryRefresh(): Promise<boolean> {
  const refreshToken = await AsyncStorage.getItem('erp_refresh_token');
  if (!refreshToken) return false;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        // Raw fetch on purpose — apiRequest would recurse on 401.
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) return false;
        const body = await res.json();
        await AsyncStorage.setItem('erp_token', body.accessToken);
        if (body.refreshToken) await AsyncStorage.setItem('erp_refresh_token', body.refreshToken);
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

// ── Auth API ──
export const authApi = {
  login: (email: string, password: string) =>
    apiRequest<{ accessToken: string; refreshToken: string; user: any }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  refresh: (refreshToken: string) =>
    apiRequest<{ accessToken: string }>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),
};

// ── Admin API ──
export const adminApi = {
  getDashboard: () => apiRequest<any>('/admin/dashboard'),
};

// ── Staff API ──
export const staffApi = {
  list: (params?: { search?: string; department?: string }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.department) qs.set('department', params.department);
    return apiRequest<{ data: any[]; meta?: any }>(`/staff?${qs}`);
  },

  get: (id: string) => apiRequest<any>(`/staff/${id}`),

  getPayroll: (params?: { month?: number; year?: number }) => {
    const qs = new URLSearchParams();
    if (params?.month) qs.set('month', String(params.month));
    if (params?.year) qs.set('year', String(params.year));
    return apiRequest<{ data: any[] }>(`/staff/payroll?${qs}`);
  },
};

// ── Academics API ──
export const academicApi = {
  getClasses: () => apiRequest<{ data: any[] }>('/academics/classes'),

  getSections: (classId: string) =>
    apiRequest<{ data: any[] }>(`/academics/sections?classId=${classId}`),

  getSubjects: (classId?: string) =>
    apiRequest<{ data: any[] }>(`/academics/subjects${classId ? `?classId=${classId}` : ''}`),

  getExaminations: () => apiRequest<{ data: any[] }>('/academics/examinations'),

  getResults: (examinationId: string) =>
    apiRequest<{ data: any[] }>(`/academics/exam-results/${examinationId}`),
};

// ── Teacher API ──
export const teacherApi = {
  getDashboard: () => apiRequest<any>('/teacher/dashboard'),
  getMyClasses: () => apiRequest<any[]>('/teacher/my-classes'),
  getStudents: (className: string, sectionName: string, search?: string) =>
    apiRequest<{ data: any[] }>(`/teacher/students?className=${encodeURIComponent(className)}&sectionName=${encodeURIComponent(sectionName)}${search ? `&search=${encodeURIComponent(search)}` : ""}`),
  getDailyAttendance: (date: string, className: string, sectionName: string) =>
    apiRequest<{ data: any[] }>(`/teacher/attendance?date=${date}&className=${className}&sectionName=${sectionName}`),
  markAttendance: (payload: any) =>
    apiRequest<{ message: string; count: number }>('/teacher/attendance', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getMarks: (className: string, sectionName: string) =>
    apiRequest<{ data: any[] }>(`/teacher/marks?className=${className}&sectionName=${sectionName}`),
  submitMarks: (payload: any) =>
    apiRequest<{ message: string; count: number }>('/teacher/marks', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getLeaveRequests: () => apiRequest<any[]>('/teacher/leave-requests'),
  createLeaveRequest: (payload: any) =>
    apiRequest<any>('/teacher/leave-requests', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // ── Approvals (HOD / Principal / admins) ──
  getLeaveApprovals: (status?: string) =>
    apiRequest<{ data: any[]; scope: 'department' | 'branch' }>(
      `/teacher/leave-approvals${status ? `?status=${status}` : ''}`,
    ),
  decideLeaveRequest: (id: string, decision: 'APPROVED' | 'REJECTED', note?: string) =>
    apiRequest<{ id: string; status: string }>(`/teacher/leave-requests/${id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
    }),
  getMyTimetable: () => apiRequest<{ days: Array<{ day: string; slots: Array<{ id: string; startTime: string; endTime: string; subject: string; classSection: string; room: string | null }> }> }>('/teacher/timetable'),
  getProfile: () => apiRequest<any>('/teacher/profile'),
  updateProfile: (payload: any) =>
    apiRequest<any>('/teacher/profile', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  getMyLibrary: () => apiRequest<any[]>('/teacher/my-library'),
  getMyAnnouncements: () => apiRequest<any[]>('/teacher/my-announcements'),
};

// ── Fee API ──
export const feeApi = {
  getStructures: () => apiRequest<{ data: any[] }>('/fees/fee-structures'),

  getInvoices: (params?: { studentId?: string; status?: string }) => {
    const qs = new URLSearchParams();
    if (params?.studentId) qs.set('studentId', params.studentId);
    if (params?.status) qs.set('status', params.status);
    return apiRequest<{ data: any[]; meta: any }>(`/fees/invoices?${qs}`);
  },

  recordPayment: (data: { invoiceId: string; amount: number; method: string; transactionId?: string }) =>
    apiRequest<any>('/fees/payments', { method: 'POST', body: JSON.stringify(data) }),

  getDefaulters: () => apiRequest<{ data: any[] }>('/fees/defaulters'),

  getReports: () => apiRequest<any>('/fees/reports'),
};

// ── Students API ──
export const studentApi = {
  list: (params?: { search?: string; classId?: string }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.classId) qs.set('classId', params.classId);
    return apiRequest<{ data: any[]; meta: any }>(`/students?${qs}`);
  },
  getProfile: () => apiRequest<any>('/students/profile'),
  getMyAttendance: () => apiRequest<any>('/students/my-attendance'),
  getMyResults: () => apiRequest<any>('/students/my-results'),
  getMyFees: () => apiRequest<any>('/students/my-fees'),
  getMyTimetable: () => apiRequest<any>('/students/my-timetable'),
  getMyLibrary: () => apiRequest<any>('/students/my-library'),
  getMyAnnouncements: () => apiRequest<any>('/students/my-announcements'),
  getMyTransport: () => apiRequest<any>('/students/my-transport'),
};

// ── Parents API ──
export const parentApi = {
  getMeChildrenSummary: () => apiRequest<any>('/parents/me/children-summary'),
};

// ── Class-room chat (Phase 9) ──
// Room membership is server-derived (own enrollment, or the child's for a
// guardian). Cursor polling: pass `before` = newest seen ISO instant to page
// history; poll without it for the tail.
export interface ChatMessage {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  mine: boolean;
}
export const chatApi = {
  list: (before?: string) =>
    apiRequest<{ data: ChatMessage[]; canPost: boolean }>(
      `/communication/chat/messages${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    ),
  send: (body: string) =>
    apiRequest<{ id: string; createdAt: string }>('/communication/chat/messages', {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
};

// ── Student self-service (parent app child views reuse these when the
// logged-in account IS the student) ──
export const studentSelfApi = {
  getMyFees: () => apiRequest<any[]>('/students/my-fees'),
  getMyAttendance: () => apiRequest<any>('/students/my-attendance'),
  getMyTimetable: () => apiRequest<{ className: string; timetable: Array<{ time: string; mon: string; tue: string; wed: string; thu: string; fri: string }> }>('/students/my-timetable'),
};

// ── Razorpay checkout (Phase 9 / BUILD_PLAN 4.1 client half) ──
// Amounts are computed SERVER-SIDE from open invoices — the client only
// names the student and (optionally) invoices, and later hands back the
// checkout signature for verification. No SDK: Razorpay's RN checkout is a
// WebView around the same order → pay → verify dance this module encodes.
export interface CheckoutOrder {
  paymentId: string;
  orderId: string;
  amount: number;
  currency: string;
  keyId: string | null;
  invoices: Array<{ id: string; invoiceNo: string; dueDate: string; outstanding: number }>;
}

export const checkoutApi = {
  // academicYearId is optional: the server resolves the branch's current
  // year when omitted (the mobile client cannot know the id). The ownership
  // check still applies — caller must be the student, a linked guardian, or
  // branch staff.
  createOrder: (body: { studentId: string; academicYearId?: string; invoiceIds?: string[] }) =>
    apiRequest<CheckoutOrder>('/fees/checkout/orders', { method: 'POST', body: JSON.stringify(body) }),

  verify: (body: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) =>
    apiRequest<{ captured: boolean; reason?: 'AMOUNT_MISMATCH' | 'ALREADY_CAPTURED' | 'NOT_INITIATED'; payment?: { id: string; receiptNo: string | null } }>('/fees/checkout/verify', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ── Communication API ──
export const communicationApi = {
  // Phase 9.3: register this phone's FCM token after login (§5.4 registry).
  registerDevice: (data: { token: string; platform: 'ANDROID' | 'IOS' | 'WEB'; label?: string }) =>
    apiRequest<{ id: string }>('/communication/devices', { method: 'POST', body: JSON.stringify(data) }),
  unregisterDevice: (deviceId: string) =>
    apiRequest<void>(`/communication/devices/${deviceId}`, { method: 'DELETE' }),
  getAnnouncements: () => apiRequest<{ data: any[] }>('/communication/announcements'),

  createAnnouncement: (data: { title: string; content: string; type: string; targetRoles: string[] }) =>
    apiRequest<any>('/communication/announcements', {
      method: 'POST',
      body: JSON.stringify(data),
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

  issueBook: (data: { bookId: string; studentId: string; dueDate: string }) =>
    apiRequest<any>('/library/issue', { method: 'POST', body: JSON.stringify(data) }),

  returnBook: (issueId: string) =>
    apiRequest<any>(`/library/return/${issueId}`, { method: 'POST' }),
};

// ── Transport API ──
export const transportApi = {
  getRoutes: () => apiRequest<{ data: any[] }>('/transport/routes'),
  getVehicles: () => apiRequest<{ data: any[] }>('/transport/vehicles'),
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
  // The retired /go/attendance/burst-mark stub wrote to a legacy table with no
  // branch scope and is incompatible with the session-based schema.
  mark: (data: {
    date: string;
    classId: string;
    sectionId: string;
    records: { studentId: string; status: string; remarks?: string }[];
    markedBy?: string;
  }) =>
    apiRequest<{ count: number; sessionId: string; message: string }>('/attendance/mark', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getSummary: (params: { month: number; year: number; classId?: string }) => {
    const qs = new URLSearchParams({ month: String(params.month), year: String(params.year) });
    if (params.classId) qs.set('classId', params.classId);
    return apiRequest<any>(`/attendance/summary?${qs}`);
  },
};

// ── Analytics API ──
export const analyticsApi = {
  getDashboard: () => apiRequest<any>('/analytics/dashboard'),
  getAttendanceReport: (startDate: string, endDate: string, classId?: string) => {
    const qs = new URLSearchParams({ start_date: startDate, end_date: endDate });
    if (classId) qs.set('class_id', classId);
    return apiRequest<any[]>(`/analytics/attendance?${qs}`);
  },
};

export { apiRequest, ApiError };
