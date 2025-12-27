/**
 * @description: Verifies GitHub webhook signatures for incoming requests.
 * @arete-scope: utility
 * @arete-module: GitHubWebhookVerifier
 * @arete-risk: moderate - Incorrect verification could accept spoofed payloads.
 * @arete-ethics: moderate - Spoofed data could mislead users or poison content.
 */
import crypto from 'node:crypto';
import { logger } from '../shared/logger';

/**
 * Verifies GitHub webhook signature using HMAC-SHA256.
 */
function verifyGitHubSignature(secret: string, body: Buffer, signature: string): boolean {
  try {
    // --- HMAC computation ---
    // Compute the expected HMAC signature and compare using constant-time equality.
    const expectedSignature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const receivedBuffer = Buffer.from(signature, 'utf8');

    // --- Constant-time comparison ---
    // Length mismatch is a hard fail to avoid timing side-channel surprises.
    if (expectedBuffer.length !== receivedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
  } catch (error) {
    logger.error(`Error verifying GitHub signature: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export { verifyGitHubSignature };


