import React, { useState } from 'react';

function formatCents(cents) {
  if (cents == null) return '$0.00';
  return `$${(cents / 100).toFixed(2)}`;
}

export function ImportView({ onImportSuccess }) {
  const [file, setFile] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!file) return;

    setImporting(true);
    setError(null);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        body: formData,
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Import failed');
      }

      setResult(json);
      if (onImportSuccess) onImportSuccess();
    } catch (err) {
      setError(err.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="card">
      <div className="eyebrow">Data Import & Kroger Order Ingestion</div>
      <h1>Import Breadcrumbs JSON</h1>
      <p style={{ color: 'var(--char)', marginBottom: '24px' }}>
        Upload itemized Kroger order JSON exported by the breadcrumbs Chrome extension.
      </p>

      <form onSubmit={handleSubmit}>
        <div
          className={`dropzone ${dragActive ? 'active' : ''}`}
          onDragEnter={handleDrag}
          onDragOver={handleDrag}
          onDragLeave={handleDrag}
          onDrop={handleDrop}
          onClick={() => document.getElementById('file-input').click()}
        >
          <input
            id="file-input"
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={handleFileChange}
          />
          <div className="eyebrow">File Upload</div>
          {file ? (
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: 'var(--ink)' }}>
              Selected file: <span className="mono-price">{file.name}</span> ({Math.round(file.size / 1024)} KB)
            </div>
          ) : (
            <div>
              <div style={{ fontSize: '18px', fontWeight: 'bold', color: 'var(--ink)' }}>
                Drag & Drop breadcrumbs-orders.json here
              </div>
              <div style={{ fontSize: '14px', color: 'var(--crust)', marginTop: '6px' }}>
                or click to browse your computer
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: '24px', display: 'flex', gap: '12px' }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!file || importing}
          >
            {importing ? 'Importing orders...' : 'Process Import'}
          </button>

          {file && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => { setFile(null); setResult(null); setError(null); }}
            >
              Clear File
            </button>
          )}
        </div>
      </form>

      {error && (
        <div className="banner-note" style={{ borderColor: 'var(--high)', background: 'rgba(226, 35, 26, 0.1)', color: 'var(--high)', marginTop: '24px' }}>
          <strong>Import Error:</strong> {error}
        </div>
      )}

      {result && (
        <div className="card card-cream" style={{ marginTop: '28px' }}>
          <div className="eyebrow">Import Batch #{result.batch_id} Summary</div>

          <div className="stats-grid" style={{ marginTop: '12px' }}>
            <div className="stat-card">
              <div className="eyebrow">Total Orders</div>
              <div className="stat-value">{result.order_count}</div>
            </div>
            <div className="stat-card">
              <div className="eyebrow">New Orders</div>
              <div className="stat-value">{result.new_order_count}</div>
            </div>
            <div className="stat-card">
              <div className="eyebrow">Total Line Items</div>
              <div className="stat-value">{result.item_count}</div>
            </div>
            <div className="stat-card">
              <div className="eyebrow">Duplicate Lines Ignored</div>
              <div className="stat-value">{result.duplicate_count}</div>
            </div>
          </div>

          {result.alerts && result.alerts.length > 0 ? (
            <div style={{ marginTop: '20px' }}>
              <div className="eyebrow">Price Spike Alerts Triggered ({result.alerts.length})</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                {result.alerts.map((alert) => (
                  <div key={alert.id} className="alert-item">
                    <span className={`badge badge-${alert.severity}`}>
                      {alert.severity} +{alert.delta_pct.toFixed(1)}%
                    </span>
                    <div className="alert-detail" style={{ flex: 1, marginLeft: '12px' }}>
                      Paid <span className="mono-price">{formatCents(alert.paid_unit_cents)}</span> vs. {alert.baseline_kind === 'regular_p75' ? 'regular price' : 'typical price'} <span className="mono-price">{formatCents(alert.baseline_cents)}</span> (n={alert.baseline_n})
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ marginTop: '16px', color: 'var(--crust)', fontSize: '15px' }}>
              No price spike alerts were raised in this batch.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
