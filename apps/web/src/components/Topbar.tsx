'use client';
import styles from './Topbar.module.css';

export default function Topbar({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
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
