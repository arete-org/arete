# Embedding ARETE

ARETE provides an embeddable version that can be integrated into external websites via iframe. The embed route includes the full header, title/subtitle, "I'm Arí" introduction section, and the interactive "Ask me anything" component.

## Embedding via iframe

### Basic Usage

Add the following iframe code to embed ARETE in your website:

```html
<iframe
    src="https://arete.fly.dev/embed"
    width="100%"
    height="800"
    frameborder="0"
    allow="clipboard-read; clipboard-write"
    title="ARETE - Ethics-first AI assistant"
></iframe>
```

### Responsive Sizing

For a responsive embed that adapts to different screen sizes, use CSS:

```html
<div
    style="position: relative; width: 100%; max-width: 1200px; margin: 0 auto;"
>
    <div
        style="position: relative; padding-bottom: 100%; height: 0; overflow: hidden;"
    >
        <iframe
            src="https://arete.fly.dev/embed"
            style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none;"
            allow="clipboard-read; clipboard-write"
            title="ARETE - Ethics-first AI assistant"
        ></iframe>
    </div>
</div>
```

Or with a fixed aspect ratio (recommended for better UX):

```html
<div
    style="position: relative; width: 100%; max-width: 1200px; margin: 0 auto; aspect-ratio: 16 / 10;"
>
    <iframe
        src="https://arete.fly.dev/embed"
        style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none;"
        allow="clipboard-read; clipboard-write"
        title="ARETE - Ethics-first AI assistant"
    ></iframe>
</div>
```

### Dynamic Height (No Scrollbar)

ARETE's embed automatically communicates its height to the parent window, allowing the iframe to resize dynamically and eliminate scrollbars. Add this script to your page to enable automatic resizing:

```html
<iframe
    id="arete-embed"
    src="https://arete.fly.dev/embed"
    width="100%"
    frameborder="0"
    allow="clipboard-read; clipboard-write"
    title="ARETE - Ethics-first AI assistant"
    style="border: none; width: 100%; min-height: 800px;"
></iframe>

<script>
    (function () {
        const iframe = document.getElementById('arete-embed');
        if (!iframe) {
            console.warn('ARETE embed: iframe element not found');
            return;
        }

        // Disable scrolling on iframe
        iframe.scrolling = 'no';
        iframe.style.overflow = 'hidden';

        // Listen for height messages from embed
        window.addEventListener('message', (event) => {
            // Optional: Validate origin for security (recommended in production)
            // if (event.origin !== 'https://arete.fly.dev') return;

            if (event.data && event.data.type === 'arete-embed-height') {
                const newHeight = event.data.height;
                if (newHeight && newHeight > 0) {
                    iframe.style.height = newHeight + 'px';
                    // Debug logging (remove in production)
                    // console.log('ARETE embed resized to:', newHeight + 'px');
                }
            }
        });

        // Fallback: Set initial height
        iframe.style.minHeight = '800px';
    })();
</script>
```

The embed will automatically adjust its height as content changes (e.g., when answers are displayed or the form expands).

### Recommended Height

If you're not using dynamic height, the embed route content typically requires a minimum height of **800px** to display all elements comfortably. For the best user experience, we recommend:

- **Minimum height**: 800px
- **Recommended height**: 1000px or use `height: 100%` with the responsive approach above
- **Maximum width**: 1200px (ARETE's content is optimized for this width)

### Example: Full HTML Page with Dynamic Height

```html
<!DOCTYPE html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>ARETE Embedded</title>
        <style>
            body {
                margin: 0;
                padding: 20px;
                font-family:
                    system-ui,
                    -apple-system,
                    sans-serif;
            }
            .embed-container {
                max-width: 1200px;
                margin: 0 auto;
            }
            .embed-container iframe {
                width: 100%;
                border: none;
                min-height: 800px; /* Initial height, will be adjusted automatically */
            }
        </style>
    </head>
    <body>
        <div class="embed-container">
            <iframe
                id="arete-embed"
                src="https://arete.fly.dev/embed"
                allow="clipboard-read; clipboard-write"
                title="ARETE - Ethics-first AI assistant"
            ></iframe>
        </div>

        <script>
            (function () {
                const iframe = document.getElementById('arete-embed');
                if (!iframe) {
                    console.warn('ARETE embed: iframe element not found');
                    return;
                }

                // Disable scrolling on iframe
                iframe.scrolling = 'no';
                iframe.style.overflow = 'hidden';

                // Listen for height messages from embed
                window.addEventListener('message', (event) => {
                    // Optional: Validate origin for security (recommended in production)
                    // if (event.origin !== 'https://arete.fly.dev') return;

                    if (
                        event.data &&
                        event.data.type === 'arete-embed-height'
                    ) {
                        const newHeight = event.data.height;
                        if (newHeight && newHeight > 0) {
                            iframe.style.height = newHeight + 'px';
                        }
                    }
                });

                // Fallback: Set initial height
                iframe.style.minHeight = '800px';
            })();
        </script>
    </body>
</html>
```

## Technical Details

### CORS Configuration

The embed route is configured to allow:

- **Embedding from**: `https://jordanmakes.fly.dev`
- **API requests**: The `/api/reflect` endpoint accepts cross-origin requests from `https://jordanmakes.fly.dev`
- **CORS headers**: Configured for POST and OPTIONS requests

### Content Security Policy

The embed route uses a Content Security Policy that:

- Allows iframe embedding from `https://jordanmakes.fly.dev` via `frame-ancestors`
- Permits necessary resources for scripts, styles, and images
- Supports Cloudflare Turnstile CAPTCHA integration

### Troubleshooting

If you see scrollbars in the iframe:

1. **Check that the listener script is loaded**: Open your browser's developer console and look for any errors.

2. **Verify message reception**: Add temporary logging to see if messages are received:

    ```javascript
    window.addEventListener('message', (event) => {
        console.log('Message received:', event.data);
        // ... rest of your code
    });
    ```

3. **Ensure iframe ID matches**: The iframe must have `id="arete-embed"` (or update the script to match your ID).

4. **Check iframe scrolling attribute**: Make sure `scrolling="no"` is set on the iframe, or add `iframe.style.overflow = 'hidden'`.

5. **Verify origin**: If you're validating the origin, make sure it matches exactly (including protocol and port if applicable).

### Limitations and Considerations

1. **Theme**: The embedded ARETE respects the system theme (light/dark mode) but theme switching is available within the embed.

2. **Navigation**: Links in the header may navigate within the iframe. Consider adding `target="_top"` or `target="_blank"` if you want links to open in the parent page or a new tab.

3. **API Rate Limiting**: The `/api/reflect` endpoint has rate limiting per IP and session to prevent abuse.

4. **CAPTCHA**: The interactive component requires Cloudflare Turnstile CAPTCHA verification. This must be configured on the ARETE instance.

5. **Responsive Behavior**: The embed is designed to work well on desktop and tablet devices. Mobile responsiveness is optimized but may require additional styling considerations.

## Embed-Specific Considerations

- **Mobile responsiveness**: Shared `global.css` applies additional padding and stacking below ~560px and ~480px. At 320–414px, the ARETE intro and AMA form stack vertically; keep the iframe container at `width: 100%` with no CSS transforms to avoid forced zoom/scroll.
- **Header links**: On `/embed`, `Setup` and `Blog` buttons automatically open in a new tab with `target="_blank"`/`rel="noopener noreferrer"`. GitHub always opens in a new tab.
- **Height messaging**: The embed posts `arete-embed-height` messages on load, resize, mutations, and a 500ms interval. Ensure the parent listener stays attached and validates origin as needed.
- **Trimmed UI**: The embed shows only the header, hero copy, ARETE intro, and Ask Me Anything. No blog grid or other site sections render.
- **Iframe container**: Prefer dynamic height (listener above) over hard-coding short heights; if hard-coding, use at least 800px and let the iframe scroll be hidden.

## Customization

If you need to customize the embed appearance, you can:

1. Use CSS to style the iframe container
2. Adjust iframe dimensions to match your layout
3. Apply filters or transformations to the container (note: this won't affect the embedded content itself)

## Support

For issues or questions about embedding ARETE:

- Check the [main README](../README.md) for deployment instructions
- Review [SECURITY.md](../../SECURITY.md) for security considerations
- Open an issue on [GitHub](https://github.com/arete-org/arete) for support

## Updating Allowed Origins

To embed ARETE from a different domain, you have two options:

### Option 1: Environment Variable (Recommended)

Set the `ARETE_FRAME_ANCESTORS` environment variable with a comma-separated list of domains:

```bash
ARETE_FRAME_ANCESTORS=https://yourblog.com,https://anotherdomain.com,http://localhost:3000
```

This will add your domains to the default allowed list. The environment variable is read by both the production server (`server.js`) and the development server (`vite.config.ts`).

### Option 2: Code Configuration

1. **CORS configuration**: Update the `setCorsHeaders` function in `server.js` to include your domain in `Access-Control-Allow-Origin`
2. **CSP configuration**: Update the `frame-ancestors` directive in `server.js` (around line 1276) and `packages/web/vite.config.ts` (around line 14) to allow your domain

Note: Multiple domains can be configured by listing them in the CSP `frame-ancestors` directive (space-separated).
