import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { useStore } from './store';
import './styles.css';

document.documentElement.dataset.theme = useStore.getState().theme;
if ((window as any).desktop) document.documentElement.classList.add('desktop');
useStore.getState().init();
(window as any).__store = useStore; // debugging aid
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
