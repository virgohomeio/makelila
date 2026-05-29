import {
  DRY_SOIL_LOW_HUMIDITY,
  type LiveData,
  type ParsedEvent,
  RecordType,
  WET_SOIL_HUMIDITY,
  STATUS_COLORS,
} from './dashboard';

const PART_COLORS: Record<string, string> = {
  LeftPadHeater: '#d62728',
  RightPadHeater: '#2ca02c',
  'Start-up': '#9467bd',
  'Sanitization Sequence': '#17becf',
  InternalBlower: '#e377c2',
  IntakeFan: '#8c564b',
};

const PREFERRED_ORDER = [
  'InternalBlower',
  'IntakeFan',
  'Start-up',
  'Sanitization Sequence',
  'Base',
  'LeftPadHeater',
  'RightPadHeater',
];

const STATE_AXIS = {
  range: [-0.1, 2.1],
  tickmode: 'array',
  tickvals: [0, 1, 2],
  ticktext: ['OFF', 'ON', 'ERROR'],
};

const BASE_LAYOUT = {
  margin: { t: 30, b: 40, l: 60, r: 30 },
  hovermode: 'x unified',
  font: { size: 11 },
  paper_bgcolor: 'white',
  plot_bgcolor: '#fafafa',
  showlegend: true,
  legend: { orientation: 'h', y: -0.18 },
};

interface ChartSpec {
  title: string;
  data: Record<string, unknown>[];
  layout: Record<string, unknown>;
}

// ── Step extension to "now" ──────────────────────────────────────────────────

function extendToNow(events: ParsedEvent[]): { x: Date[]; y: number[] } {
  if (!events.length) return { x: [], y: [] };
  const x: Date[] = events.map((e) => e.timestamp);
  const y: number[] = events.map((e) => e.state);
  const now = new Date();
  const last = events[events.length - 1];
  if (now.getTime() - last.timestamp.getTime() < 3_600_000) {
    x.push(now);
    y.push(last.state);
  }
  return { x, y };
}

// ── Events plot — one chart per part ─────────────────────────────────────────

export function buildEventCharts(events: ParsedEvent[]): ChartSpec[] {
  if (!events.length) return [];

  const grouped: Record<string, ParsedEvent[]> = {};
  for (const ev of events) {
    (grouped[ev.partName] ??= []).push(ev);
  }

  const leftMotor = grouped['LeftChamberMotor'] ?? [];
  const rightMotor = grouped['RightChamberMotor'] ?? [];
  delete grouped['LeftChamberMotor'];
  delete grouped['RightChamberMotor'];

  const charts: ChartSpec[] = [];

  if (leftMotor.length || rightMotor.length) {
    const motorTraces: Record<string, unknown>[] = [];
    for (const [name, list, color] of [
      ['LeftChamberMotor', leftMotor, '#1f77b4'],
      ['RightChamberMotor', rightMotor, '#ff7f0e'],
    ] as const) {
      if (!list.length) continue;
      const { x, y } = extendToNow(list);
      motorTraces.push({
        type: 'scatter',
        mode: 'lines',
        name,
        x,
        y,
        line: { shape: 'hv', width: 2, color },
        fill: 'tozeroy',
        fillcolor: `${color}33`,
        hovertemplate: `<b>${name}</b><br>%{x}<br>State: %{y}<extra></extra>`,
      });
    }
    charts.push({
      title: 'Chamber Motors (Left & Right)',
      data: motorTraces,
      layout: {
        ...BASE_LAYOUT,
        yaxis: STATE_AXIS,
        xaxis: { title: { text: 'Time' } },
      },
    });
  }

  const ordered = Object.keys(grouped).sort((a, b) => {
    const ai = PREFERRED_ORDER.indexOf(a);
    const bi = PREFERRED_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  for (const part of ordered) {
    const list = grouped[part];
    if (!list.length) continue;
    const color = PART_COLORS[part] ?? '#1f77b4';
    const { x, y } = extendToNow(list);
    charts.push({
      title: part,
      data: [
        {
          type: 'scatter',
          mode: 'lines',
          name: part,
          x,
          y,
          line: { shape: 'hv', width: 2, color },
          fill: 'tozeroy',
          fillcolor: `${color}33`,
          showlegend: false,
          hovertemplate: `<b>${part}</b><br>%{x}<br>State: %{y}<extra></extra>`,
        },
      ],
      layout: {
        ...BASE_LAYOUT,
        yaxis: STATE_AXIS,
        xaxis: { title: { text: 'Time' } },
      },
    });
  }

  return charts;
}

// ── Live-data charts ─────────────────────────────────────────────────────────

export function buildCurrentsChart(liveData: LiveData): ChartSpec | null {
  const samples = liveData[RecordType.Current];
  if (!samples.length) return null;
  const x = samples.map((s) => s.timestamp);
  return {
    title: 'Currents (Amps)',
    data: (['AcCurrent', 'LeftMotorCurrent', 'RightMotorCurrent'] as const).map((field) => ({
      type: 'scatter',
      mode: 'lines',
      name: field,
      x,
      y: samples.map((s) => s.data[field] ?? null),
      line: { width: 2 },
      hovertemplate: `<b>${field}</b><br>%{x}<br>%{y:.3f} A<extra></extra>`,
    })),
    layout: {
      ...BASE_LAYOUT,
      yaxis: { title: { text: 'Amps' } },
    },
  };
}

export function buildTemperaturesChart(liveData: LiveData): ChartSpec | null {
  const samples = liveData[RecordType.Temperature];
  if (!samples.length) return null;
  const x = samples.map((s) => s.timestamp);
  const fields = [
    'LeftPadTemperature',
    'RightPadTemperature',
    'IntakeTemperature',
    'InternalTemperature',
    'InnerShellTemperature',
    'BlowerPwm',
  ] as const;
  return {
    title: 'Temperatures (°C) & Blower PWM',
    data: fields.map((field) => ({
      type: 'scatter',
      mode: 'lines',
      name: field,
      x,
      y: samples.map((s) => s.data[field] ?? null),
      line: { width: 2 },
      hovertemplate: `<b>${field}</b><br>%{x}<br>%{y}<extra></extra>`,
    })),
    layout: {
      ...BASE_LAYOUT,
      yaxis: { title: { text: '°C / PWM' } },
    },
  };
}

export function buildMachineHealthChart(liveData: LiveData): ChartSpec | null {
  const samples = liveData[RecordType.MachineHealth];
  if (!samples.length) return null;
  const x = samples.map((s) => s.timestamp);
  return {
    title: 'Machine State & RSSI',
    data: [
      {
        type: 'scatter',
        mode: 'lines',
        name: 'ErrorCode',
        x,
        y: samples.map((s) => s.data.error_code ?? null),
        line: { width: 2, color: '#e74c3c' },
      },
      {
        type: 'scatter',
        mode: 'lines',
        name: 'State',
        x,
        y: samples.map((s) => s.data.state ?? null),
        line: { width: 2, color: '#27ae60' },
      },
      {
        type: 'scatter',
        mode: 'lines',
        name: 'RSSI (dBm)',
        x,
        y: samples.map((s) => s.data.rssi ?? null),
        yaxis: 'y2',
        line: { width: 2, color: '#3498db' },
      },
    ],
    layout: {
      ...BASE_LAYOUT,
      yaxis: { title: { text: 'ErrorCode / State' } },
      yaxis2: {
        title: { text: 'RSSI (dBm)' },
        overlaying: 'y',
        side: 'right',
        showgrid: false,
      },
    },
  };
}

// ── BME humidity (the most operationally useful chart) ───────────────────────

function anomalyShapes(x: Date[], y: (number | null)[]): Record<string, unknown>[] {
  const shapes: Record<string, unknown>[] = [];
  let bandStart: Date | null = null;
  let bandKind: 'DRY' | 'WET' | null = null;

  const flush = (end: Date) => {
    if (bandStart && bandKind) {
      shapes.push({
        type: 'rect',
        xref: 'x',
        yref: 'paper',
        x0: bandStart,
        x1: end,
        y0: 0,
        y1: 1,
        fillcolor: bandKind === 'DRY' ? STATUS_COLORS.DRY_SOIL : STATUS_COLORS.SOAKED_SOIL,
        opacity: 0.12,
        line: { width: 0 },
        layer: 'below',
      });
    }
  };

  for (let i = 0; i < x.length; i++) {
    const h = y[i];
    let kind: 'DRY' | 'WET' | null = null;
    if (h != null && h < DRY_SOIL_LOW_HUMIDITY) kind = 'DRY';
    else if (h != null && h > WET_SOIL_HUMIDITY) kind = 'WET';
    if (kind !== bandKind) {
      if (bandKind) flush(x[i]);
      bandKind = kind;
      bandStart = kind ? x[i] : null;
    }
  }
  if (bandKind && bandStart) flush(x[x.length - 1] ?? new Date());

  return shapes;
}

export function buildBmeHumidityChart(liveData: LiveData): ChartSpec | null {
  const left = liveData[RecordType.BmeLeft];
  const right = liveData[RecordType.BmeRight];
  if (!left.length && !right.length) return null;

  const xLeft = left.map((s) => s.timestamp);
  const yLeft = left.map((s) => (s.data.Humidity > 5 ? s.data.Humidity : null));
  const xRight = right.map((s) => s.timestamp);
  const yRight = right.map((s) => (s.data.Humidity > 5 ? s.data.Humidity : null));

  // Use whichever sensor has more samples as the anomaly source
  const [shapeX, shapeY] = xLeft.length >= xRight.length ? [xLeft, yLeft] : [xRight, yRight];

  return {
    title: 'BME Humidity (%)',
    data: [
      {
        type: 'scatter',
        mode: 'lines',
        name: 'Left',
        x: xLeft,
        y: yLeft,
        line: { width: 2, color: '#1f77b4' },
        connectgaps: false,
      },
      {
        type: 'scatter',
        mode: 'lines',
        name: 'Right',
        x: xRight,
        y: yRight,
        line: { width: 2, color: '#ff7f0e' },
        connectgaps: false,
      },
    ],
    layout: {
      ...BASE_LAYOUT,
      yaxis: { title: { text: '%RH' }, range: [0, 100] },
      shapes: anomalyShapes(shapeX, shapeY),
    },
  };
}

export function buildBmeTemperatureChart(liveData: LiveData): ChartSpec | null {
  const left = liveData[RecordType.BmeLeft];
  const right = liveData[RecordType.BmeRight];
  if (!left.length && !right.length) return null;
  return {
    title: 'BME Temperature (°C)',
    data: [
      {
        type: 'scatter',
        mode: 'lines',
        name: 'Left',
        x: left.map((s) => s.timestamp),
        y: left.map((s) => (s.data.Temperature ? s.data.Temperature : null)),
        line: { width: 2, color: '#1f77b4' },
      },
      {
        type: 'scatter',
        mode: 'lines',
        name: 'Right',
        x: right.map((s) => s.timestamp),
        y: right.map((s) => (s.data.Temperature ? s.data.Temperature : null)),
        line: { width: 2, color: '#ff7f0e' },
      },
    ],
    layout: {
      ...BASE_LAYOUT,
      yaxis: { title: { text: '°C' } },
    },
  };
}
