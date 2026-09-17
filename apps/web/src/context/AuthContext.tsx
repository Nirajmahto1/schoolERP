'use client';
import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { authApi, setupApi, API_BASE, ApiError } from '@/lib/api';

/** Tenant branding for the dashboard chrome (sidebar/topbar). */
export interface SchoolProfile {
  name: string;
  code: string;
  logoUrl: string | null;
}

/**
 * Logo URLs are gateway-relative (`/setup/logo/…`). Resolve against the API
 * origin — a root-relative path would hit the Next.js server (port 3000)
 * and 404, silently degrading every user to the fallback icon.
 */
export function resolveLogoUrl(logoUrl: string | null | undefined): string | null {
  if (!logoUrl) return null;
  if (/^https?:\/\//.test(logoUrl)) return logoUrl;
  return `${API_BASE}${logoUrl}`;
}

export type UserRole = 'SUPER_ADMIN' | 'BRANCH_ADMIN' | 'PRINCIPAL' | 'HOD' | 'ACADEMIC_HEAD' | 'TEACHER' | 'STUDENT' | 'PARENT' | 'ACCOUNTANT' | 'LIBRARIAN' | 'TRANSPORT_MANAGER' | 'FINANCE';

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
  /** Branding for sidebar/topbar — null until fetched (or fetch fails). */
  school: SchoolProfile | null;
  loading: boolean;
  login: (email: string, password: string, totp?: string) => Promise<{ mfaRequired: boolean; mfaToken?: string } | void>;
  logout: () => void;
  error: string | null;
  hasPerm: (permission: string) => boolean;
  /** Reissue the session scoped to another branch — for owners/admins who
   *  work across branches. Swaps BOTH tokens + branchId so refresh keeps the
   *  branch, then re-hydrates permissions for the new scope. */
  switchBranch: (branchId: string) => Promise<void>;
}

// Map backend role CODES to frontend role union (used for legacy `role` field
// and any component that still switches on a single role).
function mapRole(backendRole: string): UserRole {
  const roleMap: Record<string, UserRole> = {
    SUPER_ADMIN: 'SUPER_ADMIN',
    BRANCH_ADMIN: 'BRANCH_ADMIN',
    PRINCIPAL: 'PRINCIPAL',
    HOD: 'HOD',
    ACADEMIC_HEAD: 'ACADEMIC_HEAD',
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
  'SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'HOD', 'ACADEMIC_HEAD', 'TEACHER', 'STUDENT',
  'PARENT', 'ACCOUNTANT', 'LIBRARIAN', 'TRANSPORT_MANAGER', 'FINANCE',
];

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [school, setSchool] = useState<SchoolProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Fetch school branding whenever a token appears — chrome degrades to the
   *  generic icon if this fails (empty DB, route missing, offline gateway). */
  const hydrateSchool = useCallback(async () => {
    try {
      const profile = await setupApi.profile();
      setSchool({ name: profile.name, code: profile.code, logoUrl: resolveLogoUrl(profile.logoUrl) });
    } catch {
      setSchool(null);
    }
  }, []);

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
    void hydrateSchool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the in-memory user across silent token refreshes, and end the
  // session cleanly when the API layer reports the refresh chain is dead —
  // previously a dead session left the UI on screen with every action failing.
  useEffect(() => {
    const onRefreshed = () => { void hydrateMe(); };
    const onSessionDead = (e: PromiseRejectionEvent) => {
      if (e.reason instanceof ApiError && e.reason.status === 401) {
        localStorage.removeItem('erp_user');
        setUser(null);
        window.location.href = '/';
      }
    };
    window.addEventListener('erp:token-refreshed', onRefreshed);
    window.addEventListener('unhandledrejection', onSessionDead);
    return () => {
      window.removeEventListener('erp:token-refreshed', onRefreshed);
      window.removeEventListener('unhandledrejection', onSessionDead);
    };
  }, [hydrateMe]);

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
      void hydrateSchool();
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
    setSchool(null);
    setError(null);
  };

  /** Swap the session to another branch: new token pair (the token's branchId
   *  claim is what every service trusts, so only a reissue changes scope),
   *  updated stored user, and a fresh permission hydration. */
  const switchBranch = useCallback(async (branchId: string) => {
    if (!user) throw new Error('Not signed in.');
    const result = await authApi.switchBranch(branchId);
    localStorage.setItem('erp_token', result.accessToken);
    localStorage.setItem('erp_refresh_token', result.refreshToken);
    const newBranch = result.branchId ?? result.user?.branchId ?? branchId;
    const updated: User = { ...user, branchId: newBranch };
    localStorage.setItem('erp_user', JSON.stringify(updated));
    setUser(updated);
    await hydrateMe();
  }, [user, hydrateMe]);

  /** Permission check against the resolved `module.action` set (identity /me). */
  const hasPerm = useCallback((permission: string) => {
    return user?.permissions?.includes(permission) ?? false;
  }, [user]);

  return <AuthContext.Provider value={{ user, school, loading, login, logout, error, hasPerm, switchBranch }}>{children}</AuthContext.Provider>;
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
    'view:staff':        ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'HOD', 'ACADEMIC_HEAD'],
    'manage:academics':  ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'HOD', 'ACADEMIC_HEAD'],
    'view:academics':    ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'HOD', 'ACADEMIC_HEAD', 'TEACHER', 'STUDENT', 'PARENT'],
    'manage:exams':      ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'HOD', 'ACADEMIC_HEAD'],
    'enter:marks':       ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'HOD', 'ACADEMIC_HEAD'],
    'view:results':      ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'HOD', 'ACADEMIC_HEAD', 'STUDENT', 'PARENT'],
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
    'view:analytics':    ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'FINANCE', 'HOD', 'ACADEMIC_HEAD'],
    'view:reports':      ['SUPER_ADMIN', 'BRANCH_ADMIN', 'PRINCIPAL', 'TEACHER', 'FINANCE', 'HOD', 'ACADEMIC_HEAD'],
  };
  return (permissions[permission] || []).includes(role);
}
