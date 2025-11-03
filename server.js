const http = require('node:http');
const fs = require('node:fs/promises');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Load environment variables from .env file
require('dotenv').config();

// Resolve the directory containing the built frontend assets.
const DIST_DIR = path.join(__dirname, 'packages', 'web', 'dist');

// Resolve the directory for storing trace files.
const TRACES_DIR = path.resolve(process.env.TRACE_STORE_PATH?.trim() || path.join(__dirname, 'traces'));

// Model parameters
const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_REASONING_EFFORT = 'low';
const DEFAULT_VERBOSITY = 'low';
const DEFAULT_CHANNEL_CONTEXT = {
  channelId: 'default'
};

// Metadata parsing constants
const METADATA_MARKER = '<ARETE_METADATA>';

/**
 * Extracts text and metadata from AI response that may contain <ARETE_METADATA> payload
 */
function extractTextAndMetadata(rawOutputText) {
  if (!rawOutputText) {
    return { normalizedText: '', metadata: null };
  }

  const markerIndex = rawOutputText.lastIndexOf(METADATA_MARKER);
  if (markerIndex === -1) {
    // No metadata marker found, return plain text
    return { normalizedText: rawOutputText.trimEnd(), metadata: null };
  }

  const conversationalPortion = rawOutputText.slice(0, markerIndex).trimEnd();
  let metadataCandidate = rawOutputText.slice(markerIndex + METADATA_MARKER.length).trim();

  // Remove common code-fence wrappers
  metadataCandidate = metadataCandidate.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  metadataCandidate = metadataCandidate.replace(/^```\s*/, '').replace(/\s*```$/, '');

  if (!metadataCandidate) {
    return { normalizedText: conversationalPortion, metadata: null };
  }

  try {
    const parsed = JSON.parse(metadataCandidate);
    return { normalizedText: conversationalPortion, metadata: parsed };
  } catch (error) {
    console.warn('Failed to parse assistant metadata payload:', error);
    return { normalizedText: conversationalPortion, metadata: null };
  }
}

/**
 * Verifies GitHub webhook signature using HMAC-SHA256
 */
function verifyGitHubSignature(secret, body, signature) {
  try {
    const expectedSignature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    
    // Convert both signatures to buffers
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const receivedBuffer = Buffer.from(signature, 'utf8');
    
    // Check if buffers have the same length before comparison
    if (expectedBuffer.length !== receivedBuffer.length) {
      return false;
    }
    
    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
  } catch (error) {
    console.error('Error verifying GitHub signature:', error);
    return false;
  }
}

/**
 * Writes a blog post to the file system based on GitHub discussion data
 */
async function writeBlogPost(discussion) {
  const BLOG_POSTS_DIR = path.join(__dirname, 'packages', 'web', 'public', 'blog-posts');
  
  try {
    await fsPromises.mkdir(BLOG_POSTS_DIR, { recursive: true });
    
    const postObject = {
      number: discussion.number,
      title: discussion.title,
      body: discussion.body,
      author: {
        login: discussion.user.login,
        avatarUrl: discussion.user.avatar_url,
        profileUrl: discussion.user.html_url
      },
      createdAt: discussion.created_at,
      updatedAt: discussion.updated_at,
      discussionUrl: discussion.html_url,
      commentCount: discussion.comments || 0
    };
    
    const postFilePath = path.join(BLOG_POSTS_DIR, `${discussion.number}.json`);
    await fsPromises.writeFile(postFilePath, JSON.stringify(postObject, null, 2));
    
    const indexFilePath = path.join(BLOG_POSTS_DIR, 'index.json');
    let indexArray = [];
    try {
      const indexContent = await fsPromises.readFile(indexFilePath, 'utf8');
      indexArray = JSON.parse(indexContent);
    } catch (error) {
      // If file doesn't exist or is invalid, start with empty array
      indexArray = [];
    }
    
    // Remove existing entry if present
    indexArray = indexArray.filter(post => post.number !== discussion.number);
    
    // Add new/updated entry
    indexArray.push({
      number: discussion.number,
      title: discussion.title,
      author: {
        login: discussion.user.login,
        avatarUrl: discussion.user.avatar_url,
        profileUrl: discussion.user.html_url
      },
      createdAt: discussion.created_at,
      updatedAt: discussion.updated_at
    });
    
    // Sort by number descending (newest first)
    indexArray.sort((a, b) => b.number - a.number);
    
    await fsPromises.writeFile(indexFilePath, JSON.stringify(indexArray, null, 2));
  } catch (error) {
    console.error('Error writing blog post:', error);
    throw error;
  }
}

// Content-Type lookups keep browsers happy when serving static files.
const MIME_MAP = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

/**
 * Attempts to read a file from disk and returns undefined when the file is
 * missing. This keeps the control flow tidy when we try multiple fallbacks.
 */
const tryReadFile = async (filePath) => {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      // Bubble up unexpected I/O errors so the caller can log the failure.
      throw error;
    }
    return undefined;
  }
};

/**
 * Small helper that sanitizes user-supplied paths so requests cannot escape the
 * dist directory. Any attempt to climb above the folder collapses to an empty
 * string, which we later interpret as the site root.
 */
const sanitizePath = (rawPath) => {
  const decoded = decodeURIComponent(rawPath.split('?')[0] || '/');
  const normalized = path.normalize(decoded);

  if (normalized.startsWith('..')) {
    return '';
  }

  return normalized.replace(/^\/+/, '');
};

/**
 * Resolves the file to serve for a given request.
 * - Direct file hits are served as-is.
 * - Directory requests append index.html.
 * - Missing files fall back to the SPA shell (index.html).
 */
const resolveAsset = async (requestPath) => {
  const sanitized = sanitizePath(requestPath);
  const targetPath = sanitized.length === 0 ? 'index.html' : sanitized;

  const absolutePath = path.join(DIST_DIR, targetPath);
  const stats = await fs
    .stat(absolutePath)
    .catch(() => undefined);

  if (stats && stats.isDirectory()) {
    const nestedIndex = path.join(absolutePath, 'index.html');
    const nestedContent = await tryReadFile(nestedIndex);
    if (nestedContent) {
      return { content: nestedContent, absolutePath: nestedIndex };
    }
  }

  const directContent = await tryReadFile(absolutePath);
  if (directContent) {
    return { content: directContent, absolutePath };
  }

  const fallbackPath = path.join(DIST_DIR, 'index.html');
  const fallbackContent = await tryReadFile(fallbackPath);
  if (fallbackContent) {
    return { content: fallbackContent, absolutePath: fallbackPath };
  }

  return undefined;
};

/**
 * Builds a short log entry for monitoring within Fly.io logs.
 */
const logRequest = (req, res, extra = '') => {
  const timestamp = new Date().toISOString();
  
  // Sanitize URL for /api/reflect to prevent CAPTCHA token leakage
  let logUrl = req.url;
  if (req.url && req.url.includes('/api/reflect')) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      // Reconstruct pathname without query parameters for reflect logs
      logUrl = parsedUrl.pathname;
    } catch (error) {
      // Fallback to original URL if parsing fails
      logUrl = req.url;
    }
  }
  
  // eslint-disable-next-line no-console
  console.log(`[${timestamp}] ${req.method} ${logUrl} -> ${res.statusCode} ${extra}`);
};

/**
 * Simple rate limiter implementation
 */
class SimpleRateLimiter {
  constructor(options) {
    this.limit = options.limit;
    this.window = options.window;
    this.requests = new Map();
  }

  check(identifier) {
    const now = Date.now();
    const userRequests = this.requests.get(identifier) || [];
    
    // Remove old requests outside the window
    const validRequests = userRequests.filter(time => now - time < this.window);
    
    if (validRequests.length >= this.limit) {
      const oldestRequest = Math.min(...validRequests);
      const retryAfter = Math.ceil((oldestRequest + this.window - now) / 1000);
      return { allowed: false, retryAfter };
    }
    
    // Add current request
    validRequests.push(now);
    this.requests.set(identifier, validRequests);
    
    return { allowed: true, retryAfter: 0 };
  }

  cleanup() {
    const now = Date.now();
    for (const [identifier, requests] of this.requests.entries()) {
      const validRequests = requests.filter(time => now - time < this.window);
      if (validRequests.length === 0) {
        this.requests.delete(identifier);
      } else {
        this.requests.set(identifier, validRequests);
      }
    }
  }
}

/**
 * Simple OpenAI service implementation
 */
class SimpleOpenAIService {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }

  async generateResponse(model, messages, options = {}) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        max_completion_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error details:', errorText);
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    const rawContent = data.choices[0]?.message?.content || 'I was unable to generate a response.';
    
    // Debug: log raw content to see if metadata is present
    console.log('=== Raw AI Response Debug ===');
    console.log('Raw content length:', rawContent.length);
    console.log('Contains ARETE_METADATA:', rawContent.includes('<ARETE_METADATA>'));
    if (rawContent.includes('<ARETE_METADATA>')) {
      const metadataStart = rawContent.indexOf('<ARETE_METADATA>');
      console.log('Metadata block:', rawContent.substring(metadataStart, metadataStart + 200));
    }
    console.log('============================');
    
    // Parse metadata from the response if it contains <ARETE_METADATA>
    const { normalizedText, metadata: parsedMetadata } = extractTextAndMetadata(rawContent);
    
    return {
      normalizedText: normalizedText,
      metadata: {
        model: model, // Use the requested model, not what OpenAI returns
        usage: data.usage,
        finishReason: data.choices[0]?.finish_reason,
        // Include parsed metadata if available
        ...(parsedMetadata && {
          // Only include confidence if it's a valid number in range
          ...(typeof parsedMetadata.confidence === 'number' && 
              parsedMetadata.confidence >= 0 && 
              parsedMetadata.confidence <= 1 && {
                confidence: parsedMetadata.confidence
              }),
          provenance: parsedMetadata.provenance,
          tradeoffCount: parsedMetadata.tradeoffCount,
          citations: parsedMetadata.citations
        })
      }
    };
  }
}

/**
 * Simple response metadata builder
 */
const buildResponseMetadata = (assistantMetadata, reasoningEffort, runtimeContext) => {
  const metadata = {
    id: `reflect-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    model: assistantMetadata.model || DEFAULT_MODEL,
    reasoningEffort: assistantMetadata.reasoningEffort || DEFAULT_REASONING_EFFORT,
    verbosity: assistantMetadata.verbosity || DEFAULT_VERBOSITY,
    channelContext: assistantMetadata.channelContext || DEFAULT_CHANNEL_CONTEXT,
    runtimeContext,
    usage: assistantMetadata.usage,
    finishReason: assistantMetadata.finishReason,
    staleAfter: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours
  };

  // Include confidence if available (0.0 to 1.0 range)
  if (typeof assistantMetadata.confidence === 'number' && 
      assistantMetadata.confidence >= 0 && 
      assistantMetadata.confidence <= 1) {
    metadata.confidence = assistantMetadata.confidence;
  }

  // Include tradeoffCount if available
  if (typeof assistantMetadata.tradeoffCount === 'number') {
    metadata.tradeoffCount = assistantMetadata.tradeoffCount;
  }

  // Include citations if available
  if (Array.isArray(assistantMetadata.citations)) {
    metadata.citations = assistantMetadata.citations;
  }

  return metadata;
};

/**
 * Stores trace metadata to disk asynchronously.
 * Failures are logged but don't block the response.
 */
const storeTrace = async (metadata) => {
  try {
    // Ensure traces directory exists
    await fsPromises.mkdir(TRACES_DIR, { recursive: true });
    
    // Validate responseId (metadata.id) - only allow alphanumeric, hyphens, underscores
    const responseId = metadata.id;
    if (!/^[A-Za-z0-9_-]+$/.test(responseId)) {
      console.error(`Invalid responseId "${responseId}" - not storing trace.`);
      return;
    }
    
    // Write trace file
    const filePath = path.join(TRACES_DIR, `${responseId}.json`);
    const traceContent = JSON.stringify(metadata, null, 2);
    
    console.log('=== Storing Trace Debug ===');
    console.log('Response ID:', responseId);
    console.log('Metadata being stored:', traceContent);
    console.log('Metadata confidence:', metadata.confidence);
    console.log('===========================');
    
    await fsPromises.writeFile(filePath, traceContent, { encoding: 'utf-8' });
    console.log(`Trace stored successfully: ${filePath}`);
  } catch (error) {
    // Log but don't throw - trace storage failures shouldn't break the API
    console.error(`Failed to store trace for response "${metadata.id}":`, error instanceof Error ? error.message : error);
  }
};

// Initialize services
let openaiService = null;
let ipRateLimiter = null;
let sessionRateLimiter = null;

const initializeServices = () => {
  // Debug: Log environment variables
  console.log('Environment variables check:');
  console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'SET' : 'NOT SET');
  console.log('TURNSTILE_SECRET_KEY:', process.env.TURNSTILE_SECRET_KEY ? 'SET' : 'NOT SET');
  console.log('TURNSTILE_SITE_KEY:', process.env.TURNSTILE_SITE_KEY ? 'SET' : 'NOT SET');
  console.log('NODE_ENV:', process.env.NODE_ENV || 'NOT SET');
  console.log('SKIP_CAPTCHA:', process.env.SKIP_CAPTCHA || 'NOT SET');
  
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY environment variable is required');
  }

  openaiService = new SimpleOpenAIService(process.env.OPENAI_API_KEY);
  
  // Initialize rate limiters
  ipRateLimiter = new SimpleRateLimiter({
    limit: parseInt(process.env.WEB_API_RATE_LIMIT_IP) || 3,
    window: parseInt(process.env.WEB_API_RATE_LIMIT_IP_WINDOW_MS) || 60000,
  });

  sessionRateLimiter = new SimpleRateLimiter({
    limit: parseInt(process.env.WEB_API_RATE_LIMIT_SESSION) || 5,
    window: parseInt(process.env.WEB_API_RATE_LIMIT_SESSION_WINDOW_MS) || 60000,
  });

  // Schedule periodic cleanup
  setInterval(() => {
    ipRateLimiter.cleanup();
    sessionRateLimiter.cleanup();
  }, 2 * 60 * 1000); // Cleanup every 2 minutes

  console.log('Services initialized successfully');
};

/**
 * Handles requests to the /api/reflect endpoint.
 */
const handleReflectRequest = async (req, res, parsedUrl) => {
  try {
    // Verify Turnstile configuration
    if (!process.env.TURNSTILE_SECRET_KEY) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'CAPTCHA verification not configured' }));
      logRequest(req, res, 'reflect captcha-not-configured');
      return;
    }

    // Allow GET and POST requests
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      logRequest(req, res, 'reflect method-not-allowed');
      return;
    }

    // Extract and validate question parameter
    let question = parsedUrl.searchParams.get('question');
    let turnstileTokenFromBody = null;
    
    // Handle POST requests with JSON body
    if (req.method === 'POST') {
      try {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        
        await new Promise((resolve, reject) => {
          req.on('end', resolve);
          req.on('error', reject);
        });
        
        if (body) {
          const parsedBody = JSON.parse(body);
          if (parsedBody.question) {
            question = parsedBody.question;
          }
          if (parsedBody.turnstileToken) {
            turnstileTokenFromBody = String(parsedBody.turnstileToken);
          }
        }
      } catch (error) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        logRequest(req, res, 'reflect invalid-json');
        return;
      }
    }
    
    if (!question || question.trim().length === 0) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Question parameter is required' }));
      logRequest(req, res, 'reflect missing-question');
      return;
    }

    // Guard against excessively long question
    const MAX_QUESTION_LENGTH = 3072;
    if (question.length > MAX_QUESTION_LENGTH) {
      res.statusCode = 413;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Question parameter too long' }));
      logRequest(req, res, 'reflect question-too-long');
      return;
    }

    // Check if CAPTCHA should be skipped first
    const skipCaptcha = process.env.NODE_ENV === 'development' || process.env.SKIP_CAPTCHA === 'true';
    
    // Extract Turnstile token (priority: header → body → query param)
    let turnstileToken = null;
    let tokenSource = 'none';
    
    // Try header first (most secure, not exposed in URL)
    if (req.headers['x-turnstile-token']) {
      turnstileToken = req.headers['x-turnstile-token'];
      if (Array.isArray(turnstileToken)) {
        turnstileToken = turnstileToken[0];
      } else {
        turnstileToken = String(turnstileToken);
      }
      tokenSource = 'header';
    }
    
    // Try POST body if available and header didn't have it
    if (!turnstileToken && turnstileTokenFromBody) {
      turnstileToken = turnstileTokenFromBody;
      tokenSource = 'body';
    }
    
    // Fallback to query param (least secure, but works for GET requests)
    if (!turnstileToken) {
      const queryToken = parsedUrl.searchParams.get('turnstileToken');
      if (queryToken) {
        turnstileToken = String(queryToken);
        tokenSource = 'query';
      }
    }
    
    // Log token extraction for debugging
    if (!skipCaptcha) {
      console.log(`Turnstile token extraction: source=${tokenSource}, length=${turnstileToken?.length || 0}`);
    }
    
    if (!turnstileToken && !skipCaptcha) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'CAPTCHA token is required', details: 'Missing turnstile token' }));
      logRequest(req, res, 'reflect missing-captcha-token');
      return;
    }

    // Extract client IP
    let clientIp = req.socket.remoteAddress || 'unknown';
    
    const trustProxy = process.env.WEB_TRUST_PROXY === 'true';
    if (trustProxy) {
      const forwardedFor = req.headers['x-forwarded-for'];
      if (forwardedFor) {
        if (typeof forwardedFor === 'string') {
          clientIp = forwardedFor.split(',')[0].trim();
        } else if (Array.isArray(forwardedFor)) {
          clientIp = forwardedFor[0].trim();
        }
      }
    }
    
    if (clientIp.startsWith('::ffff:')) {
      clientIp = clientIp.substring(7);
    }
    
    // Extract session ID
    let sessionId = parsedUrl.searchParams.get('sessionId');
    
    if (!sessionId) {
      const rawSessionId = req.headers['x-session-id'];
      if (rawSessionId) {
        let sessionIdStr = Array.isArray(rawSessionId) ? rawSessionId[0] : String(rawSessionId);
        sessionIdStr = sessionIdStr.trim().substring(0, 128);
        sessionIdStr = sessionIdStr.replace(/[^a-zA-Z0-9\-_]/g, '');
        if (sessionIdStr.length > 0) {
          sessionId = sessionIdStr;
        }
      }
    }
    
    if (!sessionId) {
      sessionId = `ip-${clientIp}`;
    }

    // Verify Turnstile token with Cloudflare
    try {
      // Skip CAPTCHA verification in development mode
      if (skipCaptcha) {
        console.log('Skipping CAPTCHA verification in development mode');
        logRequest(req, res, `reflect captcha-skipped-dev-mode ip=${clientIp}`);
      } else {
        // Debug: Log CAPTCHA verification info (without exposing sensitive data)
        console.log('CAPTCHA verification debug:');
        console.log(`  Token source: ${tokenSource}`);
        console.log(`  Token length: ${turnstileToken?.length || 0}`);
        console.log(`  Secret key is set: ${!!process.env.TURNSTILE_SECRET_KEY}`);
        console.log(`  Client IP: ${clientIp}`);
        
        // Validate token exists before attempting verification
        if (!turnstileToken || turnstileToken.trim().length === 0) {
          console.error('CAPTCHA verification attempted without a token');
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ 
            error: 'CAPTCHA token is required', 
            details: 'Missing turnstile token' 
          }));
          logRequest(req, res, 'reflect missing-captcha-token');
          return;
        }
        
        // Validate secret key is configured
        if (!process.env.TURNSTILE_SECRET_KEY) {
          console.error('CAPTCHA verification attempted without secret key');
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ 
            error: 'CAPTCHA verification not configured',
            details: 'TURNSTILE_SECRET_KEY is not set'
          }));
          logRequest(req, res, 'reflect captcha-not-configured');
          return;
        }
        
        const formData = new URLSearchParams();
        formData.append('secret', process.env.TURNSTILE_SECRET_KEY);
        formData.append('response', turnstileToken);
        formData.append('remoteip', clientIp);
        
        // Create abort signal with fallback for older Node versions
        let abortSignal;
        try {
          abortSignal = AbortSignal.timeout(10000);
        } catch (e) {
          // Fallback for Node < 17.3.0 (shouldn't be needed but safer)
          const controller = new AbortController();
          setTimeout(() => controller.abort(), 10000);
          abortSignal = controller.signal;
        }
        
        const verificationResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
          signal: abortSignal
        });

        if (!verificationResponse.ok) {
          const errorText = await verificationResponse.text().catch(() => 'Unable to read error response');
          console.error(`Turnstile verification service error: ${verificationResponse.status} ${verificationResponse.statusText}`);
          console.error(`Error response body: ${errorText}`);
          
          // Try to parse error details
          let errorDetails;
          try {
            errorDetails = JSON.parse(errorText);
          } catch {
            errorDetails = { 'error-codes': ['unknown-error'] };
          }
          
          const errorCodes = errorDetails['error-codes'] || [];
          
          // Handle specific error codes appropriately
          if (errorCodes.includes('invalid-input-secret') || errorCodes.includes('missing-input-secret')) {
            console.error('CAPTCHA configuration error: Secret key is invalid or does not match site key');
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({ 
              error: 'CAPTCHA verification failed', 
              details: 'Invalid CAPTCHA configuration. Secret key does not match site key.'
            }));
            logRequest(req, res, `reflect captcha-config-error ip=${clientIp} codes=${errorCodes.join(',')}`);
            return;
          }
          
          throw new Error(`Verification service returned ${verificationResponse.status}: ${errorText}`);
        }

        const verificationData = await verificationResponse.json();
        
        // Debug: Log verification response
        console.log('Turnstile verification response:', JSON.stringify(verificationData, null, 2));
        
        if (!verificationData.success) {
          const errorCodes = verificationData['error-codes'] || [];
          const errorCodesStr = errorCodes.join(', ') || 'Unknown verification error';
          
          // Enhanced error logging
          console.error('CAPTCHA verification FAILED:');
          console.error(`  Error codes: ${errorCodesStr}`);
          console.error(`  Token source: ${tokenSource}`);
          console.error(`  Token length: ${turnstileToken?.length || 0}`);
          console.error(`  Client IP: ${clientIp}`);
          console.error(`  Challenge timestamp: ${verificationData['challenge-ts'] || 'N/A'}`);
          console.error(`  Hostname from response: ${verificationData.hostname || 'N/A'}`);
          console.error(`  Request hostname: ${req.headers.host || 'N/A'}`);
          console.error(`  Request origin: ${req.headers.origin || 'N/A'}`);
          
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ 
            error: 'CAPTCHA verification failed', 
            details: errorCodesStr 
          }));
          logRequest(req, res, `reflect captcha-failed ip=${clientIp} source=${tokenSource} errors=${errorCodesStr}`);
          return;
        }

        // According to Cloudflare docs: tokens can only be validated once, expire after 300s
        // Log success with relevant info from verification response
        console.log(`CAPTCHA verification SUCCESS for token from ${tokenSource}`);
        console.log(`  Hostname verified: ${verificationData.hostname || 'N/A'}`);
        console.log(`  Expected hostname: ${req.headers.host || 'N/A'}`);
        console.log(`  Challenge timestamp: ${verificationData['challenge-ts'] || 'N/A'}`);
        logRequest(req, res, `reflect captcha-verified ip=${clientIp} source=${tokenSource}`);
      }
    } catch (error) {
      // Enhanced error logging for debugging
      console.error('=== CAPTCHA Verification Error ===');
      console.error('Error type:', error?.constructor?.name);
      console.error('Error message:', error instanceof Error ? error.message : String(error));
      console.error('Error stack:', error instanceof Error ? error.stack : 'N/A');
      console.error('Token was present:', !!turnstileToken);
      console.error('Token length:', turnstileToken?.length || 0);
      console.error('Secret key configured:', !!process.env.TURNSTILE_SECRET_KEY);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorDetails = error instanceof Error ? error.stack : 'Unknown error';
      
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ 
        error: 'CAPTCHA verification service unavailable', 
        details: errorMessage 
      }));
      logRequest(req, res, `reflect captcha-service-error ${errorMessage}`);
      return;
    }

    // Rate limiting: Check IP first
    const ipRateLimitResult = ipRateLimiter.check(clientIp);
    if (!ipRateLimitResult.allowed) {
      res.statusCode = 429;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', ipRateLimitResult.retryAfter.toString());
      res.end(JSON.stringify({ 
        error: 'Too many requests from this IP', 
        retryAfter: ipRateLimitResult.retryAfter 
      }));
      logRequest(req, res, `reflect ip-rate-limited retryAfter=${ipRateLimitResult.retryAfter}`);
      return;
    }

    // Rate limiting: Check session
    const sessionRateLimitResult = sessionRateLimiter.check(sessionId);
    if (!sessionRateLimitResult.allowed) {
      res.statusCode = 429;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', sessionRateLimitResult.retryAfter.toString());
      res.end(JSON.stringify({ 
        error: 'Too many requests for this session', 
        retryAfter: sessionRateLimitResult.retryAfter 
      }));
      logRequest(req, res, `reflect session-rate-limited retryAfter=${sessionRateLimitResult.retryAfter}`);
      return;
    }

    // Generate AI response
    try {
      // Check if openaiService is available before making API calls
      if (!openaiService) {
        res.statusCode = 503;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ 
          error: 'Service temporarily unavailable. Please try again later.' 
        }));
        logRequest(req, res, 'reflect service-unavailable');
        return;
      }

      const systemPrompt = `You are Arete, an AI assistant that helps people think through tough questions while staying honest and fair. You explore multiple ethical perspectives, trace your sources, and show how you reach your conclusions. Be helpful, thoughtful, and transparent in your responses.

────────────────────────────────────────────────
RESPONSE METADATA PAYLOAD
────────────────────────────────────────────────
After your conversational reply, leave a blank line and append a single JSON object on its own line prefixed with <ARETE_METADATA>.
This metadata records provenance and confidence for downstream systems.

Required fields:
  • provenance → one of "Retrieved", "Inferred", or "Speculative"
  • confidence → floating-point certainty between 0.0 and 1.0 (e.g., 0.85)
  • tradeoffCount → integer ≥ 0 capturing how many value tradeoffs you surfaced (use 0 if none)
  • citations → array of {"title": string, "url": fully-qualified URL, "snippet"?: string} objects (use [] if none)

Example:
<ARETE_METADATA>{"provenance":"Retrieved","confidence":0.78,"tradeoffCount":1,"citations":[{"title":"Example","url":"https://example.com"}]}

Guidelines:
  - Emit valid, minified JSON (no comments, no code fences, no trailing text)
  - Always include the <ARETE_METADATA> block after every response
  - Use "Inferred" for reasoning-based answers, "Retrieved" for fact-based, "Speculative" for uncertain answers`;

      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question.trim() }
      ];

      const aiResponse = await openaiService.generateResponse(
        'gpt-5-mini',
        messages,
        { 
          reasoningEffort: 'low', 
          verbosity: 'low',
          channelContext: {
            channelId: sessionId
          }
        }
      );

      const { normalizedText, metadata: assistantMetadata } = aiResponse;

      // Build response metadata
      const runtimeContext = {
        modelVersion: 'gpt-5-mini',
        conversationSnapshot: `${question}\n\n${normalizedText}`
      };

      const responseMetadata = buildResponseMetadata(assistantMetadata, 'Low', runtimeContext);

      // Debug logging for metadata
      console.log('=== Server Metadata Debug ===');
      console.log('Assistant metadata:', JSON.stringify(assistantMetadata, null, 2));
      console.log('Assistant metadata confidence:', assistantMetadata?.confidence);
      console.log('Built response metadata:', JSON.stringify(responseMetadata, null, 2));
      console.log('Response metadata confidence:', responseMetadata.confidence);
      console.log('================================');

      // Store trace asynchronously (don't await - fire and forget)
      storeTrace(responseMetadata).catch(err => {
        console.error('Background trace storage error:', err);
      });

      // Return successful response
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({
        message: normalizedText,
        metadata: responseMetadata
      }));
      logRequest(req, res, `reflect success questionLength=${question.length}`);
      
    } catch (openaiError) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      
      const errorResponse = {
        error: 'AI generation failed',
        details: openaiError instanceof Error ? openaiError.message : 'Unknown OpenAI error'
      };
      
      res.end(JSON.stringify(errorResponse));
      logRequest(req, res, `reflect openai-error ${openaiError instanceof Error ? openaiError.message : 'unknown error'}`);
    }

  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    
    const errorResponse = {
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    };
    
    res.end(JSON.stringify(errorResponse));
    logRequest(req, res, `reflect error ${error instanceof Error ? error.message : 'unknown error'}`);
  }
};

/**
 * Handles requests to the /trace/:responseId.json endpoint.
 */
const handleTraceRequest = async (req, res, parsedUrl) => {
  try {
    // Extract responseId from pathname (remove /trace/ prefix and .json suffix)
    const pathMatch = parsedUrl.pathname.match(/^\/trace\/(.+)\.json$/);
    if (!pathMatch) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Invalid trace request format' }));
      logRequest(req, res, 'trace invalid-format');
      return;
    }

    const responseId = pathMatch[1];
    
    console.log('=== Trace Request Debug ===');
    console.log('Request pathname:', parsedUrl.pathname);
    console.log('Extracted responseId:', responseId);
    
    // Validate responseId format
    if (!/^[A-Za-z0-9_-]+$/.test(responseId)) {
      console.log('ResponseId validation failed');
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Invalid responseId format' }));
      logRequest(req, res, 'trace invalid-id');
      return;
    }

    const filePath = path.join(TRACES_DIR, `${responseId}.json`);
    console.log('Looking for trace file at:', filePath);
    console.log('TRACES_DIR:', TRACES_DIR);
    
    try {
      const fileContent = await fsPromises.readFile(filePath, { encoding: 'utf-8' });
      const metadata = JSON.parse(fileContent);
      
      // Debug logging for trace retrieval
      console.log('=== Trace Retrieval Debug ===');
      console.log('Response ID:', responseId);
      console.log('File path:', filePath);
      console.log('Metadata from file:', JSON.stringify(metadata, null, 2));
      console.log('Metadata confidence:', metadata.confidence);
      console.log('Metadata confidence type:', typeof metadata.confidence);
      console.log('==============================');
      
      // Check if trace is stale
      if (metadata.staleAfter) {
        const staleAfterDate = new Date(metadata.staleAfter);
        if (staleAfterDate < new Date()) {
          // Trace is stale, return 410 with the metadata
          res.statusCode = 410;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ message: 'Trace is stale', metadata }));
          logRequest(req, res, 'trace stale');
          return;
        }
      }
      
      // Return successful response
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); // Disable caching for debugging
      res.end(fileContent);
      logRequest(req, res, 'trace success');
      
    } catch (error) {
      // File not found - check for ENOENT error code
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ error: 'Trace not found' }));
        logRequest(req, res, 'trace not-found');
        return;
      }
      
      // JSON parse error or other read error
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Failed to read trace file' }));
      logRequest(req, res, `trace error ${errorMessage}`);
    }
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: 'Internal server error' }));
    logRequest(req, res, `trace error ${error instanceof Error ? error.message : 'unknown error'}`);
  }
};

/**
 * Handles requests to the /api/webhook/github endpoint.
 */
const handleWebhookRequest = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      logRequest(req, res, 'webhook method-not-allowed');
      return;
    }

    if (!process.env.GITHUB_WEBHOOK_SECRET) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'GitHub webhook secret not configured' }));
      logRequest(req, res, 'webhook secret-not-configured');
      return;
    }

    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Missing signature' }));
      logRequest(req, res, 'webhook missing-signature');
      return;
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    await new Promise((resolve, reject) => {
      req.on('end', resolve);
      req.on('error', reject);
    });
    const body = Buffer.concat(chunks);

    if (!verifyGitHubSignature(process.env.GITHUB_WEBHOOK_SECRET, body, signature)) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      logRequest(req, res, 'webhook invalid-signature');
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body.toString());
    } catch (error) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      logRequest(req, res, 'webhook invalid-json');
      return;
    }

    if (!payload.action || !payload.discussion || !payload.repository) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Invalid payload structure' }));
      logRequest(req, res, 'webhook invalid-payload');
      return;
    }

    if (payload.repository.full_name !== 'arete-org/arete') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ message: 'Ignored: wrong repository' }));
      logRequest(req, res, 'webhook ignored-wrong-repo');
      return;
    }

    if (payload.discussion.category?.name !== 'Blog') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ message: 'Ignored: not Blog category' }));
      logRequest(req, res, 'webhook ignored-not-blog');
      return;
    }

    if (payload.action !== 'created' && payload.action !== 'edited') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ message: 'Ignored: action not relevant' }));
      logRequest(req, res, 'webhook ignored-action');
      return;
    }

    await writeBlogPost(payload.discussion);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ success: true, postNumber: payload.discussion.number }));
    logRequest(req, res, `webhook success postNumber=${payload.discussion.number}`);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Internal server error' }));
    logRequest(req, res, `webhook error ${error instanceof Error ? error.message : 'unknown error'}`);
  }
};

// Initialize services
try {
  initializeServices();
} catch (error) {
  console.error('Failed to initialize services:', error);
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    res.statusCode = 400;
    res.end('Bad Request');
    return;
  }

  try {
    const parsedUrl = new URL(req.url, 'http://localhost');
    
    // Handle /api/webhook/github endpoint
    if (parsedUrl.pathname === '/api/webhook/github') {
      await handleWebhookRequest(req, res);
      return;
    }
    
    // Handle /api/reflect endpoint
    if (parsedUrl.pathname === '/api/reflect') {
      await handleReflectRequest(req, res, parsedUrl);
      return;
    }
    
    // Handle /trace/:responseId.json endpoint
    if (parsedUrl.pathname.startsWith('/trace/') && parsedUrl.pathname.endsWith('.json')) {
      console.log('=== Trace Route Matched ===');
      console.log('Pathname:', parsedUrl.pathname);
      console.log('Full URL:', req.url);
      await handleTraceRequest(req, res, parsedUrl);
      return;
    }
    
    // Serve static files
    const asset = await resolveAsset(req.url);

    if (!asset) {
      res.statusCode = 404;
      res.end('Not Found');
      logRequest(req, res, '(missing asset, index.html unavailable)');
      return;
    }

    const extension = path.extname(asset.absolutePath).toLowerCase();
    const contentType = MIME_MAP.get(extension) || 'application/octet-stream';

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.end(asset.content);
    logRequest(req, res);
  } catch (error) {
    res.statusCode = 500;
    res.end('Internal Server Error');
    logRequest(req, res, error instanceof Error ? error.message : 'unknown error');
  }
});

const port = Number(process.env.PORT || 3000);
server.listen(port, '0.0.0.0', () => {
  console.log(`Simple server available on port ${port}`);
});