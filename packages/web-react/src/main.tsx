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

// Phi-served builds talk same-origin, so the page origin is the server.
// Dev-proxy builds keep the baked phi origin for the guard header.
const directUpstream = __PHI_DIRECT_SERVE__
    ? window.location.origin
    : undefined;
const session = createAuthSession(
    createConnectionService(undefined, directUpstream),
    createServerStateAdapter(undefined, directUpstream),
);

createRoot(host).render(
    <StrictMode>
        <App session={session} />
    </StrictMode>,
);
