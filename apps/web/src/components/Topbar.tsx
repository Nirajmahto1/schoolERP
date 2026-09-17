'use client';
import { useAuth } from '@/context/AuthContext';
import styles from './Topbar.module.css';

export default function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  const { school } = useAuth();

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
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
