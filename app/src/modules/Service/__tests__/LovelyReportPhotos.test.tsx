import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let hookResult = { paths: [] as string[], urls: {} as Record<string, string>, loading: false, error: null as string | null };
vi.mock('../../../lib/lovelyTickets', () => ({
  useLovelyReportPhotos: vi.fn(() => hookResult),
}));

import { LovelyReportPhotos } from '../LovelyReportPhotos';

describe('LovelyReportPhotos', () => {
  it('renders one linked thumbnail per signed photo', () => {
    hookResult = {
      paths: ['u1/1.jpg', 'u1/2.jpg'],
      urls: { 'u1/1.jpg': 'https://x/1', 'u1/2.jpg': 'https://x/2' },
      loading: false, error: null,
    };
    render(<LovelyReportPhotos reportId="r1" />);
    const imgs = screen.getAllByRole('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0].closest('a')).toHaveAttribute('href', 'https://x/1');
  });

  it('says so when the report has no photos', () => {
    hookResult = { paths: [], urls: {}, loading: false, error: null };
    render(<LovelyReportPhotos reportId="r1" />);
    expect(screen.getByText('No photos on this report.')).toBeInTheDocument();
  });

  it('shows the error instead of throwing when signing fails', () => {
    hookResult = { paths: ['u1/1.jpg'], urls: {}, loading: false, error: "Couldn't load photos (404): not found" };
    render(<LovelyReportPhotos reportId="r1" />);
    expect(screen.getByText(/Photos unavailable\./)).toBeInTheDocument();
    expect(screen.getByText(/Couldn't load photos \(404\)/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows a loading line while photos load', () => {
    hookResult = { paths: [], urls: {}, loading: true, error: null };
    render(<LovelyReportPhotos reportId="r1" />);
    expect(screen.getByText('Loading photos…')).toBeInTheDocument();
  });
});
