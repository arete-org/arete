/**
 * @description: Manages realtime WebSocket connections, reconnection, and message dispatch.
 * @arete-scope: core
 * @arete-module: RealtimeWebSocketManager
 * @arete-risk: high - Connection churn can drop audio/text streams or leak resources.
 * @arete-ethics: high - Realtime streaming impacts privacy and user expectations.
 */
import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import { RECONNECTION_CONSTANTS } from '../constants/voice.js';

export class RealtimeWebSocketManager {
    private ws: WebSocket | null = null;
    private isConnected = false;
    private connectionPromise: Promise<void> | null = null;
    private connectionResolver: (() => void) | null = null;
    private connectionRejector: ((error: Error) => void) | null = null;
    private isConnecting = false;
    private reconnectAttempts = 0;
    private maxReconnectAttempts = RECONNECTION_CONSTANTS.MAX_RECONNECT_ATTEMPTS;
    private reconnectDelay = RECONNECTION_CONSTANTS.INITIAL_RECONNECT_DELAY;
    private maxReconnectDelay = RECONNECTION_CONSTANTS.MAX_RECONNECT_DELAY;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private messageCallbacks: Set<(data: WebSocket.Data) => void> = new Set();
    private eventListeners: Map<string, Set<Function>> = new Map();

    constructor() {
        // Initialize
    }

    public async connect(url: string, headers: Record<string, string>): Promise<void> {
        // If already connected, return immediately
        if (this.isConnected) {
            throw new Error('Session is already connected');
        }

        // If already connecting, return the existing promise
        if (this.isConnecting && this.connectionPromise) {
            return this.connectionPromise;
        }

        // If there's a stale connection promise (connection failed but promise wasn't cleaned up)
        if (this.connectionPromise && !this.isConnecting) {
            this.connectionPromise = null;
            this.connectionResolver = null;
            this.connectionRejector = null;
        }

        this.isConnecting = true;
        this.reconnectAttempts = 0;

        this.connectionPromise = new Promise<void>((resolve, reject) => {
            this.connectionResolver = resolve;
            this.connectionRejector = reject;

            this.attemptConnection(url, headers, resolve, reject);
        });

        return this.connectionPromise;
    }

    private attemptConnection(url: string, headers: Record<string, string>, resolve: () => void, reject: (error: Error) => void): void {
        try {
            const ws = new WebSocket(url, { headers });
            this.ws = ws;
            
            ws.on('open', () => {
                this.isConnected = true;
                this.isConnecting = false;
                this.reconnectAttempts = 0;
                this.clearReconnectTimer();
                this.connectionResolver?.();
    
                ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data.toString());
    
                        // Emit the specific event type
                        if (message.type) {
                            this.emit(message.type, message);
                        }
    
                        // Emit generic 'event' with full message
                        this.emit('event', message);
    
                        // Forward to registered callbacks
                        this.messageCallbacks.forEach(cb => {
                            try {
                                cb(data);
                            } catch (error) {
                                logger.error('Error in message callback:', error);
                            }
                        });
                    } catch (error) {
                        logger.error('Error processing WebSocket message:', error);
                    }
                });
    
                ws.on('error', (error) => {
                    logger.error('WebSocket error:', error);
                    this.handleConnectionError(error, url, headers, resolve, reject);
                });
    
                ws.on('close', (code) => {
                    this.cleanupConnectionPromise();
                    this.cleanup();
    
                    if (code !== 1000 && code !== 1001) {
                        this.scheduleReconnection(url, headers);
                    }
                });
            });
    
        } catch (error) {
            logger.error('Error creating WebSocket connection:', error);
            this.isConnecting = false;
            this.handleConnectionError(error instanceof Error ? error : new Error(String(error)), url, headers, resolve, reject);
        }
    }    

    private handleConnectionError(error: Error, url: string, headers: Record<string, string>, _resolve: () => void, _reject: (error: Error) => void): void {
        this.isConnected = false;
        this.isConnecting = false;

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            logger.warn(`Connection failed, attempting reconnection (${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
            this.scheduleReconnection(url, headers);
        } else {
            logger.error('Max reconnection attempts reached, giving up');
            this.connectionRejector?.(error);
            this.cleanupConnectionPromise();
            this.cleanup();
        }
    }

    private scheduleReconnection(url: string, headers: Record<string, string>): void {
        this.reconnectAttempts++;
        const delay = Math.min(this.reconnectDelay * Math.pow(RECONNECTION_CONSTANTS.RECONNECT_BACKOFF_MULTIPLIER, this.reconnectAttempts - 1), this.maxReconnectDelay);

        logger.info(`Scheduling reconnection attempt ${this.reconnectAttempts} in ${delay}ms`);

        this.reconnectTimer = setTimeout(() => {
            if (!this.isConnected && !this.isConnecting) {
                this.connectionPromise = new Promise<void>((resolve, reject) => {
                    this.connectionResolver = resolve;
                    this.connectionRejector = reject;
                    this.attemptConnection(url, headers, resolve, reject);
                });
            }
        }, delay);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private cleanupConnectionPromise(): void {
        this.connectionPromise = null;
        this.connectionResolver = null;
        this.connectionRejector = null;
    }

    private cleanup(): void {
        this.clearReconnectTimer();
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
            } catch (error) {
                logger.error('Error cleaning up WebSocket listeners:', error);
            }
        }
    }

    public disconnect(): void {
        if (this.ws && this.isConnected) {
            this.ws.close();
        }
        this.cleanup();
    }

    public send(data: string): void {
        if (!this.isConnected || !this.ws) {
            throw new Error('Session is not connected');
        }
        this.ws.send(data);
    }

    public isConnectionReady(): boolean {
        return this.isConnected && this.ws !== null;
    }

    public onMessage(callback: (data: WebSocket.Data) => void): void {
        this.messageCallbacks.add(callback);
        /*
        if (this.ws) {
            this.ws.on('message', callback);
        }
        */
    }

    public on(event: string, callback: (data: unknown) => void): void {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, new Set());
        }
        this.eventListeners.get(event)?.add(callback);
    }

    public off(event: string, callback: (data: unknown) => void): void {
        this.eventListeners.get(event)?.delete(callback);
    }

    private emit(event: string, data?: unknown): void {
        this.eventListeners.get(event)?.forEach(callback => {
            try {
                callback(data);
            } catch (error) {
                logger.error(`Error in ${event} handler:`, error);
            }
        });
    }

    public offMessage(callback: (data: WebSocket.Data) => void): void {
        this.messageCallbacks.delete(callback);
        if (this.ws) {
            this.ws.off('message', callback);
        }
    }

    public onError(callback: (error: Error) => void): void {
        if (this.ws) {
            this.ws.on('error', callback);
        }
    }

    public onClose(callback: (code: number, reason: Buffer) => void): void {
        if (this.ws) {
            this.ws.on('close', callback);
        }
    }

    public getWebSocket(): WebSocket | null {
        return this.ws;
    }
}
