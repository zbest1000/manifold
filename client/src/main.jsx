import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import App from './App.jsx';
import AuthGate from './components/AuthGate.jsx';
import { initRealtime } from './store/store';
import './index.css';

initRealtime();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthGate>
        <App />
      </AuthGate>
      <Toaster
        position="bottom-right"
        toastOptions={{
          duration: 3500,
          style: {
            background: 'rgb(var(--overlay))',
            color: 'rgb(var(--text))',
            border: '1px solid rgb(var(--border-strong))',
            borderRadius: '6px',
            boxShadow: '0 12px 32px -10px rgb(0 0 0 / 0.35)',
            fontSize: '13px',
            padding: '8px 12px'
          },
          success: { iconTheme: { primary: 'rgb(var(--good))', secondary: 'rgb(var(--overlay))' } },
          error: { iconTheme: { primary: 'rgb(var(--bad))', secondary: 'rgb(var(--overlay))' } }
        }}
      />
    </BrowserRouter>
  </React.StrictMode>
);
