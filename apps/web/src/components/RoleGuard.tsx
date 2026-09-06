'use client';
import { useAuth, UserRole, hasPermission } from '@/context/AuthContext';
import { ReactNode } from 'react';

interface RoleGuardProps {
  children: ReactNode;
  permission?: string;
  allowedRoles?: UserRole[];
  fallback?: ReactNode;
}

export default function RoleGuard({ children, permission, allowedRoles, fallback }: RoleGuardProps) {
  const { user } = useAuth();
  if (!user) return null;

  if (permission && !hasPermission(user.role, permission)) {
    return fallback ? <>{fallback}</> : null;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return fallback ? <>{fallback}</> : null;
  }

  return <>{children}</>;
}
