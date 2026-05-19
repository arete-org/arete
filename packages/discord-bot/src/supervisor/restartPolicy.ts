/**
 * @description: Tracks recent local-node crash timestamps and determines when
 * restart attempts must stop to keep the server available.
 * @footnote-scope: utility
 * @footnote-module: LocalNodeRestartPolicy
 * @footnote-risk: medium - Incorrect failure-window math can cause restart storms or premature node disablement.
 * @footnote-ethics: low - Reliability controls affect availability but not direct user-governance behavior.
 */

export const LOCAL_NODE_FAILURE_WINDOW_MS = 5 * 60 * 1000;
export const LOCAL_NODE_FAILURE_THRESHOLD = 3;

export type LocalNodeFailureDecision = {
    failureCount: number;
    unhealthy: boolean;
};

/**
 * Sliding-window restart policy that marks a node unhealthy after repeated
 * failures inside the configured window.
 */
export class LocalNodeRestartPolicy {
    private readonly failureTimestamps: number[] = [];

    constructor(
        private readonly threshold = LOCAL_NODE_FAILURE_THRESHOLD,
        private readonly windowMs = LOCAL_NODE_FAILURE_WINDOW_MS
    ) {}

    recordFailure(now = Date.now()): LocalNodeFailureDecision {
        this.failureTimestamps.push(now);
        this.prune(now);

        const failureCount = this.failureTimestamps.length;
        return {
            failureCount,
            unhealthy: failureCount >= this.threshold,
        };
    }

    private prune(now: number): void {
        const cutoff = now - this.windowMs;
        while (
            this.failureTimestamps.length > 0 &&
            this.failureTimestamps[0] < cutoff
        ) {
            this.failureTimestamps.shift();
        }
    }
}
