/**
 * @file main.tsx
 * Application entry point mounting the single React 18 concurrent root (`createRoot`)
 * and importing the global Tailwind telemetry stylesheet (`./index.css`).
 *
 * Why this architecture over alternatives:
 * - Mounting a single top-level `<App />` root preserves shared simulation refs, WebGL context,
 *   and Pointer Lock listeners across route/tab switches without teardown. Splitting screens into
 *   separate React roots or portal trees would break synchronous ref sharing between the 3D engine
 *   and HUD sidebars and trigger WebGL context loss or flicker when switching tabs.
 * - Loading `./index.css` once at the root ensures Tailwind layers and custom utility classes
 *   (e.g., `.combat-cursor-locked` cursor suppression and `.chamfer-sm` geometry) are present
 *   before the first paint rather than asynchronously injecting per-component CSS files.
 */
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Non-null assertion is safe because index.html statically declares `<div id="root">`.
createRoot(document.getElementById('root')!).render(<App />);
