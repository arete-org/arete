/**
 * @description: Toggles the site theme and plays the associated UI sounds for the web header.
 * @footnote-scope: web
 * @footnote-module: ThemeToggle
 * @footnote-risk: low - Toggle issues affect presentation and polish but do not damage core data flows.
 * @footnote-ethics: low - Theme controls influence accessibility and comfort, not sensitive decision-making.
 */

import { useTheme } from '../theme';
import { useRef } from 'react';

// Button used in the header to switch between light and dark modes.
const ThemeToggle = (): JSX.Element => {
    const { theme, toggleTheme } = useTheme();
    const label =
        theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
    const icon =
        theme === 'light' ? (
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
            >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
        ) : (
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
            >
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
        );
    const mouseDownTimeRef = useRef(0);
    const hasToggledRef = useRef(false);
    const minClickInterval = 150; // Minimum time between clicks in milliseconds

    const playClickSoundDown = () => {
        const audio = new Audio('/assets/click_mouse_down.ogg');
        audio.volume = 0.7;

        audio.addEventListener('loadstart', () =>
            console.log('Audio loading started')
        );
        audio.addEventListener('canplay', () => console.log('Audio can play'));
        audio.addEventListener('error', (e) =>
            console.error('Audio error:', e)
        );

        audio.play().catch((error) => {
            console.warn('Could not play click sound:', error);
        });
    };

    const playClickSoundUp = () => {
        const audio = new Audio('/assets/click_mouse_up.ogg');
        audio.volume = 0.7;

        audio.addEventListener('loadstart', () =>
            console.log('Audio loading started')
        );
        audio.addEventListener('canplay', () => console.log('Audio can play'));
        audio.addEventListener('error', (e) =>
            console.error('Audio error:', e)
        );

        audio.play().catch((error) => {
            console.warn('Could not play click sound:', error);
        });
    };

    const playClickSound = () => {
        // For keyboard/touch events, play a random sound
        const audioFiles = [
            '/assets/click_mouse_down.ogg',
            '/assets/click_mouse_up.ogg',
        ];
        const randomFile =
            audioFiles[Math.floor(Math.random() * audioFiles.length)];

        const audio = new Audio(randomFile);
        audio.volume = 0.5;

        audio.addEventListener('loadstart', () =>
            console.log('Audio loading started')
        );
        audio.addEventListener('canplay', () => console.log('Audio can play'));
        audio.addEventListener('error', (e) =>
            console.error('Audio error:', e)
        );

        audio.play().catch((error) => {
            console.warn('Could not play click sound:', error);
        });
    };

    const handleMouseDown = () => {
        mouseDownTimeRef.current = Date.now();
        hasToggledRef.current = false; // Reset toggle flag
        playClickSoundDown(); // Always play down sound on mouse down
    };

    const handleMouseUp = () => {
        const timeSinceMouseDown = Date.now() - mouseDownTimeRef.current;

        // Only toggle theme if we haven't already toggled it
        if (!hasToggledRef.current) {
            toggleTheme();
            hasToggledRef.current = true;
        }

        // Always play up sound on mouse up with minimum delay between sounds
        if (timeSinceMouseDown < minClickInterval) {
            setTimeout(() => {
                playClickSoundUp();
            }, minClickInterval - timeSinceMouseDown);
        } else {
            playClickSoundUp();
        }
    };

    const handleClick = () => {
        // Handle keyboard (Enter/Space) and touch events
        // Only toggle if mouse events haven't already handled it
        if (!hasToggledRef.current) {
            toggleTheme();
            hasToggledRef.current = true;
            playClickSound(); // Only play sound if mouse events didn't handle it
        }
        // If mouse events already handled it, don't play sound to avoid double sound
    };

    return (
        <button
            type="button"
            className="theme-toggle theme-toggle--icon"
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onClick={handleClick}
            aria-label={label}
        >
            <span className="theme-toggle-icon">{icon}</span>
        </button>
    );
};

export default ThemeToggle;
