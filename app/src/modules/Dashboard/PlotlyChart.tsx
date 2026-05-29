import { useEffect, useRef } from 'react';
import Plotly from 'plotly.js-basic-dist-min';

interface Props {
  data: Record<string, unknown>[];
  layout?: Record<string, unknown>;
  height?: number;
}

export default function PlotlyChart({ data, layout, height = 280 }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    Plotly.react(el, data, layout ?? {}, {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ['lasso2d', 'select2d'],
    });
  }, [data, layout]);

  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el) Plotly.purge(el);
    };
  }, []);

  return <div ref={ref} style={{ width: '100%', height }} />;
}
