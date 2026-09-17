'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useSidebarCollapsed } from '@/components/Sidebar';
import { branchApi, type BranchAdmin } from '@/lib/api';
import styles from './Topbar.module.css';

interface BranchOption {
  id: string;
  name: string;
  code: string;
}

/**
 * Branch switcher, for owners/principals who work across branches. Lists the
 * branches they are entitled to (assigned admin roles, or all of them for the
 * school owner) and reissues the session on pick — the token's branchId claim
 * is what every service trusts, so only a reissue changes scope.
 */
function BranchSwitcher() {
  const { user, switchBranch } = useAuth();
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Owner sees the whole school; admins/principals see the branches they
    // hold a role in. Resolve silently — a single-branch school shows nothing
    // either way.
    const load = async () => {
      try {
        const all = await branchApi.list();
        if (!alive) return;
        let mine: BranchOption[] = all;
        if (!user?.roles?.includes('SUPER_ADMIN')) {
          const perBranch = await Promise.all(
            all.map(async (b: any) => {
              try {
                const admins: BranchAdmin[] = await branchApi.admins(b.id);
                return admins.some((a) => a.userId === user?.id) ? { id: b.id, name: b.name, code: b.code } : null;
              } catch {
                return null;
              }
            }),
          );
          mine = perBranch.filter(Boolean) as BranchOption[];
        }
        setBranches(mine);
      } catch {
        /* no multi-branch access — switcher stays hidden */
      }
    };
    void load();
    return () => { alive = false; };
  }, [user?.id, user?.roles]);

  if (branches.length < 2) return null;

  const current = branches.find((b) => b.id === user?.branchId);

  return (
    <select
      className={styles.branchSwitcher}
      value={current?.id ?? ''}
      disabled={busy}
      title="Switch working branch — your session and data scope follow"
      onChange={async (e) => {
        const branchId = e.target.value;
        if (!branchId || branchId === user?.branchId) return;
        setBusy(true);
        setError(null);
        try {
          await switchBranch(branchId);
          // Full reload so every page refetches under the new branch scope —
          // cheaper and safer than threading a branch-change event through
          // every screen's effect chain.
          window.location.reload();
        } catch (err: any) {
          setError(err?.detail || err?.message || 'Could not switch branch.');
          setBusy(false);
        }
      }}
    >
      {!current && <option value="">Select branch…</option>}
      {branches.map((b) => (
        <option key={b.id} value={b.id}>{b.name}</option>
      ))}
    </select>
  );
}

export default function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  const { school } = useAuth();
  const [collapsed, setCollapsed] = useSidebarCollapsed();

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        {/* Global sidebar hide/show — any screen, persisted per browser. */}
        <button
          type="button"
          className={styles.iconBtn}
          title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={() => setCollapsed(!collapsed)}
        >
          <span className="icon">{collapsed ? 'menu' : 'menu_open'}</span>
        </button>
        {school?.logoUrl && (
          <img
            src={school.logoUrl}
            alt={`${school.name} logo`}
            className={styles.schoolLogo}
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        )}
        <div>
          <h1 className={styles.title}>{title}</h1>
          {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
        </div>
      </div>
      <div className={styles.right}>
        <BranchSwitcher />
        <div className={styles.searchBar}>
          <span className="icon icon-sm">search</span>
          <input type="text" placeholder="Search anything..." />
        </div>
        <button className={`${styles.iconBtn} notification-dot`}>
          <span className="icon">notifications</span>
        </button>
        <button className={styles.iconBtn}>
          <span className="icon">help_outline</span>
        </button>
      </div>
    </header>
  );
}
