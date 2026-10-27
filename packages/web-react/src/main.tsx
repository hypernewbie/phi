import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createConnectionService } from './platform/http.ts';
import './styles/tokens.css';
import './styles/global.css';

const host = document.getElementById('root');
if (!host) throw new Error('The application root is missing.');

createRoot(host).render(
    <StrictMode>
        <App service={createConnectionService()} />
    </StrictMode>,
);
