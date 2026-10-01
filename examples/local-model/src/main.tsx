import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../../shared/App';
import { httpBackend } from '../http-backend';
import '../../../src/skin/default.css';
import '../../shared/app.css';

const backend = await httpBackend();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App backend={backend} />
  </StrictMode>,
);
