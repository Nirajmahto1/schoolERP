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

  // Add branch & school headers from stored user
  const userData = await AsyncStorage.getItem('erp_user');
  if (userData) {
    try {
      const user = JSON.parse(userData);
      if (user.branchId) headers['x-branch-id'] = user.branchId;
      if (user.schoolId) headers['x-school-id'] = user.schoolId;
    } catch { /* ignore */ }
  }

  const url = endpoint.startsWith('http') ? endpoint : `${API_BASE}${endpoint}`;

  const res = await fetch(url, {
    ...fetchOptions,
    headers,
  });

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ detail: res.statusText }));
    throw new ApiError(res.status, errorBody.detail || errorBody.title || 'Request failed', errorBody.errors);
  }

  if (res.status === 204) return undefined as T;

  return res.json();
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
  getStudents: (className: string, sectionName: string) =>
    apiRequest<{ data: any[] }>(`/teacher/students?className=${className}&sectionName=${sectionName}`),
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
  getMyTimetable: () => apiRequest<{ className: string; timetable: any[] }>('/teacher/timetable'),
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

// ── Communication API ──
export const communicationApi = {
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

  mark: (data: { date: string; records: { studentId: string; status: string; remarks?: string }[]; markedBy: string }) =>
    apiRequest<any>('/go/attendance/burst-mark', {
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
