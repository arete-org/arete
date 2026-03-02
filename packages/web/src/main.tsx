/**
 * @description: Boots the Footnote web application and mounts the router and theme providers into the browser root.
 * @footnote-scope: web
 * @footnote-module: WebAppEntry
 * @footnote-risk: medium - Broken bootstrapping can blank the site or disable global providers.
 * @footnote-ethics: medium - Entry wiring controls whether users can reach the interface and its transparency features.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider } from './theme';
import '@styles/global.css';

// Attach React to the root element with the ThemeProvider so the toggle can adjust document styles.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
        <ThemeProvider>
            <BrowserRouter>
                <App />
            </BrowserRouter>
        </ThemeProvider>
    </React.StrictMode>
);
