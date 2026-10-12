import React from 'react';

export function Nav({ activeTab, setActiveTab }) {
  return (
    <header className="app-header">
      <div
        className="brand-lockup"
        onClick={() => setActiveTab('overview')}
      >
        <img
          className="brand-mark"
          src="/breadcrumbs-icon.svg"
          alt=""
          width="30"
          height="30"
        />
        <span className="brand-wordmark">breadcrumbs</span>
      </div>
      <nav className="main-nav">
        <button
          className={`nav-button ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </button>
        <button
          className={`nav-button ${activeTab === 'products' || activeTab === 'product-detail' ? 'active' : ''}`}
          onClick={() => setActiveTab('products')}
        >
          Products
        </button>
        <button
          className={`nav-button ${activeTab === 'import' ? 'active' : ''}`}
          onClick={() => setActiveTab('import')}
        >
          Import
        </button>
      </nav>
    </header>
  );
}
