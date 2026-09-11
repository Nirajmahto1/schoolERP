'use client';
import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { authApi } from '@/lib/api';

export type UserRole = 'SUPER_ADMIN' | 'BRANCH_ADMIN' | 'PRINCIPAL' | 'TEACHER' | 'STUDENT' | 'PARENT' | 'ACCOUNTANT' | 'LIBRARIAN' | 'TRANSPORT_MANAGER' | 'FINANCE';

export interface User {
  id: string;
  name: string;
  email: string;
  /** Primary/legacy role — kept for backward-compatible components. */
  role: UserRole;
  /** All roles the user holds (Phase 2.1: branch-scoped role assignments). */
  roles: UserRole[];
  /** Effective `module.action` permissions resolved by identity-service `/me`. */
  permissions: string[];
  avatar?: string;
  branchId?: string;
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
  login: (email: string, password: string, totp?: string) => Promise<{ mfaRequired: boolean; mfaToken?: string } | void>;
  logout: () => void;
  error: string | null;
  hasPerm: (permission: string) => boolean;
}

// Map backend role CODES to frontend role union (used for legacy `role` field
// and any component that still switches on a single role).
function mapRole(backendRole: string): UserRole {
  const roleMap: Record<string, UserRole> = {
    SUPER_ADMIN: 'SUPER_ADMIN',
    BRANCH_ADMIN: 'BRANCH_ADMIN',
    PRINCIPAL: 'PRINCIPAL',
    TEACHER: 'TEACHER',
    STUDENT: 'STUDENT',
    PARENT: 'PARENT',
    ACCOUNTANT: 'ACCOUNTANT',
    LIBRARIAN: 'LIBRARIAN',
    TRANSPORT_MANAGER: 'TRANSPORT_MANAGER',
    FINANCE: 'FINANCE',
  };
  return roleMap[backendRole] || 'STUDENT';
}

export const ROLE_CODES = [
  'SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT',
  'PARENT', 'ACCOUNTANT', 'LIBRARIAN', 'TRANSPORT_MANAGER', 'FINANCE',
];

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Hydrate permissions from identity-service `/auth/me` when a token exists. */
  const hydrateMe = useCallback(async () => {
    const storedToken = localStorage.getItem('erp_token');
    if (!storedToken) {
      setLoading(false);
      return;
    }
    try {
      const me = await authApi.me();
      setUser(prev => prev ? {
        ...prev,
        roles: (me.roles || []).filter((r: string) => ROLE_CODES.includes(r)) as UserRole[],
        permissions: me.permissions || [],
        role: mapRole(((me.roles || [])[0]) || 'STUDENT'),
        branchId: me.branchId ?? prev.branchId,
      } : prev);
    } catch {
      // Token expired/invalid — leave user as-is; a 401 on the next call will
      // drive the login page.
    } finally {
      setLoading(false);
    }
  }, []);

  // Restore session from localStorage on mount, then hydrate permissions.
  useEffect(() => {
    const storedUser = localStorage.getItem('erp_user');
    const storedToken = localStorage.getItem('erp_token');
    if (storedUser && storedToken) {
      try {
        const parsed = JSON.parse(storedUser);
        setUser({
          ...parsed,
          roles: parsed.roles?.length ? parsed.roles : (parsed.role ? [parsed.role] : []),
          permissions: parsed.permissions || [],
          role: parsed.role || mapRole((parsed.roles || [])[0] || 'STUDENT'),
        });
      } catch { /* ignore corrupt data */ }
    }
    void hydrateMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (email: string, password: string, totp?: string): Promise<{ mfaRequired: boolean; mfaToken?: string } | void> => {
    setLoading(true);
    setError(null);
    try {
      const result = await authApi.login(email, password, totp);

      // Step 1 of 2: MFA challenge.
      if (result.mfaRequired && result.mfaToken) {
        setLoading(false);
        return { mfaRequired: true, mfaToken: result.mfaToken };
      }

      const backendRoles: string[] = result.user?.roles?.length ? result.user.roles : (result.user?.role ? [result.user.role] : ['STUDENT']);
      const roles = backendRoles.filter((r): r is UserRole => ROLE_CODES.includes(r));
      const apiUser: User = {
        id: result.user.id,
        name: result.user.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        email: result.user.email,
        role: mapRole(backendRoles[0] || 'STUDENT'),
        roles,
        permissions: [],
        branchId: result.user.branchId,
      };

      localStorage.setItem('erp_token', result.accessToken);
      localStorage.setItem('erp_refresh_token', result.refreshToken);
      localStorage.setItem('erp_user', JSON.stringify(apiUser));

      setUser(apiUser);
      void hydrateMe();
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

  /** Permission check against the resolved `module.action` set (identity /me). */
  const hasPerm = useCallback((permission: string) => {
    return user?.permissions?.includes(permission) ?? false;
  }, [user]);

  return <AuthContext.Provider value={{ user, loading, login, logout, error, hasPerm }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

/** Backward-compatible permission table — kept for callers that don't use /me. */
export function hasPermission(role: UserRole, permission: string): boolean {
  const permissions: Record<string, UserRole[]> = {
    'manage:school':     ['SUPER_ADMIN'],
    'manage:branches':   ['SUPER_ADMIN'],
    'manage:settings':   ['SUPER_ADMIN', 'BRANCH_ADMIN'],
    'manage:roles':      ['SUPER_ADMIN', 'BRANCH_ADMIN'],
    'manage:students':   ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'],
    'manage:staff':      ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'],
    'view:students':     ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER'],
    'view:staff':        ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'],
    'manage:academics':  ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'],
    'view:academics':    ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT', 'PARENT'],
    'manage:exams':      ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL'],
    'enter:marks':       ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER'],
    'view:results':      ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT', 'PARENT'],
    'mark:attendance':   ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER'],
    'view:attendance':   ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT', 'PARENT'],
    'manage:fees':       ['SUPER_ADMIN', 'BRANCH_ADMIN', 'FINANCE', 'ACCOUNTANT'],
    'collect:fees':      ['SUPER_ADMIN', 'BRANCH_ADMIN', 'FINANCE', 'ACCOUNTANT'],
    'view:fees':         ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'FINANCE', 'ACCOUNTANT', 'STUDENT', 'PARENT'],
    'pay:fees':          ['STUDENT', 'PARENT'],
    'manage:expenses':   ['SUPER_ADMIN', 'BRANCH_ADMIN', 'FINANCE'],
    'manage:payroll':    ['SUPER_ADMIN', 'BRANCH_ADMIN', 'FINANCE'],
    'view:financial_reports': ['SUPER_ADMIN', 'BRANCH_ADMIN', 'FINANCE', 'PRINCIPAL'],
    'manage:invoices':   ['SUPER_ADMIN', 'BRANCH_ADMIN', 'FINANCE'],
    'manage:budgets':    ['SUPER_ADMIN', 'BRANCH_ADMIN', 'FINANCE'],
    'send:announcements':['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER'],
    'view:announcements':['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT', 'PARENT', 'FINANCE', 'ACCOUNTANT'],
    'send:messages':     ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'PARENT'],
    'manage:library':    ['SUPER_ADMIN', 'BRANCH_ADMIN', 'LIBRARIAN'],
    'view:library':      ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT', 'LIBRARIAN'],
    'borrow:books':      ['TEACHER', 'STUDENT'],
    'manage:transport':  ['SUPER_ADMIN', 'BRANCH_ADMIN', 'TRANSPORT_MANAGER'],
    'view:transport':    ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'STUDENT', 'PARENT', 'TRANSPORT_MANAGER'],
    'view:analytics':    ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'FINANCE'],
    'view:reports':      ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'FINANCE'],
  };
  return (permissions[permission] || []).includes(role);
}
