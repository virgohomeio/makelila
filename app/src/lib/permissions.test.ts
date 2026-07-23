import { describe, it, expect } from 'vitest';
import { canDo, canView, type Role, type Action, type Module } from './permissions';

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
