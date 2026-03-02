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
    const label = theme === 'light' ? '💡 Dark' : '💡 Light';
    const emojiOnly = theme === 'light' ? '💡' : '💡';
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
            className="theme-toggle"
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onClick={handleClick}
            aria-label={label}
        >
            <span className="theme-toggle-text">{label}</span>
            <span className="theme-toggle-emoji">{emojiOnly}</span>
        </button>
    );
};

export default ThemeToggle;
