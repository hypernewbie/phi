import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createAuthSession } from './platform/auth-session.ts';
import { createConnectionService } from './platform/http.ts';
import { createServerStateAdapter } from './platform/server-state.ts';
import './styles/tokens.css';
import './styles/global.css';

const host = document.getElementById('root');
if (!host) throw new Error('The application root is missing.');

const session = createAuthSession(
    createConnectionService(),
    createServerStateAdapter(),
);

createRoot(host).render(
    <StrictMode>
        <App session={session} />
    </StrictMode>,
);
