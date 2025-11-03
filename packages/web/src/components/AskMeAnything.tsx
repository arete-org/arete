import { FormEvent, useEffect, useRef, useState } from 'react';
import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile';
import ProvenanceFooter from './ProvenanceFooter';
import type { ResponseMetadata } from 'ethics-core';
import examplePrompts from '../data/examplePrompts.json';

// Module augmentation for Vite environment variables
declare global {
  interface ImportMetaEnv {
    readonly DEV: boolean;
    readonly VITE_TURNSTILE_SITE_KEY: string;
    readonly VITE_SKIP_CAPTCHA: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

// Provide a stable fallback response in case the backend is unavailable so the space stays welcoming.
const FALLBACK_REFLECTION =
  'I was unable to generate a response - please try again later.';

// Map provenance strings to union values
const normalizeProvenance = (provenance: string): 'Retrieved' | 'Inferred' | 'Speculative' => {
  const normalized = provenance.toLowerCase();
  if (normalized === 'retrieved') return 'Retrieved';
  if (normalized === 'inferred') return 'Inferred';
  if (normalized === 'speculative') return 'Speculative';
  return 'Inferred'; // Default to 'Inferred' when unknown
};

// Normalize backend metadata to ResponseMetadata format
const normalizeMetadata = (backendMetadata: any): ResponseMetadata => {
  // Type guard: check if backendMetadata already matches ResponseMetadata structure
  // We also need to ensure confidence is properly normalized even in this path
  if (backendMetadata && 
      typeof backendMetadata.responseId === 'string' &&
      typeof backendMetadata.riskTier === 'string' &&
      (backendMetadata.riskTier === 'Low' || backendMetadata.riskTier === 'Medium' || backendMetadata.riskTier === 'High') &&
      typeof backendMetadata.provenance === 'string' &&
      (backendMetadata.provenance === 'Retrieved' || backendMetadata.provenance === 'Inferred' || backendMetadata.provenance === 'Speculative') &&
      Array.isArray(backendMetadata.citations)) {
    // Convert string URLs to URL objects if needed
    const processedCitations = backendMetadata.citations.map((citation: any) => {
      if (typeof citation.url === 'string') {
        try {
          return {
            ...citation,
            url: new URL(citation.url)
          };
        } catch (error) {
          console.warn('Invalid citation URL:', citation.url, error);
          return null;
        }
      }
      return citation;
    }).filter(Boolean);
    
    // Ensure confidence is valid even if type guard passed
    const validConfidence = typeof backendMetadata.confidence === 'number' && 
                            backendMetadata.confidence >= 0 && 
                            backendMetadata.confidence <= 1
                            ? backendMetadata.confidence 
                            : 0.0;
    
    return {
      ...backendMetadata,
      confidence: validConfidence,
      citations: processedCitations
    } as ResponseMetadata;
  }

  // Map backend fields to ResponseMetadata structure
  const normalized: ResponseMetadata = {
    responseId: backendMetadata.responseId || backendMetadata.id || 'unknown',
    provenance: backendMetadata.provenance ? normalizeProvenance(backendMetadata.provenance) : 'Inferred',
    confidence: typeof backendMetadata.confidence === 'number' && 
                backendMetadata.confidence >= 0 && 
                backendMetadata.confidence <= 1 
                ? backendMetadata.confidence 
                : 0.0, // Default to 0.0 (0%) if not available or invalid
    riskTier: (backendMetadata.riskTier === 'Low' || backendMetadata.riskTier === 'Medium' || backendMetadata.riskTier === 'High') 
              ? backendMetadata.riskTier 
              : backendMetadata.reasoningEffort === 'low' ? 'Low' : 
                backendMetadata.reasoningEffort === 'medium' ? 'Medium' : 
                backendMetadata.reasoningEffort === 'high' ? 'High' : 'Low',
    tradeoffCount: backendMetadata.tradeoffCount || 0,
    chainHash: backendMetadata.chainHash || 'unknown',
    licenseContext: backendMetadata.licenseContext || 'MIT + HL3',
    modelVersion: backendMetadata.runtimeContext?.modelVersion || backendMetadata.model || 'unknown',
    staleAfter: backendMetadata.staleAfter || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    citations: []
  };

  // Process citations if they exist
  if (backendMetadata.citations && Array.isArray(backendMetadata.citations)) {
    normalized.citations = backendMetadata.citations.map((citation: any) => {
      try {
        return {
          title: citation.title || 'Untitled',
          url: new URL(citation.url),
          snippet: citation.snippet
        };
      } catch (error) {
        console.warn('Invalid citation URL:', citation.url, error);
        return null;
      }
    }).filter(Boolean);
  }

  return normalized;
};

const AskMeAnything = (): JSX.Element => {
  const [question, setQuestion] = useState('');
  const [status, setStatus] = useState('');
  const [answer, setAnswer] = useState('');
  const [displayedAnswer, setDisplayedAnswer] = useState('');
  const [metadata, setMetadata] = useState<ResponseMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTypingComplete, setIsTypingComplete] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileError, setTurnstileError] = useState<string | null>(null);
  const [isTurnstileReady, setIsTurnstileReady] = useState(false);
  const [turnstileKey, setTurnstileKey] = useState(0);
  const [isTurnstileMounted, setIsTurnstileMounted] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const turnstileRef = useRef<TurnstileInstance | null>(null);
  const hasInteractedRef = useRef(false); // Track if user has interacted to prevent initial status flash
  
  // Random prompt selection
  const getRandomPrompt = (): string => {
    const prompts = examplePrompts.prompts;
    return prompts[Math.floor(Math.random() * prompts.length)];
  };
  
  const [currentPrompt, setCurrentPrompt] = useState<string>(() => getRandomPrompt());
  
  const shufflePrompt = () => {
    setCurrentPrompt(getRandomPrompt());
  };
  
  const usePrompt = () => {
    setQuestion((prev) => {
      if (!prev.trim()) {
        return currentPrompt;
      }
      // Check if the current text already ends with punctuation
      const trimmed = prev.trim();
      const endsWithPunctuation = /[.!?]$/.test(trimmed);
      const endsWithSpace = /\s$/.test(prev);
      
      // If it ends with punctuation, just add a space before the new text
      // If it ends with a space, just append
      // Otherwise, add period and space
      if (endsWithPunctuation) {
        return prev + (endsWithSpace ? '' : ' ') + currentPrompt;
      } else {
        return prev + '. ' + currentPrompt;
      }
    });
    inputRef.current?.focus();
  };

  // Check if Turnstile site key is valid (not empty or missing)
  const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  const hasValidSiteKey = turnstileSiteKey && turnstileSiteKey.trim().length > 0;

  // Skip CAPTCHA in development mode, unless explicitly disabled via VITE_SKIP_CAPTCHA
  // Also skip CAPTCHA if site key is missing/invalid (production misconfiguration)
  // If VITE_SKIP_CAPTCHA is explicitly set to 'false', require CAPTCHA even in dev mode (but still need valid key)
  const isDevelopment = import.meta.env.VITE_SKIP_CAPTCHA === 'true' || 
    (import.meta.env.DEV && import.meta.env.VITE_SKIP_CAPTCHA !== 'false') ||
    !hasValidSiteKey; // Skip CAPTCHA if site key is missing (treat as misconfigured)

  // Turnstile callback functions
  // According to Cloudflare docs: tokens are max 2048 chars, expire after 300s, single-use only
      const onTurnstileVerify = (token: string) => {
        console.log('[Turnstile] onTurnstileVerify called with token:', token ? `${token.substring(0, 30)}...` : 'null');
        // Check if using test keys (test keys generate shorter dummy tokens like "XXXX.DUMMY.TOKEN.XXXX")
        const isTestKey = import.meta.env.VITE_TURNSTILE_SITE_KEY?.startsWith('1x00000000000000000000') || 
                          import.meta.env.VITE_TURNSTILE_SITE_KEY?.startsWith('2x00000000000000000000') ||
                          import.meta.env.VITE_TURNSTILE_SITE_KEY?.startsWith('3x00000000000000000000');
        
        // Log token generation (for debugging)
        console.log('[Turnstile] Token details - length:', token?.length || 0, 'site key:', import.meta.env.VITE_TURNSTILE_SITE_KEY?.substring(0, 20), 'isTestKey:', isTestKey);
        
        // Validate token - test keys generate shorter tokens, production tokens should be ~200+ chars
        if (!token) {
          console.error('Turnstile token is empty');
          setTurnstileError('CAPTCHA token is invalid. Please try again.');
          setIsTurnstileReady(false);
          setTurnstileToken(null);
          return;
        }
        
        // Only validate length for production keys (test keys use dummy tokens)
        if (!isTestKey && token.length < 50) {
          console.error('Turnstile token appears invalid - length:', token.length);
          console.error('Token preview:', token.substring(0, 50));
          console.error('Full token:', token);
          setTurnstileError('CAPTCHA token is invalid. Please try again.');
          setIsTurnstileReady(false);
          setTurnstileToken(null);
          return;
        }
        
        // Log token info for debugging (especially in production)
        if (!isTestKey) {
          console.log('Turnstile token generated - length:', token.length, 'hostname:', window.location.hostname);
        }
    
    setTurnstileToken(token);
    setIsTurnstileReady(true);
    setTurnstileError(null);
    // Only clear status if it's not an error message (errors should persist until next submission)
    // Check if current status is an error by looking for common error keywords
    setStatus((prev) => {
      if (prev && (prev.includes('failed') || prev.includes('unavailable') || prev.includes('Unable to connect'))) {
        // Keep error messages - don't clear them on CAPTCHA verify
        return prev;
      }
      // Clear non-error status messages
      return '';
    });
    // Auto-focus the input field when CAPTCHA is completed
    inputRef.current?.focus();
  };

  const onTurnstileError = () => {
    setTurnstileError('CAPTCHA verification failed. Please try again.');
    setIsTurnstileReady(false);
    setTurnstileToken(null);
  };

  const onTurnstileExpire = () => {
    setTurnstileToken(null);
    setIsTurnstileReady(false);
    setTurnstileError('CAPTCHA expired. Please verify again.');
  };

  // Execute Turnstile challenge on mount and when widget is reset
  // Guard execution to when widget is mounted and ready
  // Fallback: if onLoad doesn't fire (can happen with test keys + invisible mode), try executing after delay
  useEffect(() => {
    if (!isDevelopment && hasValidSiteKey && turnstileRef.current && !turnstileError) {
      // If widget is mounted, execute immediately
      if (isTurnstileMounted) {
        const timer = setTimeout(() => {
          if (turnstileRef.current) {
            console.log('[Turnstile] Executing invisible widget (mounted)...');
            turnstileRef.current.execute();
            turnstileRef.current.getResponsePromise?.()
              .then((token) => {
                console.log('[Turnstile] Token resolved from promise:', token ? `${token.substring(0, 20)}...` : 'null');
              })
              .catch((err) => {
                console.error('[Turnstile] Promise rejection:', err);
              });
          }
        }, 100);
        return () => clearTimeout(timer);
      } else {
        // Fallback: if onLoad doesn't fire, try executing after 2 seconds anyway
        // This handles cases where onLoad callback doesn't fire (test keys + invisible mode)
        const fallbackTimer = setTimeout(() => {
          if (turnstileRef.current && !isTurnstileMounted && !turnstileError) {
            console.log('[Turnstile] Fallback: Executing widget even though onLoad hasn\'t fired');
            try {
              turnstileRef.current.execute();
              // Mark as mounted after successful execution attempt
              setIsTurnstileMounted(true);
            } catch (err) {
              console.error('[Turnstile] Fallback execution failed:', err);
            }
          }
        }, 2000);
        return () => clearTimeout(fallbackTimer);
      }
    }
    return undefined;
  }, [turnstileKey, isDevelopment, hasValidSiteKey, turnstileError, isTurnstileMounted]);

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = inputRef.current;
    if (textarea && textarea instanceof HTMLTextAreaElement) {
      // Reset height to get accurate scrollHeight
      textarea.style.height = '0px';
      textarea.style.overflowY = 'hidden';
      
      const maxHeight = 20 * 16; // 20rem in pixels (20 * 16px = 320px)
      const scrollHeight = textarea.scrollHeight;
      
      // Only show scrollbar when we've reached max-height
      if (scrollHeight > maxHeight) {
        textarea.style.height = `${maxHeight}px`;
        textarea.style.overflowY = 'auto';
      } else {
        // Use exact scrollHeight without buffer to prevent scrollbar
        textarea.style.height = `${scrollHeight}px`;
        textarea.style.overflowY = 'hidden';
      }
    }
  }, [question]);

  // Animate the text reveal whenever the answer changes for a gentle typewriter feel.
  useEffect(() => {
    if (!answer) {
      setDisplayedAnswer('');
      setIsTypingComplete(false);
      return;
    }
    
    setDisplayedAnswer('');
    setIsTypingComplete(false);
    const characters = Array.from(answer);
    
    let index = 0;

      const interval = window.setInterval(() => {
        const char = characters[index];
        setDisplayedAnswer((previous) => previous + char);
        index += 1;

        if (index >= characters.length) {
          window.clearInterval(interval);
          setIsTypingComplete(true);
        }
      }, 5);

    return () => window.clearInterval(interval);
  }, [answer]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    
    // Mark that user has interacted
    hasInteractedRef.current = true;
    
    const trimmedQuestion = question.trim();

    if (!trimmedQuestion) {
      setStatus('Please share a question, even a small one.');
      return;
    }

    // Fallback: trigger execution if token isn't pre-fetched to avoid deadlock
    let resolvedToken = turnstileToken;
    if (!isDevelopment && !resolvedToken) {
      if (turnstileRef.current) {
        // Execute challenge and wait for token
        turnstileRef.current.execute();
        try {
          // Wait for token with timeout and capture the resolved token
          const tokenFromPromise = await Promise.race([
            turnstileRef.current.getResponsePromise?.() || Promise.resolve(null),
            new Promise<string | null>((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
          ]).catch(() => {
            // If timeout or no promise, return null - validation will catch empty token
            return null;
          });
          if (tokenFromPromise) {
            resolvedToken = tokenFromPromise;
          }
        } catch {
          // Continue - validation will handle empty token
        }
      }
      // Re-check token after execution attempt
      if (!resolvedToken) {
        setStatus('Please complete the CAPTCHA verification.');
        setIsLoading(false); // Ensure loading state is reset if we return early
        return;
      }
    }

    // Abort any in-flight request when a new one starts to avoid race conditions.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Set a timeout for the fetch request (60 seconds)
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 60000);

    // Clear previous status and answer when starting a new submission
    setStatus('');
    setIsLoading(true);
    setAnswer('');
    setMetadata(null);
    setIsTypingComplete(false);

    try {
      const headers: Record<string, string> = { 
        Accept: 'application/json'
      };
      
      // Only add CAPTCHA token if we have one (not in development mode)
      if (!isDevelopment && resolvedToken) {
        headers['x-turnstile-token'] = resolvedToken;
      }
      
      const response = await fetch(`/api/reflect?question=${encodeURIComponent(trimmedQuestion)}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      // Clear timeout once we have a response
      clearTimeout(timeoutId);

      if (!response.ok) {
        // Handle CAPTCHA-specific errors
        if (response.status === 403) {
          try {
            const errorData = await response.json();
            const errorMessage = errorData.details 
              ? `CAPTCHA verification failed: ${errorData.details}. Please refresh and try again.`
              : 'CAPTCHA verification failed. Please refresh and try again.';
            
            setIsLoading(false);
            setStatus(errorMessage);
            setTurnstileToken(null);
            setIsTurnstileReady(false);
            setTurnstileError(null); // Clear any widget errors, we're showing API error in status instead
            setIsTurnstileMounted(false); // Reset mount state
            setTurnstileKey(prev => prev + 1);
            return;
          } catch {
            setIsLoading(false);
            setStatus('CAPTCHA verification failed. Please refresh and try again.');
            setTurnstileToken(null);
            setIsTurnstileReady(false);
            setTurnstileError(null);
            setIsTurnstileMounted(false); // Reset mount state
            setTurnstileKey(prev => prev + 1);
            return;
          }
        }
        
        // Handle 502 Turnstile service errors
        if (response.status === 502) {
          try {
            const errorData = await response.json();
            if (errorData.error && errorData.error.includes('CAPTCHA verification service unavailable')) {
              setIsLoading(false);
              setStatus('CAPTCHA service is unavailable. Please try again shortly.');
              setTurnstileToken(null);
              setIsTurnstileReady(false);
              setTurnstileError(null);
              setIsTurnstileMounted(false); // Reset mount state
              setTurnstileKey(prev => prev + 1);
              return;
            }
          } catch {
            setIsLoading(false);
            setStatus('CAPTCHA service is unavailable. Please try again shortly.');
            setTurnstileToken(null);
            setIsTurnstileReady(false);
            setTurnstileError(null);
            setIsTurnstileMounted(false); // Reset mount state
            setTurnstileKey(prev => prev + 1);
            return;
          }
        }
        
        throw new Error(`Unexpected response status: ${response.status}`);
      }

      const payload = await response.json();
      
      const reflection = payload.message as string | undefined;
      const backendMetadata = payload.metadata;
      
      setStatus('A brief reflection:');
      setAnswer(
        reflection?.trim() ||
          'I would begin by examining the ethical principles involved, then consider what transparency and care require.',
      );
      
      // Normalize backend metadata to ResponseMetadata format
      const normalizedMetadata = backendMetadata ? normalizeMetadata(backendMetadata) : null;
      setMetadata(normalizedMetadata);
      
      // Reset Turnstile for next question by forcing re-render
      // The useEffect hook will automatically re-execute after turnstileKey increments
      setTurnstileToken(null);
      setIsTurnstileReady(false);
      setIsTurnstileMounted(false); // Reset mount state to trigger re-mount
      setTurnstileKey(prev => prev + 1);
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        return;
      }

      // Check for network errors
      if (error instanceof TypeError && error.message.includes('fetch')) {
        setStatus('Unable to connect to the server. Please check your connection and try again.');
        setIsLoading(false);
        return;
      }

      // Check for CAPTCHA-related errors
      if (error instanceof Error && (error.message.includes('CAPTCHA') || error.message.includes('403'))) {
        setStatus('CAPTCHA verification failed. Please refresh and try again.');
        setTurnstileToken(null);
        setIsTurnstileReady(false);
        setTurnstileError(null);
        setIsTurnstileMounted(false); // Reset mount state
        setIsLoading(false);
        return;
      }

      setStatus('My thoughts:');
      setAnswer(FALLBACK_REFLECTION);
      setMetadata(null);
      setIsTypingComplete(false);
    } finally {
      clearTimeout(timeoutId); // Ensure timeout is cleared in all cases
      setIsLoading(false);
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  };

  return (
    <div className="interaction">
      <div className="interaction-heading-row">
        <h2 className="interaction-heading">Ask me anything</h2>
        <div className="interaction-prompt-buttons-row">
          <div className="interaction-prompt-text-button-wrapper">
            <button
              type="button"
              className="interaction-prompt-text-button"
              onClick={usePrompt}
              onMouseDown={(e) => e.currentTarget.blur()}
              aria-label={`Use prompt suggestion: ${currentPrompt}`}
            >
              <span className="interaction-prompt-text">{currentPrompt}</span>
            </button>
          </div>
          <button
            type="button"
            className="interaction-prompt-shuffle-button"
            onClick={shufflePrompt}
            onMouseDown={(e) => e.currentTarget.blur()}
            aria-label="Shuffle prompt suggestions"
          >
            <span className="interaction-prompt-shuffle-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
              </svg>
            </span>
          </button>
        </div>
      </div>
        <form className="interaction-form" onSubmit={onSubmit}>
          <div className="interaction-input-group">
            <label htmlFor="question-input" className="sr-only">
              Ask a question
            </label>
            <div className="interaction-input-wrapper">
              <textarea
                id="question-input"
                className="interaction-input"
                name="question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="What should we talk about?"
                autoComplete="off"
                ref={inputRef}
                aria-label="Question input field"
                rows={1}
              />
              {question && (
                <button
                  type="button"
                  className="interaction-clear-button"
                  onClick={() => setQuestion('')}
                  aria-label="Clear text"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    <line x1="10" y1="11" x2="10" y2="17"/>
                    <line x1="14" y1="11" x2="14" y2="17"/>
                  </svg>
                </button>
              )}
            </div>
            <button 
              type="submit" 
              className="interaction-submit" 
              disabled={isLoading || (!isDevelopment && !isTurnstileReady)}
              aria-label={isLoading ? "Submitting question" : (!isDevelopment && !isTurnstileReady ? "Complete CAPTCHA to submit" : "Submit question")}
            >
              {isLoading ? (
                <>
                  <span className="spinner" aria-hidden="true" />
                </>
              ) : !isDevelopment && !isTurnstileReady ? (
                <span className="hourglass" aria-label="Complete CAPTCHA verification">⏳</span>
              ) : (
                'Go'
              )}
            </button>
          </div>
        </form>
        {/* Only show status when there's actual content (error messages, etc.) - spinner is in button during loading */}
        {/* Conditionally render only when we have actual content to avoid empty div taking space */}
        {/* IMPORTANT: Do not render at all if there's no content to avoid layout spacing */}
        {/* Only render after user has interacted to prevent initial flash */}
        {hasInteractedRef.current && status && status.trim().length > 0 && (
          <div 
            className="interaction-status interaction-status-visible"
            role="status"
          >
            <span>{status}</span>
          </div>
        )}
        {/* Only show output when there's actual content, not just when loading */}
        {displayedAnswer && (
          <div className="interaction-output" aria-live="polite">
            {displayedAnswer}
          </div>
        )}
        {/* Render Turnstile widget in Invisible mode - requires manual execute() calls for deterministic timing */}
        {/* Only render if we have a valid site key and CAPTCHA is required */}
        {hasValidSiteKey && !isDevelopment && !turnstileError && (
          <div className="interaction-captcha">
            <Turnstile
              ref={turnstileRef}
              key={turnstileKey}
              siteKey={turnstileSiteKey}
              onSuccess={onTurnstileVerify}
              onError={onTurnstileError}
              onExpire={onTurnstileExpire}
              onLoad={() => {
                console.log('[Turnstile] onLoad called - widget is mounted');
                setIsTurnstileMounted(true);
              }}
              options={{
                theme: 'light',
                size: 'invisible', // True Invisible widget type
                execution: 'execute', // Manual execution control
                appearance: 'execute', // Execute challenge, only show UI when executing
                language: 'auto'
              }}
            />
          </div>
        )}
        {!isDevelopment && turnstileError && (
          <div 
            className="interaction-captcha interaction-captcha-visible"
            aria-label="Complete CAPTCHA verification to submit your question"
          >
            <Turnstile
              key={turnstileKey}
              siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY}
              onSuccess={onTurnstileVerify}
              onError={onTurnstileError}
              onExpire={onTurnstileExpire}
              options={{
                theme: 'light',
                size: 'normal',
                language: 'auto'
              }}
            />
            <p className="interaction-error" role="alert">{turnstileError}</p>
          </div>
        )}
        {isTypingComplete && metadata && (
          <ProvenanceFooter metadata={metadata} />
        )}
    </div>
  );
};

export { AskMeAnything };
export default AskMeAnything;

