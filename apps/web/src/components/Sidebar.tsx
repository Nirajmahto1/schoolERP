'use client';
import { useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth, UserRole, hasPermission } from '@/context/AuthContext';
import { useI18n } from '@/lib/i18n';
import styles from './Sidebar.module.css';

// ── Global collapse store ──
// One module-level value + useSyncExternalStore: every consumer (Sidebar,
// Topbar, pages) sees the SAME state and re-renders together. The previous
// hook handed each caller an independent useState copy — the Builder page
// collapsed the CSS width while the Sidebar component never heard about it,
// so the rail kept its full-width labels and overflowed the shrunken layout.
let collapsedState = false;
let storeReady = false;
const listeners = new Set<() => void>();

function applyWidth(): void {
  document.documentElement.style.setProperty('--sidebar-width', collapsedState ? '68px' : '260px');
}

function initStore(): void {
  if (storeReady || typeof window === 'undefined') return;
  storeReady = true;
  collapsedState = window.localStorage.getItem('sidebar-collapsed') === '1';
  applyWidth();
}

function setCollapsedGlobal(v: boolean): void {
  collapsedState = v;
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('sidebar-collapsed', v ? '1' : '0');
    applyWidth();
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Shared collapse state — same value in every component, persisted per browser. */
export function useSidebarCollapsed(): [boolean, (v: boolean) => void] {
  const collapsed = useSyncExternalStore(
    subscribe,
    () => {
      initStore();
      return collapsedState;
    },
    () => false,
  );
  return [collapsed, setCollapsedGlobal];
}

interface NavItem {
  labelKey: string;
  icon: string;
  href: string;
  permission?: string;
  allowedRoles?: UserRole[];
}

// Labels are i18n KEYS (Phase 8.9) — resolved through t() at render time so
// the whole rail switches language with the topbar selector.
const allNavItems: NavItem[] = [
  { labelKey: 'nav.dashboard', icon: 'dashboard', href: '/dashboard' },
  { labelKey: 'nav.profile', icon: 'account_circle', href: '/dashboard/profile' },
  { labelKey: 'nav.branches', icon: 'account_tree', href: '/dashboard/branches', permission: 'manage:branches' },
  { labelKey: 'nav.students', icon: 'group', href: '/dashboard/students', permission: 'view:students' },
  { labelKey: 'nav.staff', icon: 'badge', href: '/dashboard/staff', permission: 'view:staff' },
  { labelKey: 'nav.academics', icon: 'menu_book', href: '/dashboard/academics', permission: 'view:academics' },
  { labelKey: 'nav.timetableBuilder', icon: 'grid_view', href: '/dashboard/timetable-builder', permission: 'manage:academics' },
  { labelKey: 'nav.attendance', icon: 'event_available', href: '/dashboard/attendance', permission: 'view:attendance' },
  { labelKey: 'nav.fees', icon: 'payments', href: '/dashboard/fees', permission: 'view:fees' },
  { labelKey: 'nav.communication', icon: 'campaign', href: '/dashboard/communication', permission: 'view:announcements' },
  { labelKey: 'nav.library', icon: 'local_library', href: '/dashboard/library', permission: 'view:library' },
  { labelKey: 'nav.transport', icon: 'directions_bus', href: '/dashboard/transport', permission: 'view:transport' },
  { labelKey: 'nav.exams', icon: 'analytics', href: '/dashboard/exams', permission: 'view:results' },
  { labelKey: 'nav.settings', icon: 'settings', href: '/dashboard/settings', permission: 'manage:settings' },
];

// Student-specific nav items
const studentNavItems: NavItem[] = [
  { labelKey: 'nav.dashboard', icon: 'dashboard', href: '/dashboard' },
  { labelKey: 'nav.profile', icon: 'account_circle', href: '/dashboard/profile' },
  { labelKey: 'nav.myClasses', icon: 'class', href: '/dashboard/my-classes' },
  { labelKey: 'nav.myAttendance', icon: 'event_available', href: '/dashboard/my-attendance' },
  { labelKey: 'nav.myResults', icon: 'analytics', href: '/dashboard/my-results' },
  { labelKey: 'nav.myFees', icon: 'payments', href: '/dashboard/my-fees' },
  { labelKey: 'nav.timetable', icon: 'calendar_month', href: '/dashboard/timetable' },
  { labelKey: 'nav.library', icon: 'local_library', href: '/dashboard/library' },
  { labelKey: 'nav.announcements', icon: 'campaign', href: '/dashboard/communication' },
  { labelKey: 'nav.transport', icon: 'directions_bus', href: '/dashboard/transport' },
];

// Parent-specific nav items
const parentNavItems: NavItem[] = [
  { labelKey: 'nav.dashboard', icon: 'dashboard', href: '/dashboard' },
  { labelKey: 'nav.profile', icon: 'account_circle', href: '/dashboard/profile' },
  { labelKey: 'nav.childOverview', icon: 'child_care', href: '/dashboard/child-overview' },
  { labelKey: 'nav.childAttendance', icon: 'event_available', href: '/dashboard/child-attendance' },
  { labelKey: 'nav.childResults', icon: 'analytics', href: '/dashboard/child-results' },
  { labelKey: 'nav.myFees', icon: 'payments', href: '/dashboard/fee-payments' },
  { labelKey: 'nav.communication', icon: 'campaign', href: '/dashboard/communication' },
  { labelKey: 'nav.transport', icon: 'directions_bus', href: '/dashboard/transport' },
  { labelKey: 'nav.ptm', icon: 'event', href: '/dashboard/ptm' },
];

// Teacher-specific nav items
const teacherNavItems: NavItem[] = [
  { labelKey: 'nav.dashboard', icon: 'dashboard', href: '/dashboard' },
  { labelKey: 'nav.profile', icon: 'account_circle', href: '/dashboard/profile' },
  { labelKey: 'nav.myClasses', icon: 'class', href: '/dashboard/my-classes' },
  { labelKey: 'nav.students', icon: 'group', href: '/dashboard/students' },
  { labelKey: 'nav.takeAttendance', icon: 'fact_check', href: '/dashboard/attendance' },
  { labelKey: 'nav.enterMarks', icon: 'grading', href: '/dashboard/enter-marks' },
  { labelKey: 'nav.timetable', icon: 'calendar_month', href: '/dashboard/timetable' },
  { labelKey: 'nav.communication', icon: 'campaign', href: '/dashboard/communication' },
  { labelKey: 'nav.library', icon: 'local_library', href: '/dashboard/library' },
  { labelKey: 'nav.leaveRequest', icon: 'event_busy', href: '/dashboard/leave-request' },
];

// Finance-specific nav items
const financeNavItems: NavItem[] = [
  { labelKey: 'nav.dashboard', icon: 'dashboard', href: '/dashboard' },
  { labelKey: 'nav.profile', icon: 'account_circle', href: '/dashboard/profile' },
  { labelKey: 'nav.feeCollection', icon: 'payments', href: '/dashboard/fees' },
  { labelKey: 'nav.expenseTracker', icon: 'receipt_long', href: '/dashboard/expenses' },
  { labelKey: 'nav.payroll', icon: 'account_balance_wallet', href: '/dashboard/payroll' },
  { labelKey: 'nav.financialReports', icon: 'assessment', href: '/dashboard/financial-reports' },
  { labelKey: 'nav.invoicing', icon: 'description', href: '/dashboard/invoicing' },
  { labelKey: 'nav.students', icon: 'group', href: '/dashboard/students' },
  { labelKey: 'nav.budgets', icon: 'savings', href: '/dashboard/budgets' },
  { labelKey: 'nav.communication', icon: 'campaign', href: '/dashboard/communication' },
];

function getNavItems(role: UserRole, roles: UserRole[] = []): NavItem[] {
  // A teacher who is ALSO a HOD / Academic Head gets the teacher home items
  // plus everything the leadership roles unlock (Timetable Builder,
  // Academics, Exams…) — the base-role switch alone would hide those.
  if (role === 'TEACHER' && (roles.includes('HOD') || roles.includes('ACADEMIC_HEAD'))) {
    const leadership = allNavItems.filter(item =>
      !item.permission || hasPermission(role, item.permission)
    );
    const merged = [...teacherNavItems];
    for (const item of leadership) {
      if (!merged.some((m) => m.href === item.href)) merged.push(item);
    }
    return merged;
  }
  switch (role) {
    case 'STUDENT': return studentNavItems;
    case 'PARENT': return parentNavItems;
    case 'TEACHER': return teacherNavItems;
    case 'FINANCE': return financeNavItems;
    case 'HOD':
    case 'ACADEMIC_HEAD':
      // Leadership-only accounts: dashboard + profile + everything their
      // permissions unlock (academics, exams, students, staff…).
      return allNavItems.filter(item =>
        !item.permission || hasPermission(role, item.permission)
      );
    default:
      return allNavItems.filter(item =>
        !item.permission || hasPermission(role, item.permission)
      );
  }
}

const roleLabels: Record<UserRole, string> = {
  SUPER_ADMIN: 'Super Admin',
  BRANCH_ADMIN: 'Branch Admin',
  PRINCIPAL: 'Principal',
  HOD: 'Head of Dept.',
  ACADEMIC_HEAD: 'Academic Head',
  TEACHER: 'Teacher',
  STUDENT: 'Student',
  PARENT: 'Parent',
  ACCOUNTANT: 'Accountant',
  LIBRARIAN: 'Librarian',
  TRANSPORT_MANAGER: 'Transport Manager',
  FINANCE: 'Finance',
};

export default function Sidebar() {
  const { user, school, logout } = useAuth();
  const { t } = useI18n();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [logoBroken, setLogoBroken] = useState(false);
  const [collapsed, setCollapsed] = useSidebarCollapsed();

  if (!user) return null;

  const navItems = getNavItems(user.role, user.roles);
  const bottomNavItems = navItems.slice(0, 5);

  return (
    <>
      {/* Mobile hamburger */}
      <button className={styles.mobileToggle} onClick={() => setMobileOpen(true)}>
        <span className="icon">menu</span>
      </button>

      {/* Overlay */}
      {mobileOpen && <div className={styles.overlay} onClick={() => setMobileOpen(false)} />}

      <aside className={`${styles.sidebar} ${mobileOpen ? styles.open : ''} ${collapsed ? styles.collapsed : ''}`}>
        <button
          className={styles.collapseToggle}
          title={collapsed ? 'Show labels' : 'Hide sidebar'}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="icon">{collapsed ? 'chevron_right' : 'chevron_left'}</span>
        </button>
        {/* Logo — the school's own branding, falling back to the generic
            mark when no logo was uploaded or the file went missing. */}
        <div className={styles.logo}>
          {school?.logoUrl && !logoBroken ? (
            <img
              src={school.logoUrl}
              alt={`${school.name} logo`}
              className={styles.logoImage}
              onError={() => setLogoBroken(true)}
            />
          ) : (
            <div className={styles.logoIcon}>
              <span className="icon" style={{ color: 'white', fontSize: 22 }}>school</span>
            </div>
          )}
          <div>
            <div className={styles.logoTitle}>{school?.name || 'EduCore'}</div>
            <div className={styles.logoSub}>{school?.name ? 'ERP Portal' : 'ERP System'}</div>
          </div>
          <button className={styles.closeMobile} onClick={() => setMobileOpen(false)}>
            <span className="icon">close</span>
          </button>
        </div>

        {/* Role Label */}
        <div className={styles.roleSwitcher}>
          <div className={styles.roleSwitcherBtn} style={{ cursor: 'default' }}>
            <span className="icon icon-sm">person</span>
            <span>{roleLabels[user.role]}</span>
          </div>
        </div>

        {/* Navigation */}
        <nav className={styles.nav}>
          {navItems.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href}
                className={`${styles.navItem} ${isActive ? styles.active : ''}`}
                title={t(item.labelKey)}
                onClick={() => setMobileOpen(false)}>
                <span className="icon">{item.icon}</span>
                <span className={styles.navLabel}>{t(item.labelKey)}</span>
              </Link>
            );
          })}
        </nav>

        {/* User profile */}
        <div className={styles.userProfile}>
          {/* name can be missing from a corrupt/legacy erp_user; never white-screen the whole dashboard for it */}
          <div className="avatar">{(user.name || user.email || '?').split(' ').map(n => n[0]).join('')}</div>
          <div className={styles.userInfo}>
            <div className={styles.userName}>{user.name || user.email}</div>
            <div className={styles.userRole}>{roleLabels[user.role]}</div>
          </div>
          <button className={styles.logoutBtn} onClick={() => { logout(); window.location.href = '/'; }}>
            <span className="icon icon-sm">logout</span>
          </button>
        </div>
      </aside>

      {/* Mobile Bottom Bar */}
      <nav className={styles.bottomBar}>
        {bottomNavItems.map((item) => {
          const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href));
          return (
            <Link key={item.href} href={item.href} className={`${styles.bottomItem} ${isActive ? styles.bottomActive : ''}`}>
              <span className="icon">{item.icon}</span>
              <span>{t(item.labelKey)}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
