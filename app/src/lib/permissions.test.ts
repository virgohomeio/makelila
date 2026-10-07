import { describe, it, expect } from 'vitest';
import { canDo, canView, canViewPosting, canAccessHiringModule, canManageBatches, type Role, type Action, type Module } from './permissions';

describe('canDo', () => {
  // Source-of-truth matrix mirroring ACTION_ROLES inside permissions.ts.
  // If you change the matrix there, mirror here.
  const cases: Array<[Role | null, Action, boolean]> = [
    // operator — only the symmetric warranty edit
    ['operator', 'approve_refund_manager',     false],
    ['operator', 'approve_refund_finance',     false],
    ['operator', 'deny_refund',                false],
    ['operator', 'dispose_unit',               false],
    ['operator', 'edit_warranty_registration', true],
    ['operator', 'submit_to_manager',          true],  // FR-3: the Account Manager (operator tier today) submits cases
    ['operator', 'move_refund_flow',           true],  // everyone involved moves cards fwd/back
    ['manager',  'move_refund_flow',            true],
    ['finance',  'move_refund_flow',            true],
    [null,       'move_refund_flow',            false],

    // manager — refund manager-side + disposition + warranty; not finance-stage
    ['manager',  'approve_refund_manager',     true],
    ['manager',  'approve_refund_finance',     false],
    ['manager',  'deny_refund',                true],
    ['manager',  'dispose_unit',               true],
    ['manager',  'edit_warranty_registration', true],

    // finance — every write
    ['finance',  'approve_refund_manager',     true],
    ['finance',  'approve_refund_finance',     true],
    ['finance',  'deny_refund',                true],
    ['finance',  'dispose_unit',               true],
    ['finance',  'edit_warranty_registration', true],

    // admin — every write
    ['admin',    'approve_refund_manager',     true],
    ['admin',    'approve_refund_finance',     true],
    ['admin',    'deny_refund',                true],
    ['admin',    'dispose_unit',               true],
    ['admin',    'edit_warranty_registration', true],

    // null role (profile not loaded yet) — every action false
    [null,       'approve_refund_manager',     false],
    [null,       'approve_refund_finance',     false],
    [null,       'deny_refund',                false],
    [null,       'submit_to_manager',          false],
    [null,       'dispose_unit',               false],
    [null,       'edit_warranty_registration', false],
  ];

  for (const [role, action, expected] of cases) {
    it(`canDo(${role ?? 'null'}, ${action}) = ${expected}`, () => {
      expect(canDo(role, action)).toBe(expected);
    });
  }
});

describe('canView', () => {
  const roles: Array<Role | null> = ['operator', 'manager', 'finance', 'admin', null];
  const restrictedModule: Module = 'finance';
  const openModules: Module[] = [
    'orderReview', 'fulfillment', 'build', 'postShipment',
    'service', 'stock', 'customers', 'templates', 'activityLog', 'dashboard',
  ];

  for (const role of roles) {
    const expectedFinance = role === 'finance' || role === 'admin';
    it(`canView(${role ?? 'null'}, finance) = ${expectedFinance}`, () => {
      expect(canView(role, restrictedModule)).toBe(expectedFinance);
    });

    for (const m of openModules) {
      it(`canView(${role ?? 'null'}, ${m}) = true (non-restricted)`, () => {
        expect(canView(role, m)).toBe(true);
      });
    }
  }
});

describe('canViewPosting', () => {
  it('returns true for finance role regardless of assignment', () => {
    expect(canViewPosting('finance', false)).toBe(true);
  });
  it('returns true for admin role regardless of assignment', () => {
    expect(canViewPosting('admin', false)).toBe(true);
  });
  it('returns true for an operator who is an assigned interviewer', () => {
    expect(canViewPosting('operator', true)).toBe(true);
  });
  it('returns false for an operator who is not assigned', () => {
    expect(canViewPosting('operator', false)).toBe(false);
  });
  it('returns false for a null role with no assignment', () => {
    expect(canViewPosting(null, false)).toBe(false);
  });
  it('returns false for a null role even if assigned as interviewer', () => {
    expect(canViewPosting(null, true)).toBe(false);
  });
  it('returns false for an undefined role even if assigned as interviewer', () => {
    expect(canViewPosting(undefined, true)).toBe(false);
  });
});

describe('canView hiring module', () => {
  it('is restricted like finance', () => {
    expect(canView('operator', 'hiring')).toBe(false);
    expect(canView('finance', 'hiring')).toBe(true);
    expect(canView('admin', 'hiring')).toBe(true);
  });
});

describe('canAccessHiringModule', () => {
  it('returns true for leadership regardless of assignment', () => {
    expect(canAccessHiringModule('finance', false)).toBe(true);
    expect(canAccessHiringModule('admin', false)).toBe(true);
    expect(canAccessHiringModule('finance', true)).toBe(true);
  });

  it('returns true for a non-leadership user assigned to at least one posting', () => {
    expect(canAccessHiringModule('operator', true)).toBe(true);
    expect(canAccessHiringModule('manager', true)).toBe(true);
  });

  it('returns false for a non-leadership user not assigned to any posting', () => {
    expect(canAccessHiringModule('operator', false)).toBe(false);
  });

  // Deliberately differs from canViewPosting()'s `if (!role) return false`
  // guard: isAssignedToAnyPosting can only be true after a real, RLS-gated
  // DB lookup for this authenticated user's own id already succeeded, so a
  // null/undefined role here means the profile-role fetch just hasn't
  // resolved yet (a real race — see auth.tsx), not an unauthenticated user.
  it('returns true for a null/undefined role when already confirmed assigned', () => {
    expect(canAccessHiringModule(null, true)).toBe(true);
    expect(canAccessHiringModule(undefined, true)).toBe(true);
  });

  it('returns false for a null/undefined role with no confirmed assignment', () => {
    expect(canAccessHiringModule(null, false)).toBe(false);
    expect(canAccessHiringModule(undefined, false)).toBe(false);
  });
});

describe('canManageBatches', () => {
  const roles: Array<Role | null> = ['operator', 'manager', 'finance', 'admin', null];

  it.each(roles)('role %s + allowlisted = true', (role) => {
    expect(canManageBatches(role, true)).toBe(true);
  });

  it.each(roles)('role %s + not allowlisted = leadership only', (role) => {
    const expected = role === 'finance' || role === 'admin';
    expect(canManageBatches(role, false)).toBe(expected);
  });

  // Mirrors canAccessHiringModule: a true allowlist flag can only come from an
  // RLS-gated read filtered on the caller's own id, so it stands on its own
  // while AuthProvider's separate profile fetch is still in flight.
  it('admits an allowlisted user whose role has not loaded yet', () => {
    expect(canManageBatches(null, true)).toBe(true);
    expect(canManageBatches(undefined, true)).toBe(true);
  });

  it('denies an unloaded role with no allowlist row', () => {
    expect(canManageBatches(null, false)).toBe(false);
    expect(canManageBatches(undefined, false)).toBe(false);
  });
});
