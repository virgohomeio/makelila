import { describe, it, expect } from 'vitest';
import { buildFirmwareMap } from './dashboard';

describe('buildFirmwareMap', () => {
  it('maps serials to their reported firmware version', () => {
    expect(buildFirmwareMap([
      { serial_number: 'LL01-284', firmware_version: 'LL01-AMP-001.016' },
      { serial_number: 'LL01-301', firmware_version: 'LL01-AMP-002.002' },
    ])).toEqual({
      'LL01-284': 'LL01-AMP-001.016',
      'LL01-301': 'LL01-AMP-002.002',
    });
  });

  it('drops rows without a firmware version (most of the fleet)', () => {
    expect(buildFirmwareMap([
      { serial_number: 'LL01-284', firmware_version: null },
      { serial_number: 'LL01-301', firmware_version: '' },
      { serial_number: 'LL01-305', firmware_version: '   ' },
      { serial_number: 'LL01-310', firmware_version: 'LL01-AMP-001.017' },
    ])).toEqual({ 'LL01-310': 'LL01-AMP-001.017' });
  });

  it('drops rows without a serial and trims firmware whitespace', () => {
    expect(buildFirmwareMap([
      { serial_number: null, firmware_version: 'LL01-AMP-001.016' },
      { serial_number: '', firmware_version: 'LL01-AMP-001.016' },
      { serial_number: 'LL01-284', firmware_version: ' LL01-AMP-001.016 ' },
    ])).toEqual({ 'LL01-284': 'LL01-AMP-001.016' });
  });
});
