import React, { useState } from 'react';
import Header from '@components/Header';
import Footer from '@components/Footer';

type ToastState = { message: string; visible: boolean };
type ToastSetter = React.Dispatch<React.SetStateAction<ToastState>>;

const InvitePage: React.FC = () => {
  const [cloneToast, setCloneToast] = useState<ToastState>({ message: '', visible: false });
  const [installToast, setInstallToast] = useState<ToastState>({ message: '', visible: false });
  const [devToast, setDevToast] = useState<ToastState>({ message: '', visible: false });
  const [buildToast, setBuildToast] = useState<ToastState>({ message: '', visible: false });
  const [launchToast, setLaunchToast] = useState<ToastState>({ message: '', visible: false });
  const [deployToast, setDeployToast] = useState<ToastState>({ message: '', visible: false });
  const [requiredToast, setRequiredToast] = useState<ToastState>({ message: '', visible: false });
  const [optionalToast, setOptionalToast] = useState<ToastState>({ message: '', visible: false });

  // Breadcrumb items for invite page
  const breadcrumbItems = [
    { label: 'Self-Hosting Setup' }
  ];

  const showToast = (setter: ToastSetter, message: string) => {
    setter({ message, visible: true });
    setTimeout(() => setter({ message: '', visible: false }), 2000);
  };

  return (
    <>
      {/* Header Section */}
      <Header breadcrumbItems={breadcrumbItems} />

      {/* Main Content Section */}
      <main>
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">Setup</h1>
            <p>
              For beginners and advanced users alike.
            </p>
          </div>
        </section>

        <section>
            {/* Prerequisites Section */}
            <div className="card" aria-labelledby="prerequisites-title">
              <h2 id="prerequisites-title">Prerequisites</h2>
              <p>Before you begin, make sure you have:</p>
              <ul>
                <li>A Discord bot token (create one at <a href="https://discord.com/developers/applications" target="_blank" rel="noopener noreferrer">Discord Developer Portal</a>)</li>
                <li>An OpenAI API key (get one at <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer">OpenAI Platform</a>)</li>
                <li>Node.js installed on your system</li>
                <li>Git installed for cloning the repository</li>
              </ul>
            </div>

            {/* Installation Steps */}
            <div className="card" aria-labelledby="installation-title">
              <h2 id="installation-title">Installation</h2>
              <div className="feature-card">
                <h3>1. Clone the Repository</h3>
                <div style={{ position: 'relative' }}>
                  <pre style={{ 
                    background: 'var(--bg-soft)', 
                    padding: '1rem', 
                    borderRadius: '8px', 
                    overflow: 'auto',
                    fontSize: '0.9rem',
                    lineHeight: '1.4',
                    border: '1px solid var(--border)',
                    paddingTop: '3rem'
                  }}>
{`git clone https://github.com/arete-org/arete.git && cd arete`}
                  </pre>
                    <button 
                      className="cta-button secondary" 
                      onClick={async () => {
                        try {
                          const cloneCommands = `git clone https://github.com/arete-org/arete.git && cd arete`;
                          await navigator.clipboard.writeText(cloneCommands);
                          showToast(setCloneToast, 'Copied to clipboard');
                        } catch (err) {
                          console.error('Failed to copy to clipboard:', err);
                          const textArea = document.createElement('textarea');
                          textArea.value = `git clone https://github.com/arete-org/arete.git && cd arete`;
                          document.body.appendChild(textArea);
                          textArea.select();
                          document.execCommand('copy');
                          document.body.removeChild(textArea);
                          showToast(setCloneToast, 'Copied to clipboard');
                        }
                      }}
                      style={{ 
                        position: 'absolute',
                        top: '0.5rem',
                        right: '0.5rem',
                        fontSize: '1rem', 
                        padding: '0.4rem',
                        width: '2rem',
                        height: '2rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '4px',
                        zIndex: 10,
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--subtle-text)',
                        cursor: 'pointer'
                      }}
                      title="Copy clone commands"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                    </button>
                    {cloneToast.visible && (
                      <div style={{
                        position: 'absolute',
                        top: '-2.5rem',
                        right: '0',
                        background: 'var(--bg-alt)',
                        color: 'var(--text)',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '4px',
                        fontSize: '0.8rem',
                        border: '1px solid var(--border)',
                        boxShadow: '0 2px 8px var(--shadow)',
                        zIndex: 1000,
                        opacity: cloneToast.visible ? 1 : 0,
                        transition: 'opacity 0.3s ease',
                        whiteSpace: 'nowrap'
                      }}>
                        {cloneToast.message}
                      </div>
                    )}
                </div>
              </div>

              <div className="feature-card">
                <h3>2. Install Dependencies</h3>
                <div style={{ position: 'relative' }}>
                  <pre style={{ 
                    background: 'var(--bg-soft)', 
                    padding: '1rem', 
                    borderRadius: '8px', 
                    overflow: 'auto',
                    fontSize: '0.9rem',
                    lineHeight: '1.4',
                    border: '1px solid var(--border)',
                    paddingTop: '3rem'
                  }}>
{`npm install`}
                  </pre>
                    <button 
                      className="cta-button secondary" 
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText('npm install');
                          showToast(setInstallToast, 'Copied to clipboard');
                        } catch (err) {
                          console.error('Failed to copy to clipboard:', err);
                          const textArea = document.createElement('textarea');
                          textArea.value = 'npm install';
                          document.body.appendChild(textArea);
                          textArea.select();
                          document.execCommand('copy');
                          document.body.removeChild(textArea);
                          showToast(setInstallToast, 'Copied to clipboard');
                        }
                      }}
                      style={{ 
                        position: 'absolute',
                        top: '0.5rem',
                        right: '0.5rem',
                        fontSize: '1rem', 
                        padding: '0.4rem',
                        width: '2rem',
                        height: '2rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '4px',
                        zIndex: 10,
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--subtle-text)',
                        cursor: 'pointer'
                      }}
                      title="Copy install command"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                    </button>
                    {installToast.visible && (
                      <div style={{
                        position: 'absolute',
                        top: '-2.5rem',
                        right: '0',
                        background: 'var(--bg-alt)',
                        color: 'var(--text)',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '4px',
                        fontSize: '0.8rem',
                        border: '1px solid var(--border)',
                        boxShadow: '0 2px 8px var(--shadow)',
                        zIndex: 1000,
                        opacity: installToast.visible ? 1 : 0,
                        transition: 'opacity 0.3s ease',
                        whiteSpace: 'nowrap'
                      }}>
                        {installToast.message}
                      </div>
                    )}
                </div>
              </div>
            </div>

            {/* Environment Configuration */}
            <div className="card" aria-labelledby="environment-title">
              <h2 id="environment-title">Environment Configuration</h2>
              <p>Create a <code>.env</code> file in the root directory with the following variables:</p>
              
              <div className="feature-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                  <h3>Required Variables</h3>
                  <div style={{ position: 'relative' }}>
                    <button 
                      className="cta-button secondary" 
                      onClick={async () => {
                        try {
                          const requiredEnv = `# Discord bot credentials (required)
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_client_id
GUILD_ID=your_discord_guild_id
OPENAI_API_KEY=your_openai_api_key`;
                          await navigator.clipboard.writeText(requiredEnv);
                          showToast(setRequiredToast, 'Copied to clipboard');
                        } catch (err) {
                          console.error('Failed to copy to clipboard:', err);
                          // Fallback for older browsers
                          const textArea = document.createElement('textarea');
                          textArea.value = `# Discord bot credentials (required)
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_client_id
GUILD_ID=your_discord_guild_id
OPENAI_API_KEY=your_openai_api_key`;
                          document.body.appendChild(textArea);
                          textArea.select();
                          document.execCommand('copy');
                          document.body.removeChild(textArea);
                          showToast(setRequiredToast, 'Copied to clipboard');
                        }
                      }}
                      style={{ 
                        fontSize: '1.2rem', 
                        padding: '0.5rem',
                        width: '2.5rem',
                        height: '2.5rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '50%',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--subtle-text)',
                        cursor: 'pointer'
                      }}
                      title="Copy required variables"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                    </button>
                    {requiredToast.visible && (
                      <div style={{
                        position: 'fixed',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        background: 'var(--bg-alt)',
                        color: 'var(--text)',
                        padding: '0.5rem 1rem',
                        borderRadius: '6px',
                        fontSize: '0.85rem',
                        border: '1px solid var(--border)',
                        boxShadow: '0 4px 12px var(--shadow)',
                        zIndex: 1000,
                        opacity: requiredToast.visible ? 1 : 0,
                        transition: 'opacity 0.3s ease',
                        whiteSpace: 'nowrap'
                      }}>
                        {requiredToast.message}
                      </div>
                    )}
                  </div>
                </div>
                <pre style={{ 
                  background: 'var(--bg-soft)', 
                  padding: '1rem', 
                  borderRadius: '8px', 
                  overflow: 'auto',
                  fontSize: '0.9rem',
                  lineHeight: '1.4',
                  border: '1px solid var(--border)'
                }}>
{`# Discord bot credentials (required)
DISCORD_TOKEN=your_discord_bot_token    # Discord bot token (String)
CLIENT_ID=your_discord_client_id        # Discord application client ID (String)
GUILD_ID=your_discord_guild_id          # Discord server/guild ID (String)
OPENAI_API_KEY=your_openai_api_key      # OpenAI API key (String, format: sk-...)`}
                </pre>
              </div>

              <div className="feature-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                  <h3>Optional Configuration</h3>
                  <div style={{ position: 'relative' }}>
                    <button 
                      className="cta-button secondary" 
                      onClick={async () => {
                        try {
                          const optionalEnv = `# Optional prompt configuration overrides
PROMPT_CONFIG_PATH=path/to/prompts.yaml

# Optional rate limiting overrides
RATE_LIMIT_USER=true
USER_RATE_LIMIT=5
USER_RATE_WINDOW_MS=60000
RATE_LIMIT_CHANNEL=true
CHANNEL_RATE_LIMIT=10
CHANNEL_RATE_WINDOW_MS=60000
RATE_LIMIT_GUILD=true
GUILD_RATE_LIMIT=20
GUILD_RATE_WINDOW_MS=60000

# Optional thread engagement controls
ALLOW_THREAD_RESPONSES=true
ALLOWED_THREAD_IDS=123456789,987654321

# Optional image generation overrides
IMAGE_DEFAULT_TEXT_MODEL=gpt-5-mini
IMAGE_DEFAULT_IMAGE_MODEL=gpt-image-1-mini
IMAGE_TOKENS_PER_REFRESH=10
IMAGE_TOKEN_REFRESH_INTERVAL_MS=86400000

# Optional channel context manager configuration
CONTEXT_MANAGER_ENABLED=true
CONTEXT_MANAGER_MAX_MESSAGES=50
CONTEXT_MANAGER_RETENTION_MS=3600000
CONTEXT_MANAGER_EVICTION_INTERVAL_MS=300000

# Optional LLM cost tracking configuration
COST_ESTIMATOR_ENABLED=true

# Optional realtime engagement filter configuration
REALTIME_FILTER_ENABLED=false

# Engagement scoring weights (0-1 range, higher = more influence)
ENGAGEMENT_WEIGHT_MENTION=0.3
ENGAGEMENT_WEIGHT_QUESTION=0.2
ENGAGEMENT_WEIGHT_TECHNICAL=0.15
ENGAGEMENT_WEIGHT_HUMAN_ACTIVITY=0.15
ENGAGEMENT_WEIGHT_COST_SATURATION=0.1
ENGAGEMENT_WEIGHT_BOT_NOISE=0.05
ENGAGEMENT_WEIGHT_DM_BOOST=1.5
ENGAGEMENT_WEIGHT_DECAY=0.05

# Engagement behavior preferences
ENGAGEMENT_IGNORE_MODE=silent
ENGAGEMENT_REACTION_EMOJI=dY\`?
ENGAGEMENT_MIN_THRESHOLD=0.5
ENGAGEMENT_PROBABILISTIC_LOW=0.4
ENGAGEMENT_PROBABILISTIC_HIGH=0.6
ENGAGEMENT_ENABLE_LLM_REFINEMENT=false

# Provenance storage configuration
PROVENANCE_SQLITE_PATH=/data/provenance.db

# Optional web server configuration
WEB_BASE_URL=https://your-domain.com`;
                          await navigator.clipboard.writeText(optionalEnv);
                          showToast(setOptionalToast, 'Copied to clipboard');
                        } catch (err) {
                          console.error('Failed to copy to clipboard:', err);
                          // Fallback for older browsers
                          const textArea = document.createElement('textarea');
                          textArea.value = `# Optional prompt configuration overrides
PROMPT_CONFIG_PATH=path/to/prompts.yaml

# Optional rate limiting overrides
RATE_LIMIT_USER=true
USER_RATE_LIMIT=5
USER_RATE_WINDOW_MS=60000
RATE_LIMIT_CHANNEL=true
CHANNEL_RATE_LIMIT=10
CHANNEL_RATE_WINDOW_MS=60000
RATE_LIMIT_GUILD=true
GUILD_RATE_LIMIT=20
GUILD_RATE_WINDOW_MS=60000

# Optional thread engagement controls
ALLOW_THREAD_RESPONSES=true
ALLOWED_THREAD_IDS=123456789,987654321

# Optional image generation overrides
IMAGE_DEFAULT_TEXT_MODEL=gpt-5-mini
IMAGE_DEFAULT_IMAGE_MODEL=gpt-image-1-mini
IMAGE_TOKENS_PER_REFRESH=10
IMAGE_TOKEN_REFRESH_INTERVAL_MS=86400000

# Optional channel context manager configuration
CONTEXT_MANAGER_ENABLED=true
CONTEXT_MANAGER_MAX_MESSAGES=50
CONTEXT_MANAGER_RETENTION_MS=3600000
CONTEXT_MANAGER_EVICTION_INTERVAL_MS=300000

# Optional LLM cost tracking configuration
COST_ESTIMATOR_ENABLED=true

# Optional realtime engagement filter configuration
REALTIME_FILTER_ENABLED=false

# Engagement scoring weights (0-1 range, higher = more influence)
ENGAGEMENT_WEIGHT_MENTION=0.3
ENGAGEMENT_WEIGHT_QUESTION=0.2
ENGAGEMENT_WEIGHT_TECHNICAL=0.15
ENGAGEMENT_WEIGHT_HUMAN_ACTIVITY=0.15
ENGAGEMENT_WEIGHT_COST_SATURATION=0.1
ENGAGEMENT_WEIGHT_BOT_NOISE=0.05
ENGAGEMENT_WEIGHT_DM_BOOST=1.5
ENGAGEMENT_WEIGHT_DECAY=0.05

# Engagement behavior preferences
ENGAGEMENT_IGNORE_MODE=silent
ENGAGEMENT_REACTION_EMOJI=dY\`?
ENGAGEMENT_MIN_THRESHOLD=0.5
ENGAGEMENT_PROBABILISTIC_LOW=0.4
ENGAGEMENT_PROBABILISTIC_HIGH=0.6
ENGAGEMENT_ENABLE_LLM_REFINEMENT=false

# Provenance storage configuration
PROVENANCE_SQLITE_PATH=/data/provenance.db

# Optional web server configuration
WEB_BASE_URL=https://your-domain.com`;
                          document.body.appendChild(textArea);
                          textArea.select();
                          document.execCommand('copy');
                          document.body.removeChild(textArea);
                          showToast(setOptionalToast, 'Copied to clipboard');
                        }
                      }}
                      style={{ 
                        fontSize: '1.2rem', 
                        padding: '0.5rem',
                        width: '2.5rem',
                        height: '2.5rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '50%',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--subtle-text)',
                        cursor: 'pointer'
                      }}
                      title="Copy optional variables"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                    </button>
                    {optionalToast.visible && (
                      <div style={{
                        position: 'fixed',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        background: 'var(--bg-alt)',
                        color: 'var(--text)',
                        padding: '0.5rem 1rem',
                        borderRadius: '6px',
                        fontSize: '0.85rem',
                        border: '1px solid var(--border)',
                        boxShadow: '0 4px 12px var(--shadow)',
                        zIndex: 1000,
                        opacity: optionalToast.visible ? 1 : 0,
                        transition: 'opacity 0.3s ease',
                        whiteSpace: 'nowrap'
                      }}>
                        {optionalToast.message}
                      </div>
                    )}
                  </div>
                </div>
                <pre style={{ 
                  background: 'var(--bg-soft)', 
                  padding: '1rem', 
                  borderRadius: '8px', 
                  overflow: 'auto',
                  fontSize: '0.9rem',
                  lineHeight: '1.4',
                  border: '1px solid var(--border)',
                  maxHeight: '400px'
                }}>
{`# Optional prompt configuration overrides
PROMPT_CONFIG_PATH=path/to/prompts.yaml    # Custom prompt config file (String)

# Optional rate limiting overrides
RATE_LIMIT_USER=true                       # Enable user-level rate limiting (Boolean)
USER_RATE_LIMIT=5                          # User rate limit count (Integer ≥ 1)
USER_RATE_WINDOW_MS=60000                  # User rate limit window in ms (Integer)
RATE_LIMIT_CHANNEL=true                    # Enable channel-level rate limiting (Boolean)
CHANNEL_RATE_LIMIT=10                      # Channel rate limit count (Integer ≥ 1)
CHANNEL_RATE_WINDOW_MS=60000               # Channel rate limit window in ms (Integer)
RATE_LIMIT_GUILD=true                      # Enable guild-level rate limiting (Boolean)
GUILD_RATE_LIMIT=20                        # Guild rate limit count (Integer ≥ 1)
GUILD_RATE_WINDOW_MS=60000                 # Guild rate limit window in ms (Integer)

# Optional thread engagement controls
ALLOW_THREAD_RESPONSES=true                # Allow responses in threads (Boolean)
ALLOWED_THREAD_IDS=123456789,987654321     # Thread IDs whitelist (String)

# Optional image generation overrides
IMAGE_DEFAULT_TEXT_MODEL=gpt-5-mini        # Default text model (String)
IMAGE_DEFAULT_IMAGE_MODEL=gpt-image-1-mini # Default image model (String)
IMAGE_TOKENS_PER_REFRESH=10                # Tokens per refresh (Integer ≥ 1)
IMAGE_TOKEN_REFRESH_INTERVAL_MS=86400000   # Token refresh interval in ms (Integer)

# Optional channel context manager configuration
CONTEXT_MANAGER_ENABLED=true               # Enable per-channel state tracking (Boolean)
CONTEXT_MANAGER_MAX_MESSAGES=50            # Max messages per channel (Integer ≥ 1)
CONTEXT_MANAGER_RETENTION_MS=3600000       # Message retention time in ms (Integer)
CONTEXT_MANAGER_EVICTION_INTERVAL_MS=300000 # Cleanup frequency in ms (Integer)

# Optional LLM cost tracking configuration
COST_ESTIMATOR_ENABLED=true                # Enable cost tracking (Boolean)

# Optional realtime engagement filter configuration
REALTIME_FILTER_ENABLED=false              # Enable weighted engagement scoring (Boolean)

# Engagement scoring weights (0-1 range, higher = more influence)
ENGAGEMENT_WEIGHT_MENTION=0.3              # Weight for mentions/replies (Float: 0.0-1.0)
ENGAGEMENT_WEIGHT_QUESTION=0.2            # Weight for questions (Float: 0.0-1.0)
ENGAGEMENT_WEIGHT_TECHNICAL=0.15          # Weight for technical keywords (Float: 0.0-1.0)
ENGAGEMENT_WEIGHT_HUMAN_ACTIVITY=0.15     # Weight for human activity (Float: 0.0-1.0)
ENGAGEMENT_WEIGHT_COST_SATURATION=0.1     # Weight for cost velocity (Float: 0.0-1.0)
ENGAGEMENT_WEIGHT_BOT_NOISE=0.05          # Weight for bot noise (Float: 0.0-1.0)
ENGAGEMENT_WEIGHT_DM_BOOST=1.5            # DM context multiplier (Float ≥ 0)
ENGAGEMENT_WEIGHT_DECAY=0.05              # Time decay factor (Float ≥ 0)

# Engagement behavior preferences
ENGAGEMENT_IGNORE_MODE=silent              # Skip acknowledgment mode (String: "silent" or "react")
ENGAGEMENT_REACTION_EMOJI=dY\`?            # Emoji for reactions (String)
ENGAGEMENT_MIN_THRESHOLD=0.5               # Minimum score to engage (Float: 0.0-1.0)
ENGAGEMENT_PROBABILISTIC_LOW=0.4          # Lower bound for LLM refinement (Float: 0.0-1.0)
ENGAGEMENT_PROBABILISTIC_HIGH=0.6         # Upper bound for LLM refinement (Float: 0.0-1.0)
ENGAGEMENT_ENABLE_LLM_REFINEMENT=false    # Use LLM for score refinement (Boolean)

# Provenance storage configuration
PROVENANCE_SQLITE_PATH=/data/provenance.db # SQLite database path

# Optional web server configuration
WEB_BASE_URL=https://your-domain.com       # Base URL for web server (String)`}
                </pre>
                <p><strong>Note:</strong> This is a representative sample. See <code>.env.example</code> for the complete list of available configuration options.</p>
              </div>
            </div>

            {/* Running Locally */}
            <div className="card" aria-labelledby="running-title">
              <h2 id="running-title">Running Locally</h2>
              <p>To run both services from the repository root:</p>
              <div style={{ position: 'relative' }}>
                <pre style={{ 
                  background: 'var(--bg-soft)', 
                  padding: '1rem', 
                  borderRadius: '8px', 
                  overflow: 'auto',
                  fontSize: '0.9rem',
                  lineHeight: '1.4',
                  border: '1px solid var(--border)',
                  paddingTop: '3rem'
                }}>
{`npm run start:dev`}
                </pre>
                <button 
                  className="cta-button secondary" 
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText('npm run start:dev');
                          showToast(setDevToast, 'Copied to clipboard');
                    } catch (err) {
                      console.error('Failed to copy to clipboard:', err);
                      const textArea = document.createElement('textarea');
                      textArea.value = 'npm run start:dev';
                      document.body.appendChild(textArea);
                      textArea.select();
                      document.execCommand('copy');
                      document.body.removeChild(textArea);
                          showToast(setDevToast, 'Copied to clipboard');
                    }
                  }}
                      style={{ 
                        position: 'absolute',
                        top: '0.5rem',
                        right: '0.5rem',
                        fontSize: '1rem', 
                        padding: '0.4rem',
                        width: '2rem',
                        height: '2rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '4px',
                        zIndex: 10,
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--subtle-text)',
                        cursor: 'pointer'
                      }}
                  title="Copy dev command"
                >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                </button>
                    {devToast.visible && (
                      <div style={{
                        position: 'absolute',
                        top: '-2.5rem',
                        right: '0',
                        background: 'var(--bg-alt)',
                        color: 'var(--text)',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '4px',
                        fontSize: '0.8rem',
                        border: '1px solid var(--border)',
                        boxShadow: '0 2px 8px var(--shadow)',
                        zIndex: 1000,
                        opacity: devToast.visible ? 1 : 0,
                        transition: 'opacity 0.3s ease',
                        whiteSpace: 'nowrap'
                      }}>
                        {devToast.message}
                      </div>
                    )}
              </div>
              <p>This will start both the Discord bot and the web interface. The web interface will be available at <code>http://localhost:5173</code>.</p>
              <p>To run only the web UI, use: <code>npm run dev -w @arete/web</code></p>
            </div>

            {/* Deployment Options */}
            <div className="card" aria-labelledby="deployment-title">
              <h2 id="deployment-title">Deployment Options</h2>
              
              <div className="feature-card">
                <h3>Local Production</h3>
                <p>For local production deployment:</p>
                <div style={{ position: 'relative' }}>
                  <pre style={{ 
                    background: 'var(--bg-soft)', 
                    padding: '1rem', 
                    borderRadius: '8px', 
                    overflow: 'auto',
                    fontSize: '0.9rem',
                    lineHeight: '1.4',
                    border: '1px solid var(--border)',
                    paddingTop: '3rem'
                  }}>
{`npm run build && npm start`}
                  </pre>
                  <button 
                    className="cta-button secondary" 
                    onClick={async () => {
                      try {
                        const buildCommands = `npm run build && npm start`;
                        await navigator.clipboard.writeText(buildCommands);
                          showToast(setBuildToast, 'Copied to clipboard');
                      } catch (err) {
                        console.error('Failed to copy to clipboard:', err);
                        const textArea = document.createElement('textarea');
                        textArea.value = `npm run build && npm start`;
                        document.body.appendChild(textArea);
                        textArea.select();
                        document.execCommand('copy');
                        document.body.removeChild(textArea);
                          showToast(setBuildToast, 'Copied to clipboard');
                      }
                    }}
                      style={{ 
                        position: 'absolute',
                        top: '0.5rem',
                        right: '0.5rem',
                        fontSize: '1rem', 
                        padding: '0.4rem',
                        width: '2rem',
                        height: '2rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '4px',
                        zIndex: 10,
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--subtle-text)',
                        cursor: 'pointer'
                      }}
                    title="Copy build commands"
                  >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                  </button>
                    {buildToast.visible && (
                      <div style={{
                        position: 'absolute',
                        top: '-2.5rem',
                        right: '0',
                        background: 'var(--bg-alt)',
                        color: 'var(--text)',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '4px',
                        fontSize: '0.8rem',
                        border: '1px solid var(--border)',
                        boxShadow: '0 2px 8px var(--shadow)',
                        zIndex: 1000,
                        opacity: buildToast.visible ? 1 : 0,
                        transition: 'opacity 0.3s ease',
                        whiteSpace: 'nowrap'
                      }}>
                        {buildToast.message}
                      </div>
                    )}
                </div>
              </div>

              <div className="feature-card">
                <h3>Fly.io Deployment</h3>
                <p>Deploy to Fly.io for cloud hosting:</p>
                <div style={{ position: 'relative', marginBottom: '1rem' }}>
                  <pre style={{ 
                    background: 'var(--bg-soft)', 
                    padding: '1rem', 
                    borderRadius: '8px', 
                    overflow: 'auto',
                    fontSize: '0.9rem',
                    lineHeight: '1.4',
                    border: '1px solid var(--border)',
                    paddingTop: '3rem'
                  }}>
{`flyctl launch`}
                  </pre>
                  <button 
                    className="cta-button secondary" 
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText('flyctl launch');
                          showToast(setLaunchToast, 'Copied to clipboard');
                      } catch (err) {
                        console.error('Failed to copy to clipboard:', err);
                        const textArea = document.createElement('textarea');
                        textArea.value = 'flyctl launch';
                        document.body.appendChild(textArea);
                        textArea.select();
                        document.execCommand('copy');
                        document.body.removeChild(textArea);
                          showToast(setLaunchToast, 'Copied to clipboard');
                      }
                    }}
                      style={{ 
                        position: 'absolute',
                        top: '0.5rem',
                        right: '0.5rem',
                        fontSize: '1rem', 
                        padding: '0.4rem',
                        width: '2rem',
                        height: '2rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '4px',
                        zIndex: 10,
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--subtle-text)',
                        cursor: 'pointer'
                      }}
                    title="Copy Fly.io launch command"
                  >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                  </button>
                    {launchToast.visible && (
                      <div style={{
                        position: 'absolute',
                        top: '-2.5rem',
                        right: '0',
                        background: 'var(--bg-alt)',
                        color: 'var(--text)',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '4px',
                        fontSize: '0.8rem',
                        border: '1px solid var(--border)',
                        boxShadow: '0 2px 8px var(--shadow)',
                        zIndex: 1000,
                        opacity: launchToast.visible ? 1 : 0,
                        transition: 'opacity 0.3s ease',
                        whiteSpace: 'nowrap'
                      }}>
                        {launchToast.message}
                      </div>
                    )}
                </div>
                <div style={{ position: 'relative' }}>
                  <pre style={{ 
                    background: 'var(--bg-soft)', 
                    padding: '1rem', 
                    borderRadius: '8px', 
                    overflow: 'auto',
                    fontSize: '0.9rem',
                    lineHeight: '1.4',
                    border: '1px solid var(--border)',
                    paddingTop: '3rem'
                  }}>
{`flyctl deploy`}
                  </pre>
                  <button 
                    className="cta-button secondary" 
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText('flyctl deploy');
                          showToast(setDeployToast, 'Copied to clipboard');
                      } catch (err) {
                        console.error('Failed to copy to clipboard:', err);
                        const textArea = document.createElement('textarea');
                        textArea.value = 'flyctl deploy';
                        document.body.appendChild(textArea);
                        textArea.select();
                        document.execCommand('copy');
                        document.body.removeChild(textArea);
                          showToast(setDeployToast, 'Copied to clipboard');
                      }
                    }}
                      style={{ 
                        position: 'absolute',
                        top: '0.5rem',
                        right: '0.5rem',
                        fontSize: '1rem', 
                        padding: '0.4rem',
                        width: '2rem',
                        height: '2rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '4px',
                        zIndex: 10,
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--subtle-text)',
                        cursor: 'pointer'
                      }}
                    title="Copy Fly.io deploy command"
                  >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                      </svg>
                  </button>
                    {deployToast.visible && (
                      <div style={{
                        position: 'absolute',
                        top: '-2.5rem',
                        right: '0',
                        background: 'var(--bg-alt)',
                        color: 'var(--text)',
                        padding: '0.4rem 0.8rem',
                        borderRadius: '4px',
                        fontSize: '0.8rem',
                        border: '1px solid var(--border)',
                        boxShadow: '0 2px 8px var(--shadow)',
                        zIndex: 1000,
                        opacity: deployToast.visible ? 1 : 0,
                        transition: 'opacity 0.3s ease',
                        whiteSpace: 'nowrap'
                      }}>
                        {deployToast.message}
                      </div>
                    )}
                </div>
                <p>Make sure to set your environment variables in the Fly.io dashboard after deployment.</p>
              </div>
            </div>

            {/* Additional Resources */}
            <div className="card" aria-labelledby="resources-title">
              <h2 id="resources-title">Additional Resources</h2>
              <div className="services-grid">
                <div className="feature-card">
                  <h3>Documentation</h3>
                  <p>Comprehensive setup and configuration guides</p>
                  <a href="https://github.com/arete-org/arete/blob/main/README.md" className="cta-button" target="_blank" rel="noopener noreferrer">
                    View Documentation
                  </a>
                </div>
                <div className="feature-card">
                  <h3>Discord Bot Setup</h3>
                  <p>Learn how to create and configure Discord bots</p>
                  <a href="https://discord.com/developers/docs/getting-started" className="cta-button" target="_blank" rel="noopener noreferrer">
                    Discord Developer Guide
                  </a>
                </div>
                <div className="feature-card">
                  <h3>Support</h3>
                  <p>Get help from the community</p>
                  <a href="https://github.com/arete-org/arete/issues" className="cta-button" target="_blank" rel="noopener noreferrer">
                    Report Issues
                  </a>
                </div>
              </div>
            </div>
        </section>
      </main>

      <Footer />
    </>
  );
};

export default InvitePage;
