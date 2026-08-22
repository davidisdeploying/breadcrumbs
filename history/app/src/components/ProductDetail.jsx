import React, { useState, useEffect } from 'react';
import { SvgPriceChart } from './SvgPriceChart.jsx';

function formatCents(cents) {
  if (cents == null) return '-';
  return `$${(cents / 100).toFixed(2)}`;
}

export function ProductDetail({ productId, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchDetail = async () => {
      try {
        const res = await fetch(`/api/products/${productId}`);
        if (!res.ok) throw new Error('Product not found');
        const json = await res.json();
        setData(json);
      } catch (err) {
        console.error('Failed to fetch product detail:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchDetail();
  }, [productId]);

  if (loading) {
    return <div className="card" style={{ textAlign: 'center', padding: '40px' }}>Loading product details...</div>;
  }

  if (!data || !data.product) {
    return (
      <div className="card">
        <h2>Product not found</h2>
        <button className="btn btn-secondary" onClick={onBack} style={{ marginTop: '16px' }}>
          Back to Products
        </button>
      </div>
    );
  }

  const { product, observations, alerts } = data;
  const isVariableWeight = product.price_basis === 'variable_weight';
  const hasBothBases =
    observations.some((o) => o.unit_basis === 'package') &&
    observations.some((o) => o.unit_basis === 'weight_each');

  return (
    <div>
      <div style={{ marginBottom: '16px' }}>
        <button className="btn btn-secondary btn-sm" onClick={onBack}>
          &larr; Back to Products
        </button>
      </div>

      <div className="card">
        <div className="eyebrow">Product History & Price Observations</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px' }}>
          <div>
            <h1>{product.name_raw}</h1>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
              <span className={`badge badge-${isVariableWeight ? 'variable' : 'fixed'}`}>
                {product.price_basis}
              </span>
              {product.size_qty && (
                <span className="badge badge-info">
                  {product.size_qty} {product.size_unit}
                </span>
              )}
            </div>
          </div>

          <div style={{ textAlign: 'right' }}>
            <div className="eyebrow">Median Price</div>
            <div className="mono-price" style={{ fontSize: '28px' }}>
              {formatCents(product.median_paid_unit_cents)}
            </div>
          </div>
        </div>

        {/* Explicit banner for variable_weight products */}
        {isVariableWeight && (
          <div className="banner-note">
            priced by weight — each observation is a per-unit price, and only same-basis observations are compared.
          </div>
        )}

        {/* Caution banner when unit basis changed */}
        {hasBothBases && (
          <div className="banner-note" style={{ marginTop: '8px', borderLeft: '4px solid var(--high)' }}>
            <strong>Caution:</strong> Unit basis changed across purchases (mix of per-package and per-weight observations). Only same-basis observations are compared.
          </div>
        )}

        {/* Hand-drawn SVG Price Chart */}
        <div style={{ marginTop: '24px' }}>
          <div className="eyebrow">Paid Unit Price History (Space Mono Reference Lines)</div>
          <SvgPriceChart
            observations={observations}
            minCents={product.min_paid_unit_cents}
            medianCents={product.median_paid_unit_cents}
            maxCents={product.max_paid_unit_cents}
          />
        </div>

        {/* Alert History Section */}
        {alerts && alerts.length > 0 && (
          <div style={{ marginTop: '32px' }}>
            <div className="eyebrow">Price Alerts Raised for this Item</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
              {alerts.map((a) => (
                <div key={a.id} className="alert-item">
                  <span className={`badge badge-${a.severity}`}>
                    {a.severity} +{a.delta_pct.toFixed(1)}%
                  </span>
                  <div className="alert-detail" style={{ flex: 1, marginLeft: '12px' }}>
                    Paid <span className="mono-price">{formatCents(a.paid_unit_cents)}</span> vs. {a.baseline_kind === 'regular_p75' ? 'regular price' : 'typical price'} <span className="mono-price">{formatCents(a.baseline_cents)}</span> on {a.raised_on}
                  </div>
                  {a.acknowledged_at ? (
                    <span className="badge badge-green">Acked</span>
                  ) : (
                    <span className="badge badge-high">Unacked</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Observations Table */}
        <div style={{ marginTop: '32px' }}>
          <div className="eyebrow">All Recorded Purchase Observations ({observations.length})</div>
          <div className="table-wrapper" style={{ marginTop: '12px' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Order ID</th>
                  <th>Qty</th>
                  <th>Line Total</th>
                  <th>Paid Unit Price</th>
                  <th>Basis</th>
                  <th>Captured Shelf Price</th>
                  <th>Order Link</th>
                </tr>
              </thead>
              <tbody>
                {observations.map((obs) => (
                  <tr key={obs.id}>
                    <td className="mono-price">{obs.observed_on}</td>
                    <td className="mono-price" style={{ fontSize: '13px' }}>{obs.order_id}</td>
                    <td className="mono-price">{obs.qty}</td>
                    <td className="mono-price">{formatCents(obs.line_total_cents)}</td>
                    <td className="mono-price" style={{ fontWeight: 'bold' }}>
                      {/* paid_unit_cents = Math.round(line_total_cents / qty) is the ONLY authoritative price signal. */}
                      {formatCents(obs.paid_unit_cents)}
                    </td>
                    <td>
                      <span className={`badge badge-${obs.unit_basis === 'weight_each' ? 'variable' : 'info'}`}>
                        {obs.unit_basis || 'package'}
                      </span>
                    </td>
                    <td className="mono-price" style={{ opacity: 0.7 }}>
                      {obs.page_price_cents ? formatCents(obs.page_price_cents) : '-'}
                      {obs.page_promo_flag === 1 && ' (promo)'}
                    </td>
                    <td>
                      {obs.order_url ? (
                        <a
                          href={obs.order_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: 'var(--ink)', fontFamily: 'Space Mono', fontSize: '13px' }}
                        >
                          View Order &rarr;
                        </a>
                      ) : (
                        <span style={{ color: 'var(--line)', fontFamily: 'Space Mono', fontSize: '13px' }}>
                          No URL
                        </span>
                      )}
                    </td>
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
