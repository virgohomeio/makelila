// Centralised role-based access helpers. Mirror of the DB user_role enum
// from migration 20260607020000_profiles_role_enum_and_canDo_canView.sql.
//
// Two helpers:
//   - canDo(role, action) — write-action gating. Used inline in UI to
//     hide/disable buttons before the operator clicks them; RLS is the
//     backstop on the DB side.
//   - canView(role, module) — module-level visibility. Today only the
//     Finance module is restricted; everything else returns true. Used
//     by GlobalNav nav-render and the Finance route guard (when those
//     ship in Feature 5).
//
// Null/undefined role returns false for canDo and canView('finance') —
// protects the brief race before AuthProvider loads the profile.

export type Role = 'operator' | 'manager' | 'finance' | 'admin';

export type Action =
  | 'approve_refund_manager'
  | 'approve_refund_finance'
  | 'deny_refund'
  | 'dispose_unit'                  // Reina's Returns disposition writes
  | 'edit_warranty_registration';   // Junaid's warranty write path

export type Module =
  | 'finance'      // restricted to finance + admin only
  | 'orderReview'
  | 'fulfillment'
  | 'build'
  | 'postShipment'
  | 'service'
  | 'stock'
  | 'customers'
  | 'templates'
  | 'activityLog'
  | 'dashboard';

const ACTION_ROLES: Record<Action, Role[]> = {
  approve_refund_manager:     ['manager', 'finance', 'admin'],
  approve_refund_finance:     ['finance', 'admin'],
  deny_refund:                ['manager', 'finance', 'admin'],
  dispose_unit:               ['manager', 'finance', 'admin'],
  edit_warranty_registration: ['operator', 'manager', 'finance', 'admin'],
};

const RESTRICTED_MODULES: Module[] = ['finance'];

export function canDo(role: Role | null | undefined, action: Action): boolean {
  if (!role) return false;
  return ACTION_ROLES[action].includes(role);
}

export function canView(role: Role | null | undefined, module: Module): boolean {
  if (RESTRICTED_MODULES.includes(module)) {
    if (!role) return false;
    return role === 'finance' || role === 'admin';
  }
  // Non-restricted modules are visible to every authenticated user
  // (the @virgohome.io domain check in auth.tsx is the outer gate).
  return true;
}
