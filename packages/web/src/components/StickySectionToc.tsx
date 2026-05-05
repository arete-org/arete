/**
 * @description: Shared sticky table-of-contents for long-form pages with
 * active section highlighting on desktop layouts.
 * @footnote-scope: web
 * @footnote-module: StickySectionToc
 * @footnote-risk: low - Incorrect pinning/highlighting can degrade page navigation but does not affect runtime data.
 * @footnote-ethics: low - Navigation behavior has minimal governance impact beyond basic accessibility.
 */

import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
} from 'react';

type SectionLink = {
    id: string;
    label: string;
};

type StickySectionTocProps = {
    ariaLabel: string;
    sections: SectionLink[];
    title?: string;
};

const StickySectionToc = ({
    ariaLabel,
    sections,
    title = 'Index',
}: StickySectionTocProps): JSX.Element => {
    const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
    const [isTocPinned, setIsTocPinned] = useState(false);
    const [tocPinnedStyle, setTocPinnedStyle] = useState<
        CSSProperties | undefined
    >(undefined);
    const [tocPlaceholderHeight, setTocPlaceholderHeight] = useState<
        number | undefined
    >(undefined);

    const isTocPinnedRef = useRef(false);
    const tocContainerRef = useRef<HTMLElement | null>(null);
    const tocInnerRef = useRef<HTMLDivElement | null>(null);
    const sectionIds = useMemo(
        () => sections.map((section) => section.id),
        [sections]
    );

    useEffect(() => {
        const desktopQuery = window.matchMedia('(min-width: 641px)');

        const updateActiveSection = (): void => {
            if (!desktopQuery.matches) {
                setActiveSectionId(null);
                return;
            }

            const thresholdPx = 160;
            let nextActiveId: string | null = sectionIds[0] ?? null;

            for (const sectionId of sectionIds) {
                const sectionElement = document.getElementById(sectionId);
                if (sectionElement === null) {
                    continue;
                }

                const sectionTop = sectionElement.getBoundingClientRect().top;
                if (sectionTop <= thresholdPx) {
                    nextActiveId = sectionId;
                    continue;
                }

                break;
            }

            if (
                window.innerHeight + window.scrollY >=
                document.body.scrollHeight - 2
            ) {
                nextActiveId =
                    sectionIds[sectionIds.length - 1] ?? nextActiveId;
            }

            setActiveSectionId(nextActiveId);
        };

        const handleDesktopModeChange = (): void => {
            updateActiveSection();
        };

        updateActiveSection();
        window.addEventListener('scroll', updateActiveSection, {
            passive: true,
        });
        window.addEventListener('resize', updateActiveSection);
        desktopQuery.addEventListener('change', handleDesktopModeChange);

        return () => {
            window.removeEventListener('scroll', updateActiveSection);
            window.removeEventListener('resize', updateActiveSection);
            desktopQuery.removeEventListener('change', handleDesktopModeChange);
        };
    }, [sectionIds]);

    useEffect(() => {
        const desktopQuery = window.matchMedia('(min-width: 641px)');
        let animationFrameId: number | null = null;

        const updatePinnedToc = (): void => {
            const tocContainer = tocContainerRef.current;
            const tocInner = tocInnerRef.current;

            if (
                tocContainer === null ||
                tocInner === null ||
                !desktopQuery.matches
            ) {
                isTocPinnedRef.current = false;
                setIsTocPinned(false);
                setTocPinnedStyle(undefined);
                setTocPlaceholderHeight(undefined);
                return;
            }

            const headerElement = document.querySelector(
                '.site-header-sticky'
            ) as HTMLElement | null;
            const headerBottom =
                headerElement?.getBoundingClientRect().bottom ?? 0;
            const topOffset = headerBottom + 12;
            const containerRect = tocContainer.getBoundingClientRect();

            const pinThreshold = topOffset - 2;
            const unpinThreshold = topOffset + 12;
            const shouldPin = isTocPinnedRef.current
                ? containerRect.top <= unpinThreshold
                : containerRect.top <= pinThreshold;

            if (shouldPin) {
                isTocPinnedRef.current = true;
                setIsTocPinned(true);
                setTocPinnedStyle({
                    top: `${topOffset}px`,
                    left: `${containerRect.left}px`,
                    width: `${containerRect.width}px`,
                });
                setTocPlaceholderHeight(
                    tocInner.getBoundingClientRect().height
                );
                return;
            }

            isTocPinnedRef.current = false;
            setIsTocPinned(false);
            setTocPinnedStyle(undefined);
            setTocPlaceholderHeight(undefined);
        };

        const schedulePinnedTocUpdate = (): void => {
            if (animationFrameId !== null) {
                return;
            }

            animationFrameId = window.requestAnimationFrame(() => {
                animationFrameId = null;
                updatePinnedToc();
            });
        };

        updatePinnedToc();
        window.addEventListener('scroll', schedulePinnedTocUpdate, {
            passive: true,
        });
        window.addEventListener('resize', schedulePinnedTocUpdate);
        desktopQuery.addEventListener('change', schedulePinnedTocUpdate);

        return () => {
            if (animationFrameId !== null) {
                window.cancelAnimationFrame(animationFrameId);
            }

            window.removeEventListener('scroll', schedulePinnedTocUpdate);
            window.removeEventListener('resize', schedulePinnedTocUpdate);
            desktopQuery.removeEventListener('change', schedulePinnedTocUpdate);
        };
    }, []);

    return (
        <aside
            className="page-toc"
            ref={tocContainerRef}
            style={
                tocPlaceholderHeight === undefined
                    ? undefined
                    : { minHeight: `${tocPlaceholderHeight}px` }
            }
        >
            <nav className="onboarding-toc" aria-label={ariaLabel}>
                <div
                    ref={tocInnerRef}
                    className={
                        isTocPinned
                            ? 'onboarding-toc__inner onboarding-toc__inner--pinned'
                            : 'onboarding-toc__inner'
                    }
                    style={tocPinnedStyle}
                >
                    <p className="onboarding-toc__title">{title}</p>
                    <ul className="onboarding-toc__list">
                        {sections.map((section) => (
                            <li key={section.id}>
                                <a
                                    href={`#${section.id}`}
                                    className={
                                        activeSectionId === section.id
                                            ? 'onboarding-toc__link onboarding-toc__link--active'
                                            : 'onboarding-toc__link'
                                    }
                                    aria-current={
                                        activeSectionId === section.id
                                            ? 'location'
                                            : undefined
                                    }
                                >
                                    {section.label}
                                </a>
                            </li>
                        ))}
                    </ul>
                </div>
            </nav>
        </aside>
    );
};

export default StickySectionToc;
