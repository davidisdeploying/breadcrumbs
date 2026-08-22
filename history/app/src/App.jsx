import React, { useState } from 'react';
import { Nav } from './components/Nav.jsx';
import { Overview } from './components/Overview.jsx';
import { Products } from './components/Products.jsx';
import { ProductDetail } from './components/ProductDetail.jsx';
import { ImportView } from './components/ImportView.jsx';

export function App() {
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedProductId, setSelectedProductId] = useState(null);

  const handleSelectProduct = (id) => {
    setSelectedProductId(id);
    setActiveTab('product-detail');
  };

  const handleBackToProducts = () => {
    setSelectedProductId(null);
    setActiveTab('products');
  };

  return (
    <div className="container">
      <Nav activeTab={activeTab} setActiveTab={setActiveTab} />

      <main>
        {activeTab === 'overview' && (
          <Overview onSelectProduct={handleSelectProduct} />
        )}
        {activeTab === 'products' && (
          <Products onSelectProduct={handleSelectProduct} />
        )}
        {activeTab === 'product-detail' && selectedProductId && (
          <ProductDetail
            productId={selectedProductId}
            onBack={handleBackToProducts}
          />
        )}
        {activeTab === 'import' && (
          <ImportView onImportSuccess={() => setActiveTab('overview')} />
        )}
      </main>
    </div>
  );
}
