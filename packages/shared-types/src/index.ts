// ──────────────────────────────────────────────
// School ERP — Shared Type Definitions
// ──────────────────────────────────────────────

// ── Enums ──

export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  BRANCH_ADMIN = 'BRANCH_ADMIN',
  PRINCIPAL = 'PRINCIPAL',
  TEACHER = 'TEACHER',
  STUDENT = 'STUDENT',
  PARENT = 'PARENT',
  ACCOUNTANT = 'ACCOUNTANT',
  LIBRARIAN = 'LIBRARIAN',
  TRANSPORT_MANAGER = 'TRANSPORT_MANAGER',
  FINANCE = 'FINANCE',
}

export enum Gender {
  MALE = 'MALE',
  FEMALE = 'FEMALE',
  OTHER = 'OTHER',
}

export enum AttendanceStatus {
  PRESENT = 'PRESENT',
  ABSENT = 'ABSENT',
  LATE = 'LATE',
  HALF_DAY = 'HALF_DAY',
  ON_LEAVE = 'ON_LEAVE',
}

export enum FeeStatus {
  PENDING = 'PENDING',
  PARTIAL = 'PARTIAL',
  PAID = 'PAID',
  OVERDUE = 'OVERDUE',
  WAIVED = 'WAIVED',
}

export enum LeaveStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

// ── Common Interfaces ──

export interface PaginationParams {
  cursor?: string;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    total: number;
    limit: number;
    cursor: string | null;
    hasMore: boolean;
  };
}

export interface ApiErrorResponse {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  errors?: Record<string, string[]>;
}

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  branchId: string;
  schoolId: string;
  iat?: number;
  exp?: number;
}

// ── Entity Interfaces ──

export interface ISchool {
  id: string;
  name: string;
  code: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  website?: string;
  logo?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBranch {
  id: string;
  schoolId: string;
  name: string;
  code: string;
  address: string;
  phone: string;
  email: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IUser {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  branchId: string;
  schoolId: string;
  lastLogin?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IStudent {
  id: string;
  userId: string;
  admissionNo: string;
  rollNo?: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  gender: Gender;
  bloodGroup?: string;
  classId: string;
  sectionId: string;
  parentId: string;
  address: string;
  phone?: string;
  photo?: string;
  previousSchool?: string;
  admissionDate: Date;
  isActive: boolean;
  branchId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IStaff {
  id: string;
  userId: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date;
  gender: Gender;
  designation: string;
  department: string;
  qualification: string;
  experience: number;
  joinDate: Date;
  salary: number;
  address: string;
  phone: string;
  photo?: string;
  isActive: boolean;
  branchId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IAttendance {
  id: string;
  date: Date;
  status: AttendanceStatus;
  studentId?: string;
  staffId?: string;
  remarks?: string;
  markedBy: string;
  branchId: string;
  createdAt: Date;
}

export interface IFeeInvoice {
  id: string;
  invoiceNo: string;
  studentId: string;
  amount: number;
  dueDate: Date;
  paidAmount: number;
  status: FeeStatus;
  items: IFeeItem[];
  branchId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IFeeItem {
  id: string;
  invoiceId: string;
  feeTypeId: string;
  amount: number;
  discount: number;
}
