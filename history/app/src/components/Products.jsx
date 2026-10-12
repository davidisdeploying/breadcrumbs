import React, { useState, useEffect } from 'react';

function formatCents(cents) {
  if (cents == null) return '-';
  return `$${(cents / 100).toFixed(2)}`;
}

export function Products({ onSelectProduct }) {
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('purchases');
  const [loading, setLoading] = useState(true);

  const fetchProducts = async () => {
    try {
      const res = await fetch(`/api/products?sort=${sort}&search=${encodeURIComponent(search)}`);
      const data = await res.json();
      setProducts(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('Failed to fetch products:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProducts();
  }, [sort, search]);

  return (
    <div className="card">
      <div className="eyebrow">Product Catalog & Price Trends</div>
      <h1>Products</h1>

      {/* Controls Bar */}
      <div className="controls-bar">
        <input
          type="text"
          className="search-input"
          placeholder="Search by product name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="select-input"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="purchases">Sort by: Times Bought</option>
          <option value="name">Sort by: Name</option>
          <option value="latest_price">Sort by: Latest Price</option>
          <option value="trend">Sort by: Price Trend %</option>
        </select>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px' }}>Loading products...</div>
      ) : products.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--crust)' }}>
          No products matching your search.
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Product Name</th>
                <th>Purchases</th>
                <th>Latest</th>
                <th>Median</th>
                <th>Min / Max</th>
                <th>Trend</th>
                <th>Basis</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => {
                const trendVal = p.trend_pct || 0;
                let trendBadgeClass = 'badge-info';
                if (trendVal > 5) trendBadgeClass = 'badge-high';
                else if (trendVal < -2) trendBadgeClass = 'badge-green';

                return (
                  <tr
                    key={p.id}
                    className="clickable-row"
                    onClick={() => onSelectProduct(p.id)}
                  >
                    <td style={{ fontWeight: 600 }}>{p.name_raw}</td>
                    <td className="mono-price">{p.obs_count}</td>
                    <td className="mono-price">{formatCents(p.latest_paid_unit_cents)}</td>
                    <td className="mono-price">{formatCents(p.median_paid_unit_cents)}</td>
                    <td className="mono-price">
                      {formatCents(p.min_paid_unit_cents)} / {formatCents(p.max_paid_unit_cents)}
                    </td>
                    <td>
                      {p.obs_count >= 2 ? (
                        <span className={`badge ${trendBadgeClass}`}>
                          {trendVal > 0 ? `+${trendVal.toFixed(1)}%` : `${trendVal.toFixed(1)}%`}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--crust)', fontSize: '13px' }}>1 obs</span>
                      )}
                    </td>
                    <td>
                      <span className={`badge badge-${p.price_basis === 'variable_weight' ? 'variable' : 'fixed'}`}>
                        {p.price_basis}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
