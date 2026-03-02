/**
 * @description: Renders the site footer links for source code, discussion, philosophy, and licensing references.
 * @footnote-scope: web
 * @footnote-module: SiteFooter
 * @footnote-risk: low - Footer link regressions reduce navigation quality but do not break core flows.
 * @footnote-ethics: low - Accurate footer references support transparency but do not process user data.
 */

// Quiet footer reiterating licensing and lineage without drawing too much attention.
const Footer = (): JSX.Element => (
    <footer className="site-footer">
        <div className="footer-links">
            <a
                href="https://github.com/footnote-ai/footnote"
                target="_blank"
                rel="noreferrer"
                aria-label="View Footnote project on GitHub (opens in new tab)"
            >
                <span className="link-icon" aria-hidden="true">
                    ↗
                </span>
                GitHub
            </a>
            <span className="link-separator" aria-hidden="true">
                ·
            </span>
            <a
                href="https://github.com/footnote-ai/footnote/discussions"
                target="_blank"
                rel="noreferrer"
                aria-label="Join the discussion on GitHub (opens in new tab)"
            >
                <span className="link-icon" aria-hidden="true">
                    ↗
                </span>
                Join the discussion
            </a>
            <span className="link-separator" aria-hidden="true">
                ·
            </span>
            <a
                href="https://github.com/footnote-ai/footnote/blob/main/docs/Philosophy.md"
                target="_blank"
                rel="noreferrer"
                aria-label="Read Footnote philosophy document (opens in new tab)"
            >
                <span className="link-icon" aria-hidden="true">
                    ↗
                </span>
                Philosophy
            </a>
        </div>
    </footer>
);

export default Footer;
