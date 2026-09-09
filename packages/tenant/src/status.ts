// ──────────────────────────────────────────────
// Tenant status → HTTP semantics (BUILD_PLAN 1.3.4)
//
// "Reject requests to SUSPENDED/DELETING tenants with a clear 402/423." A bare
// 403 would tell a school their data still exists while hiding the reason;
// 402 (payment) and 423 (locked) let the school's front office self-diagnose,
// and the plan change is an action the school, not the platform, performs.
// ──────────────────────────────────────────────

import type { TenantStatus } from '@school-erp/control-plane';

export interface TenantStatusHttp {
  status: number;
  type: string;
  title: string;
  detail: string;
}

const SUSPENDED: TenantStatusHttp = {
  status: 402,
  type: 'tenant-suspended',
  title: 'Subscription Suspended',
  detail:
    'This school account is suspended (usually non-payment). Data is intact and read-only access resumes when the subscription is settled.',
};

const DELETING: TenantStatusHttp = {
  status: 423,
  type: 'tenant-locked',
  title: 'Account Scheduled For Deletion',
  detail:
    'This school account is inside its deletion retention window. Contact platform support immediately to cancel the deletion.',
};

const CHURNED: TenantStatusHttp = {
  status: 423,
  type: 'tenant-locked',
  title: 'Account Closed',
  detail: 'This school account has been closed.',
};

export function tenantStatusHttp(status: TenantStatus): TenantStatusHttp | null {
  switch (status) {
    case 'SUSPENDED':
      return SUSPENDED;
    case 'DELETING':
      return DELETING;
    case 'CHURNED':
      return CHURNED;
    default:
      // TRIAL / ACTIVE serve normally.
      return null;
  }
}
