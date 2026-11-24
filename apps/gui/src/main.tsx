import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { App } from './App.tsx';
import { createApi, type InvokeFn } from './api.ts';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root element');

createRoot(root).render(
  <StrictMode>
    <App api={createApi(invoke as InvokeFn)} />
  </StrictMode>,
);
