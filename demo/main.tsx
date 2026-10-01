import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import hypothesis from '../hypothesis.json';
import { App } from '../examples/shared/App';
import { createDemoAdapter } from '../examples/shared/demo-adapter';
import { localBackend } from '../examples/shared/local-backend';
import '../src/skin/default.css';
import '../examples/shared/app.css';

const backend = localBackend({
  config: {
    title: 'Open Sourced Learning',
    modelLabel: 'stand-in (no model running)',
    demo: true,
    hypothesis,
    autoStart: true,
    editableFacts: false,
    note: 'A demo. The replies are written in advance, and nothing leaves this tab.',
  },
  adapter: createDemoAdapter({ hypothesis }),
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App backend={backend} />
  </StrictMode>,
);
