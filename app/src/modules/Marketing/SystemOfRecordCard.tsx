const DATA_OWNERSHIP = [
  { entity: 'Customer name / email / phone', owner: 'makelila', source: 'HubSpot (insert only)' },
  { entity: 'Customer stage', owner: 'makelila', source: 'Operators' },
  { entity: 'Lead attribution source', owner: 'makelila', source: 'HubSpot / Shopify UTM' },
  { entity: 'Orders', owner: 'makelila', source: 'Shopify' },
  { entity: 'Fulfillment status', owner: 'makelila', source: 'Operators' },
  { entity: 'Returns / Refunds', owner: 'makelila', source: 'Operators / Customer forms' },
  { entity: 'Deal stage', owner: 'makelila', source: 'Orders (not HubSpot deals)' },
  { entity: 'Email campaigns', owner: 'Klaviyo', source: 'makelila profiles sync' },
  { entity: 'Ad performance', owner: 'Facebook', source: 'CAPI + Ads API sync' },
  { entity: 'Activity log', owner: 'makelila', source: 'All mutations' },
];

export function SystemOfRecordCard() {
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-ink-muted)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 12 }}>
        System of Record
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: 'var(--color-ink-subtle)', fontSize: 11 }}>
            <th style={{ textAlign: 'left', paddingBottom: 8 }}>Data Type</th>
            <th style={{ textAlign: 'left' }}>Owner</th>
            <th style={{ textAlign: 'left' }}>Source</th>
          </tr>
        </thead>
        <tbody>
          {DATA_OWNERSHIP.map((row, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--color-border)' }}>
              <td style={{ padding: '7px 0', color: 'var(--color-ink)' }}>{row.entity}</td>
              <td>
                <span style={{
                  fontSize: 10, padding: '2px 8px', borderRadius: 4, fontWeight: 700,
                  background: row.owner === 'makelila' ? '#ebf8ff' : 'var(--color-surface)',
                  color: row.owner === 'makelila' ? '#2c5282' : 'var(--color-ink-muted)',
                  border: `1px solid ${row.owner === 'makelila' ? '#90cdf4' : 'var(--color-border)'}`,
                }}>
                  {row.owner}
                </span>
              </td>
              <td style={{ color: 'var(--color-ink-subtle)', paddingLeft: 8 }}>{row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
