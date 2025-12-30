/**
 * RateLimiter - Anti-abuse middleware
 * Handles rate limiting for chat and actions, AFK detection
 */
class RateLimiter {
    constructor() {
        this.chatLimits = new Map(); // socketId -> last message timestamp
        this.actionLimits = new Map(); // socketId -> last action timestamp
        this.afkTimers = new Map(); // socketId -> timeout
    }

    /**
     * Check if chat message is allowed
     * Returns { allowed: boolean, waitTime: number }
     */
    checkChatLimit(socketId) {
        const now = Date.now();
        const lastMessage = this.chatLimits.get(socketId) || 0;
        const timeSinceLastMessage = now - lastMessage;
        const CHAT_DELAY = 1500; // 1.5 seconds

        if (timeSinceLastMessage < CHAT_DELAY) {
            return {
                allowed: false,
                waitTime: Math.ceil((CHAT_DELAY - timeSinceLastMessage) / 1000)
            };
        }

        this.chatLimits.set(socketId, now);
        return { allowed: true, waitTime: 0 };
    }

    /**
     * Validate chat message
     * Returns { valid: boolean, error: string }
     */
    validateChatMessage(message) {
        const MAX_LENGTH = 80;
        const MIN_LENGTH = 1;

        if (!message || message.trim().length < MIN_LENGTH) {
            return { valid: false, error: 'Message too short' };
        }

        if (message.length > MAX_LENGTH) {
            return { valid: false, error: `Message too long (max ${MAX_LENGTH} chars)` };
        }

        // Simple emoji spam detection (more than 5 emoji-like chars)
        const emojiCount = (message.match(/[\u{1F600}-\u{1F64F}]/gu) || []).length;
        if (emojiCount > 5) {
            return { valid: false, error: 'Too many emojis' };
        }

        return { valid: true, error: null };
    }

    /**
     * Check if action is allowed (vote, night action)
     */
    checkActionLimit(socketId) {
        const now = Date.now();
        const lastAction = this.actionLimits.get(socketId) || 0;
        const timeSinceLastAction = now - lastAction;
        const ACTION_DELAY = 500; // 0.5 seconds

        if (timeSinceLastAction < ACTION_DELAY) {
            return { allowed: false };
        }

        this.actionLimits.set(socketId, now);
        return { allowed: true };
    }

    /**
     * Reset AFK timer for a player
     */
    resetAFKTimer(socketId, callback) {
        // Clear existing timer
        if (this.afkTimers.has(socketId)) {
            clearTimeout(this.afkTimers.get(socketId));
        }

        // Set new timer (2 minutes)
        const timer = setTimeout(() => {
            callback(socketId);
        }, 120000); // 2 minutes

        this.afkTimers.set(socketId, timer);
    }

    /**
     * Clear AFK timer
     */
    clearAFKTimer(socketId) {
        if (this.afkTimers.has(socketId)) {
            clearTimeout(this.afkTimers.get(socketId));
            this.afkTimers.delete(socketId);
        }
    }

    /**
     * Clean up on disconnect
     */
    cleanup(socketId) {
        this.chatLimits.delete(socketId);
        this.actionLimits.delete(socketId);
        this.clearAFKTimer(socketId);
    }
}


module.exports = { RateLimiter };
