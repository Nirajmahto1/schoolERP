'use client';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { authApi } from '@/lib/api';

export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'PRINCIPAL' | 'TEACHER' | 'STUDENT' | 'PARENT' | 'FINANCE';

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  avatar?: string;
  branchId?: string;
  schoolId?: string;
  classId?: string;
  sectionId?: string;
  childStudentIds?: string[];
  teachingSubjects?: string[];
  assignedClasses?: string[];
  department?: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  error: string | null;
}

// Map backend roles to frontend roles
function mapRole(backendRole: string): UserRole {
  const roleMap: Record<string, UserRole> = {
    SUPER_ADMIN: 'SUPER_ADMIN',
    BRANCH_ADMIN: 'ADMIN',
    PRINCIPAL: 'PRINCIPAL',
    TEACHER: 'TEACHER',
    STUDENT: 'STUDENT',
    PARENT: 'PARENT',
    ACCOUNTANT: 'FINANCE',
    FINANCE: 'FINANCE',
  };
  return roleMap[backendRole] || 'STUDENT';
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Restore session from localStorage on mount
  useEffect(() => {
    const storedUser = localStorage.getItem('erp_user');
    const storedToken = localStorage.getItem('erp_token');
    if (storedUser && storedToken) {
      try {
        setUser(JSON.parse(storedUser));
      } catch { /* ignore corrupt data */ }
    }
    setLoading(false);
  }, []);

  const login = async (email: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await authApi.login(email, password);

      const mappedRole = mapRole(result.user.role);
      const apiUser: User = {
        id: result.user.id,
        name: result.user.email.split('@')[0].replace('.', ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        email: result.user.email,
        role: mappedRole,
        branchId: result.user.branchId,
        schoolId: result.user.schoolId ?? undefined,
      };

      // Store tokens
      localStorage.setItem('erp_token', result.accessToken);
      localStorage.setItem('erp_refresh_token', result.refreshToken);
      localStorage.setItem('erp_user', JSON.stringify(apiUser));

      setUser(apiUser);
    } catch (err: any) {
      const message = err?.detail || err?.message || 'Login failed. Please check your credentials and ensure the server is running.';
      setError(message);
      throw new Error(message);
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    localStorage.removeItem('erp_token');
    localStorage.removeItem('erp_refresh_token');
    localStorage.removeItem('erp_user');
    setUser(null);
    setError(null);
  };

  return <AuthContext.Provider value={{ user, loading, login, logout, error }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

export function hasPermission(role: UserRole, permission: string): boolean {
  const permissions: Record<string, UserRole[]> = {
    'manage:school':     ['SUPER_ADMIN'],
    'manage:branches':   ['SUPER_ADMIN'],
    'manage:settings':   ['SUPER_ADMIN', 'ADMIN'],
    'manage:roles':      ['SUPER_ADMIN', 'ADMIN'],
    'manage:students':   ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL'],
    'manage:staff':      ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL'],
    'view:students':     ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'TEACHER'],
    'view:staff':        ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL'],
    'manage:academics':  ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL'],
    'view:academics':    ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT', 'PARENT'],
    'manage:exams':      ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL'],
    'enter:marks':       ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'TEACHER'],
    'view:results':      ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT', 'PARENT'],
    'mark:attendance':   ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'TEACHER'],
    'view:attendance':   ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT', 'PARENT'],
    'manage:fees':       ['SUPER_ADMIN', 'ADMIN', 'FINANCE'],
    'collect:fees':      ['SUPER_ADMIN', 'ADMIN', 'FINANCE'],
    'view:fees':         ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'FINANCE', 'STUDENT', 'PARENT'],
    'pay:fees':          ['STUDENT', 'PARENT'],
    'manage:expenses':   ['SUPER_ADMIN', 'ADMIN', 'FINANCE'],
    'manage:payroll':    ['SUPER_ADMIN', 'ADMIN', 'FINANCE'],
    'view:financial_reports': ['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'PRINCIPAL'],
    'manage:invoices':   ['SUPER_ADMIN', 'ADMIN', 'FINANCE'],
    'manage:budgets':    ['SUPER_ADMIN', 'ADMIN', 'FINANCE'],
    'send:announcements':['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'TEACHER'],
    'view:announcements':['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT', 'PARENT', 'FINANCE'],
    'send:messages':     ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'TEACHER', 'PARENT'],
    'manage:library':    ['SUPER_ADMIN', 'ADMIN'],
    'view:library':      ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT'],
    'borrow:books':      ['TEACHER', 'STUDENT'],
    'manage:transport':  ['SUPER_ADMIN', 'ADMIN'],
    'view:transport':    ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'STUDENT', 'PARENT'],
    'view:analytics':    ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'FINANCE'],
    'view:reports':      ['SUPER_ADMIN', 'ADMIN', 'PRINCIPAL', 'TEACHER', 'FINANCE'],
  };
  return (permissions[permission] || []).includes(role);
}
