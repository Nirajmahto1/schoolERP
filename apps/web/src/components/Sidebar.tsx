'use client';
import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth, UserRole, hasPermission } from '@/context/AuthContext';
import styles from './Sidebar.module.css';

interface NavItem {
  label: string;
  icon: string;
  href: string;
  permission?: string;
  allowedRoles?: UserRole[];
}

const allNavItems: NavItem[] = [
  { label: 'Dashboard', icon: 'dashboard', href: '/dashboard' },
  { label: 'My Profile', icon: 'account_circle', href: '/dashboard/profile' },
  { label: 'Students', icon: 'group', href: '/dashboard/students', permission: 'view:students' },
  { label: 'Staff & HR', icon: 'badge', href: '/dashboard/staff', permission: 'view:staff' },
  { label: 'Academics', icon: 'menu_book', href: '/dashboard/academics', permission: 'view:academics' },
  { label: 'Attendance', icon: 'event_available', href: '/dashboard/attendance', permission: 'view:attendance' },
  { label: 'Fees', icon: 'payments', href: '/dashboard/fees', permission: 'view:fees' },
  { label: 'Communication', icon: 'campaign', href: '/dashboard/communication', permission: 'view:announcements' },
  { label: 'Library', icon: 'local_library', href: '/dashboard/library', permission: 'view:library' },
  { label: 'Transport', icon: 'directions_bus', href: '/dashboard/transport', permission: 'view:transport' },
  { label: 'Exams', icon: 'analytics', href: '/dashboard/exams', permission: 'view:results' },
  { label: 'Settings', icon: 'settings', href: '/dashboard/settings', permission: 'manage:settings' },
];

// Student-specific nav items
const studentNavItems: NavItem[] = [
  { label: 'Dashboard', icon: 'dashboard', href: '/dashboard' },
  { label: 'My Profile', icon: 'account_circle', href: '/dashboard/profile' },
  { label: 'My Classes', icon: 'class', href: '/dashboard/my-classes' },
  { label: 'My Attendance', icon: 'event_available', href: '/dashboard/my-attendance' },
  { label: 'My Results', icon: 'analytics', href: '/dashboard/my-results' },
  { label: 'My Fees', icon: 'payments', href: '/dashboard/my-fees' },
  { label: 'Timetable', icon: 'calendar_month', href: '/dashboard/timetable' },
  { label: 'Library', icon: 'local_library', href: '/dashboard/library' },
  { label: 'Announcements', icon: 'campaign', href: '/dashboard/communication' },
  { label: 'Transport', icon: 'directions_bus', href: '/dashboard/transport' },
];

// Parent-specific nav items
const parentNavItems: NavItem[] = [
  { label: 'Dashboard', icon: 'dashboard', href: '/dashboard' },
  { label: 'My Profile', icon: 'account_circle', href: '/dashboard/profile' },
  { label: 'Child Overview', icon: 'child_care', href: '/dashboard/child-overview' },
  { label: 'Attendance', icon: 'event_available', href: '/dashboard/child-attendance' },
  { label: 'Results', icon: 'analytics', href: '/dashboard/child-results' },
  { label: 'Fee Payments', icon: 'payments', href: '/dashboard/fee-payments' },
  { label: 'Communication', icon: 'campaign', href: '/dashboard/communication' },
  { label: 'Transport', icon: 'directions_bus', href: '/dashboard/transport' },
  { label: 'PTM Schedule', icon: 'event', href: '/dashboard/ptm' },
];

// Teacher-specific nav items
const teacherNavItems: NavItem[] = [
  { label: 'Dashboard', icon: 'dashboard', href: '/dashboard' },
  { label: 'My Profile', icon: 'account_circle', href: '/dashboard/profile' },
  { label: 'My Classes', icon: 'class', href: '/dashboard/my-classes' },
  { label: 'Students', icon: 'group', href: '/dashboard/students' },
  { label: 'Take Attendance', icon: 'fact_check', href: '/dashboard/attendance' },
  { label: 'Enter Marks', icon: 'grading', href: '/dashboard/enter-marks' },
  { label: 'Timetable', icon: 'calendar_month', href: '/dashboard/timetable' },
  { label: 'Communication', icon: 'campaign', href: '/dashboard/communication' },
  { label: 'Library', icon: 'local_library', href: '/dashboard/library' },
  { label: 'Leave Request', icon: 'event_busy', href: '/dashboard/leave-request' },
];

// Finance-specific nav items
const financeNavItems: NavItem[] = [
  { label: 'Dashboard', icon: 'dashboard', href: '/dashboard' },
  { label: 'My Profile', icon: 'account_circle', href: '/dashboard/profile' },
  { label: 'Fee Collection', icon: 'payments', href: '/dashboard/fees' },
  { label: 'Expense Tracker', icon: 'receipt_long', href: '/dashboard/expenses' },
  { label: 'Payroll', icon: 'account_balance_wallet', href: '/dashboard/payroll' },
  { label: 'Financial Reports', icon: 'assessment', href: '/dashboard/financial-reports' },
  { label: 'Invoicing', icon: 'description', href: '/dashboard/invoicing' },
  { label: 'Students', icon: 'group', href: '/dashboard/students' },
  { label: 'Budgets', icon: 'savings', href: '/dashboard/budgets' },
  { label: 'Communication', icon: 'campaign', href: '/dashboard/communication' },
];

function getNavItems(role: UserRole): NavItem[] {
  switch (role) {
    case 'STUDENT': return studentNavItems;
    case 'PARENT': return parentNavItems;
    case 'TEACHER': return teacherNavItems;
    case 'FINANCE': return financeNavItems;
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
  TEACHER: 'Teacher',
  STUDENT: 'Student',
  PARENT: 'Parent',
  ACCOUNTANT: 'Accountant',
  LIBRARIAN: 'Librarian',
  TRANSPORT_MANAGER: 'Transport Manager',
  FINANCE: 'Finance',
};

export default function Sidebar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  if (!user) return null;

  const navItems = getNavItems(user.role);
  const bottomNavItems = navItems.slice(0, 5);

  return (
    <>
      {/* Mobile hamburger */}
      <button className={styles.mobileToggle} onClick={() => setMobileOpen(true)}>
        <span className="icon">menu</span>
      </button>

      {/* Overlay */}
      {mobileOpen && <div className={styles.overlay} onClick={() => setMobileOpen(false)} />}

      <aside className={`${styles.sidebar} ${mobileOpen ? styles.open : ''}`}>
        {/* Logo */}
        <div className={styles.logo}>
          <div className={styles.logoIcon}>
            <span className="icon" style={{ color: 'white', fontSize: 22 }}>school</span>
          </div>
          <div>
            <div className={styles.logoTitle}>EduCore</div>
            <div className={styles.logoSub}>ERP System</div>
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
                onClick={() => setMobileOpen(false)}>
                <span className="icon">{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* User profile */}
        <div className={styles.userProfile}>
          <div className="avatar">{user.name.split(' ').map(n => n[0]).join('')}</div>
          <div className={styles.userInfo}>
            <div className={styles.userName}>{user.name}</div>
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
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
