import { useState, useEffect } from 'react';
import { useTheme } from '../theme';

// Each feature card highlights a distinct ability while keeping copy warm and concrete.
interface ServiceFeature {
    id: string;
    title: string;
    description: string;
    variant?: 'wide';
}

const FEATURES: ServiceFeature[] = [
    {
        id: 'chat',
        title: 'Chat',
        description:
            'Explore ideas and questions with transparency about how I think.',
    },
    {
        id: 'realtime',
        title: 'Realtime search',
        description:
            'I can fetch information from the web and provide sources.',
    },
    {
        id: 'call',
        title: '/call',
        description: 'Join a voice channel and speak with me in real-time.',
    },
    {
        id: 'image-understanding',
        title: 'Image understanding',
        description: 'I can analyze images for meaning and context to support richer responses.',
    },
    {
        id: 'image',
        title: '/image',
        description:
            'Turn prompts into reflective or illustrative imagery, supporting discussion or workflows with visual context.',
        variant: 'wide',
    },
];

// Helper function to get image path for a feature
const getFeatureImage = (featureId: string, theme: string): string | null => {
    // Map feature IDs to image names
    const imageMap: Record<string, string> = {
        chat: 'chat',
        realtime: 'search',
        call: 'call',
        'image-understanding': 'image-understanding',
        image: 'image',
    };

    const imageName = imageMap[featureId];
    if (!imageName) return null;

    return `/assets/${imageName}-${theme}.png`;
};

// Feature spread showing present-day capabilities.
const Services = (): JSX.Element => {
    const { theme } = useTheme();
    const [expandedImageId, setExpandedImageId] = useState<string | null>(null);

    const handleImageClick = (featureId: string, event: React.MouseEvent) => {
        event.stopPropagation();
        if (expandedImageId === featureId) {
            setExpandedImageId(null);
        } else {
            setExpandedImageId(featureId);
        }
    };

    const handleModalClick = (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) {
            setExpandedImageId(null);
        }
    };

    const handleModalClose = () => {
        setExpandedImageId(null);
    };

    // Handle Escape key to close modal
    useEffect(() => {
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && expandedImageId) {
                setExpandedImageId(null);
            }
        };

        if (expandedImageId) {
            document.addEventListener('keydown', handleEscape);
            // Prevent body scroll when modal is open
            document.body.style.overflow = 'hidden';
        }

        return () => {
            document.removeEventListener('keydown', handleEscape);
            document.body.style.overflow = '';
        };
    }, [expandedImageId]);

    return (
        <>
            <section className="services" aria-labelledby="services-title">
                <h2 id="services-title">What I can do for you</h2>
                <div className="services-grid">
                    {FEATURES.map((feature) => (
                        <article
                            key={feature.id}
                            className={`feature-card${feature.variant === 'wide' ? ' feature-card--wide' : ''}`}
                            aria-labelledby={`${feature.id}-title`}
                        >
                            <div className="feature-card__body">
                                <h3 id={`${feature.id}-title`}>
                                    {feature.title}
                                </h3>
                                <p>{feature.description}</p>
                            </div>
                            {getFeatureImage(feature.id, theme) && (
                                <div className="feature-card__image-wrapper">
                                    <img
                                        src={
                                            getFeatureImage(feature.id, theme)!
                                        }
                                        alt=""
                                        className="feature-card__image"
                                        onClick={(e) =>
                                            handleImageClick(feature.id, e)
                                        }
                                        aria-hidden="true"
                                    />
                                    <button
                                        className="feature-card__expand-button"
                                        onClick={(e) =>
                                            handleImageClick(feature.id, e)
                                        }
                                        aria-label="Expand image"
                                        type="button"
                                    >
                                        <svg
                                            width="20"
                                            height="20"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            strokeWidth="2"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        >
                                            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                                        </svg>
                                    </button>
                                </div>
                            )}
                        </article>
                    ))}
                </div>
            </section>

            {expandedImageId && getFeatureImage(expandedImageId, theme) && (
                <div
                    className="image-modal"
                    onClick={handleModalClick}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Expanded image view"
                >
                    <button
                        className="image-modal__close"
                        onClick={handleModalClose}
                        aria-label="Close expanded view"
                        type="button"
                    >
                        <svg
                            width="24"
                            height="24"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                        </svg>
                    </button>
                    <img
                        src={getFeatureImage(expandedImageId, theme)!}
                        alt=""
                        className="image-modal__image"
                        onClick={handleModalClose}
                    />
                </div>
            )}
        </>
    );
};

export default Services;
