// ──────────────────────────────────────────────
// School ERP — API Client Layer
// Central fetch wrapper for all backend API calls
// ──────────────────────────────────────────────

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1';

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

  // Get token from localStorage if not provided
  const authToken = token || (typeof window !== 'undefined' ? localStorage.getItem('erp_token') : null);
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  // Add branch & school headers from stored user
  if (typeof window !== 'undefined') {
    const userData = localStorage.getItem('erp_user');
    if (userData) {
      try {
        const user = JSON.parse(userData);
        if (user.branchId) headers['x-branch-id'] = user.branchId;
        if (user.schoolId) headers['x-school-id'] = user.schoolId;
      } catch { /* ignore */ }
    }
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

  // Handle 204 No Content
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

  register: (data: { email: string; password: string; role: string; branchId: string; schoolId: string }) =>
    apiRequest<{ id: string; email: string; role: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  refresh: (refreshToken: string) =>
    apiRequest<{ accessToken: string }>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),
};

// ── Students API ──
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
  list: (params?: { search?: string; department?: string }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.department) qs.set('department', params.department);
    return apiRequest<{ data: any[]; meta?: any }>(`/staff?${qs}`);
  },

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

// ── Attendance API ──
export const attendanceApi = {
  getDaily: (params: { date: string; classId?: string; sectionId?: string }) => {
    const qs = new URLSearchParams({ date: params.date });
    if (params.classId) qs.set('classId', params.classId);
    if (params.sectionId) qs.set('sectionId', params.sectionId);
    return apiRequest<{ data: any[]; summary: any }>(`/attendance/daily?${qs}`);
  },

  // Routed to Go Service for high-throughput 8 AM burst handling + parent notifications
  mark: (data: { date: string; records: { studentId: string; status: string; remarks?: string }[]; markedBy: string }) =>
    apiRequest<any>('/go/attendance/burst-mark', {
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

  createInvoice: (data: { studentId: string; items: any[]; dueDate: string }) =>
    apiRequest<any>('/fees/invoices', { method: 'POST', body: JSON.stringify(data) }),

  recordPayment: (data: { invoiceId: string; amount: number; method: string; transactionId?: string }) =>
    apiRequest<any>('/fees/payments', { method: 'POST', body: JSON.stringify(data) }),

  getDefaulters: () =>
    apiRequest<{ data: any[] }>('/fees/defaulters'),

  getReports: () =>
    apiRequest<any>('/fees/reports'),
};

// ── Communication API ──
export const communicationApi = {
  getAnnouncements: () =>
    apiRequest<{ data: any[] }>('/communication/announcements'),

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

  deleteClass: (id: string) =>
    apiRequest<void>(`/academics/classes/${id}`, { method: 'DELETE' }),

  getSections: (classId: string) =>
    apiRequest<{ data: any[] }>(`/academics/sections?classId=${classId}`),

  createSection: (data: any) =>
    apiRequest<any>('/academics/sections', { method: 'POST', body: JSON.stringify(data) }),

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

// ── Analytics (FastAPI, gateway-injected user headers) ──
export const analyticsApi = {
  getDashboard: () => apiRequest<any>('/analytics/dashboard'),
  getAttendanceReport: (startDate: string, endDate: string, classId?: string) => {
    const qs = new URLSearchParams({ start_date: startDate, end_date: endDate });
    if (classId) qs.set('class_id', classId);
    return apiRequest<any[]>(`/analytics/attendance?${qs}`);
  },
};

export const adminApi = {
  getDashboard: () => apiRequest<any>('/admin/dashboard'),
};

// Export the base request function for custom endpoints
export { apiRequest, ApiError };


