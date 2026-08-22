import React, { useState, useEffect } from 'react';

function formatCents(cents) {
  if (cents == null) return '$0.00';
  return `$${(cents / 100).toFixed(2)}`;
}

export function Overview({ onSelectProduct }) {
  const [summary, setSummary] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const [sumRes, alertRes] = await Promise.all([
        fetch('/api/summary'),
        fetch('/api/alerts?unacknowledged=true'),
      ]);
      const sumData = await sumRes.json();
      const alertData = await alertRes.json();

      setSummary(sumData);
      setAlerts(Array.isArray(alertData) ? alertData : []);
    } catch (err) {
      console.error('Failed to fetch overview data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleAck = async (id, e) => {
    e.stopPropagation();
    try {
      await fetch(`/api/alerts/${id}/ack`, { method: 'POST' });
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      console.error('Failed to acknowledge alert:', err);
    }
  };

  if (loading) {
    return <div className="card" style={{ textAlign: 'center', padding: '40px' }}>Loading overview...</div>;
  }

  const hasHighAlerts = alerts.some((a) => a.severity === 'high');

  return (
    <div>
      {/* 1. Alerts Panel at Top */}
      {alerts.length > 0 ? (
        <div className={`card alerts-banner ${hasHighAlerts ? 'has-high' : ''}`}>
          <div className="eyebrow">Price Spike Alerts ({alerts.length} Flagged)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '12px' }}>
            {alerts.map((alert) => (
              <div key={alert.id} className="alert-item">
                <div className="alert-info-col">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className={`badge badge-${alert.severity}`}>
                      {alert.severity} +{alert.delta_pct.toFixed(1)}%
                    </span>
                    <span
                      className="alert-title"
                      onClick={() => onSelectProduct(alert.product_id)}
                    >
                      {alert.name_raw}
                    </span>
                  </div>
                  <div className="alert-detail">
                    Paid <span className="mono-price">{formatCents(alert.paid_unit_cents)}</span> vs. {alert.baseline_kind === 'regular_p75' ? 'regular price' : 'typical price'} <span className="mono-price">{formatCents(alert.baseline_cents)}</span> (n={alert.baseline_n}) on {alert.raised_on}
                  </div>
                </div>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={(e) => handleAck(alert.id, e)}
                >
                  Acknowledge
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="card card-cream" style={{ marginBottom: '24px', padding: '16px 24px' }}>
          <div className="eyebrow" style={{ margin: 0 }}>No Unacknowledged Price Alerts</div>
        </div>
      )}

      {/* 2. Headline Stat Cards */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="eyebrow">Total Spend</div>
          <div className="stat-value mono">{formatCents(summary?.total_spend_cents)}</div>
        </div>
        <div className="stat-card">
          <div className="eyebrow">Orders</div>
          <div className="stat-value">{summary?.order_count ?? 0}</div>
        </div>
        <div className="stat-card">
          <div className="eyebrow">Products</div>
          <div className="stat-value">{summary?.product_count ?? 0}</div>
        </div>
        <div className="stat-card">
          <div className="eyebrow">Date Range</div>
          <div className="stat-value" style={{ fontSize: '18px', paddingTop: '6px' }}>
            {summary?.min_date && summary?.max_date
              ? `${summary.min_date} to ${summary.max_date}`
              : 'No orders yet'}
          </div>
        </div>
      </div>

      {/* 3. Monthly Spend Bar Chart */}
      {summary?.spend_by_month && summary.spend_by_month.length > 0 && (
        <div className="card">
          <div className="eyebrow">Monthly Spend History</div>
          <div style={{ width: '100%', height: '180px', marginTop: '16px' }}>
            <svg viewBox="0 0 800 160" style={{ width: '100%', height: '100%' }}>
              {(() => {
                const data = summary.spend_by_month;
                const maxSpend = Math.max(...data.map((d) => d.total_cents), 1);
                const barWidth = Math.max(16, Math.min(40, (700 / data.length) - 10));
                const gap = (750 - data.length * barWidth) / (data.length + 1);

                return data.map((d, i) => {
                  const barH = (d.total_cents / maxSpend) * 110;
                  const x = gap + i * (barWidth + gap);
                  const y = 130 - barH;

                  return (
                    <g key={d.month}>
                      <rect
                        x={x}
                        y={y}
                        width={barWidth}
                        height={barH}
                        fill="var(--ink)"
                        rx="4"
                      />
                      <title>{`${d.month}: ${formatCents(d.total_cents)}`}</title>
                      <text
                        x={x + barWidth / 2}
                        y={150}
                        textAnchor="middle"
                        fill="var(--char)"
                        fontFamily="Space Mono"
                        fontSize="10"
                      >
                        {d.month.slice(2)}
                      </text>
                    </g>
                  );
                });
              })()}
            </svg>
          </div>
        </div>
      )}

      {/* 4. Top Products Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '20px' }}>
        <div className="card">
          <div className="eyebrow">Top Products by Total Spend</div>
          <div className="table-wrapper" style={{ marginTop: '12px' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Spend</th>
                </tr>
              </thead>
              <tbody>
                {summary?.top_products_spend?.map((p) => (
                  <tr
                    key={p.id}
                    className="clickable-row"
                    onClick={() => onSelectProduct(p.id)}
                  >
                    <td>{p.name_raw}</td>
                    <td className="mono-price">{formatCents(p.total_spend_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="eyebrow">Most Frequently Purchased</div>
          <div className="table-wrapper" style={{ marginTop: '12px' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Times Bought</th>
                </tr>
              </thead>
              <tbody>
                {summary?.top_products_freq?.map((p) => (
                  <tr
                    key={p.id}
                    className="clickable-row"
                    onClick={() => onSelectProduct(p.id)}
                  >
                    <td>{p.name_raw}</td>
                    <td className="mono-price">{p.purchase_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
