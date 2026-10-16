import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

let hookResult = { url: null as string | null, loading: false, error: null as string | null };
vi.mock('../../../lib/lovelyTickets', () => ({
  useLovelyReportPhotos: vi.fn(),
  useLovelyFeedbackPhoto: vi.fn(() => hookResult),
}));

import { LovelyFeedbackPhoto } from '../LovelyReportPhotos';

describe('LovelyFeedbackPhoto', () => {
  it('renders the signed photo as a link to full size', () => {
    hookResult = { url: 'https://x/shot', loading: false, error: null };
    render(<LovelyFeedbackPhoto path="u1/shot.png" />);
    expect(screen.getByRole('img').closest('a')).toHaveAttribute('href', 'https://x/shot');
  });

  it('shows a loading line until the URL is signed', () => {
    hookResult = { url: null, loading: true, error: null };
    render(<LovelyFeedbackPhoto path="u1/shot.png" />);
    expect(screen.getByText('Loading photo…')).toBeInTheDocument();
  });

  it('shows the error instead of an image when signing fails', () => {
    hookResult = { url: null, loading: false, error: "Couldn't load photos (400): `bucket` must be one of: damage-photos" };
    render(<LovelyFeedbackPhoto path="u1/shot.png" />);
    expect(screen.getByText(/Photo unavailable\./)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });
});
