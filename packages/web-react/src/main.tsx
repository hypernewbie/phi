import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { createAuthSession } from './platform/auth-session.ts';
import {
    appearanceOwner,
    readAppearanceScope,
} from './platform/appearance-scope.ts';
import { createConnectionService } from './platform/http.ts';
import {
    MobileAppearanceStore,
    createIndexedDBDraftStore,
    createLocalStorageCache,
    createOnlineProbe,
} from './platform/mobile-appearance-store.ts';
import { directUpstreamOrigin } from './platform/legacy-handoff.ts';
import { createServerStateAdapter } from './platform/server-state.ts';
import { createSettingsStore } from './platform/settings-store.ts';
import './styles/tokens.css';
import './styles/global.css';

const host = document.getElementById('root');
if (!host) throw new Error('The application root is missing.');

const directUpstream = directUpstreamOrigin();
const http = createConnectionService(undefined, directUpstream);
const session = createAuthSession(
    http,
    createServerStateAdapter(undefined, directUpstream),
);
const mobileScope = readAppearanceScope();
const mobile =
    mobileScope === null
        ? null
        : new MobileAppearanceStore({
              http,
              bearer: () => session.bearer(),
              owner: appearanceOwner(mobileScope),
              storage: createIndexedDBDraftStore(),
              cache: createLocalStorageCache() ?? undefined,
              isOnline: createOnlineProbe(),
          });

const settings = createSettingsStore(
    http,
    () => session.bearer(),
    undefined,
    undefined,
    undefined,
    {
        protection: () => session.view().protection,
        adoptBundle: (bundle) => session.adoptBundle(bundle),
        // Clearing drops the credential: re-check into disabled mode.
        accessDisabled: () => session.retry(),
    },
);

createRoot(host).render(
    <StrictMode>
        <App session={session} settings={settings} mobile={mobile} />
    </StrictMode>,
);
