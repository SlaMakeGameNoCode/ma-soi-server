const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { GameManager } = require('./GameManager');
const { RateLimiter } = require('./RateLimiter');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const gameManager = new GameManager();
const rateLimiter = new RateLimiter();

// Serve static files
app.use(express.static('public'));

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Join room page
app.get('/join/:roomCode', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

// Host page
app.get('/host', (req, res) => {
    res.sendFile(__dirname + '/public/host.html');
});

io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.on('CREATE_ROOM', ({ playerName }) => {
        try {
            const { roomCode, playerId, token } = gameManager.createRoom(playerName);
            socket.join(roomCode);
            socket.data.roomCode = roomCode;
            socket.data.playerId = playerId;
            socket.emit('ROOM_CREATED', { roomCode, playerId, token });

            // Send initial player list to host
            const room = gameManager.getRoom(roomCode);
            socket.emit('PLAYER_JOINED', {
                players: room.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    connected: p.connected,
                    isHost: p.isHost
                }))
            });

            console.log(`Room created: ${roomCode} by ${playerName}`);
        } catch (error) {
            console.error('CREATE_ROOM error:', error);
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('JOIN_ROOM', ({ roomCode, playerName, token }) => {
        try {
            const { playerId, token: playerToken, reconnected } = gameManager.joinRoom(roomCode, playerName, token);
            socket.join(roomCode);
            socket.data.roomCode = roomCode;
            socket.data.playerId = playerId;
            const room = gameManager.getRoom(roomCode);

            if (reconnected) {
                const playerView = gameManager.getPlayerView(roomCode, playerId);
                const player = playerView.players.find(p => p.id === playerId);
                socket.emit('RECONNECTED', { gameState: playerView, role: player ? player.role : null });
            } else {
                socket.emit('ROOM_CREATED', { roomCode, playerId, token: playerToken });
            }

            io.to(roomCode).emit('PLAYER_JOINED', {
                players: room.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    connected: p.connected,
                    isHost: p.isHost
                }))
            });

            console.log(`Player ${playerName} joined room ${roomCode}`);
        } catch (error) {
            console.error('JOIN_ROOM error:', error);
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('START_GAME', ({ roleConfig }) => {
        const { roomCode, playerId } = socket.data;
        try {
            const result = gameManager.startGame(roomCode, playerId, roleConfig);
            result.players.forEach(player => {
                const foundSocket = Array.from(io.sockets.sockets.values()).find(s => s.data.playerId === player.id);
                const socketId = foundSocket ? foundSocket.id : null;
                if (socketId) {
                    io.to(socketId).emit('GAME_STARTED', { role: player.role, players: result.players });
                }
            });
            console.log(`Game started in room ${roomCode}`);
        } catch (error) {
            console.error('START_GAME error:', error);
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('ACTION', ({ type, targetId }) => {
        const { roomCode, playerId } = socket.data;
        try {
            const actionDetails = gameManager.submitAction(roomCode, playerId, type, targetId);

            // NEW: Witch Preview System
            // When Wolf submits KILL, notify Witch immediately
            if (type === 'KILL') {
                const room = gameManager.getRoom(roomCode);
                const actor = room.players.find(p => p.id === playerId);

                // Check if actor is Wolf
                if (actor && (actor.role === 'wolf' || actor.role === 'alpha_wolf')) {
                    // Find Witch
                    const witch = room.players.find(p => p.role === 'witch' && p.alive);

                    if (witch) {
                        // Find Witch's socket
                        const witchSocket = Array.from(io.sockets.sockets.values())
                            .find(s => s.data.playerId === witch.id);

                        if (witchSocket) {
                            const target = room.players.find(p => p.id === targetId);
                            witchSocket.emit('WITCH_PREVIEW', {
                                targetId: targetId,
                                targetName: target ? target.name : 'Unknown'
                            });
                            console.log(`[WITCH_PREVIEW] Sent to ${witch.name}: ${target?.name} will die`);
                        }
                    }
                }
            }

            // Notify Host of progress & Action Details
            const status = gameManager.getActionStatus(roomCode);
            const room = gameManager.getRoom(roomCode);
            const host = room.players.find(p => p.isHost);
            if (host && host.connected) {
                // Find host socket
                const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.data.playerId === host.id);
                if (hostSocket) {
                    hostSocket.emit('HOST_UPDATE', {
                        actionStatus: status,
                        actionLog: actionDetails // New field
                    });
                }
            }

        } catch (error) {
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('VOTE', ({ targetId }) => {
        const { roomCode, playerId } = socket.data;
        try {
            gameManager.submitVote(roomCode, playerId, targetId);

            // Notify Host of progress
            const status = gameManager.getActionStatus(roomCode);
            const room = gameManager.getRoom(roomCode);
            const host = room.players.find(p => p.isHost);
            if (host && host.connected) {
                const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.data.playerId === host.id);
                if (hostSocket) {
                    hostSocket.emit('HOST_UPDATE', {
                        actionStatus: status
                    });
                }
            }

        } catch (error) {
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('NEXT_PHASE', () => {
        const { roomCode, playerId } = socket.data;
        try {
            const room = gameManager.advancePhase(roomCode, playerId);
            io.to(roomCode).emit('PHASE_CHANGED', {
                phase: room.phase,
                day: room.day,
                logs: room.actionLog,
                winner: room.winner, // Send winner data for game over screen
                executedPlayerId: room.executedPlayerId // Send who was executed
            });
        } catch (error) {
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('END_GAME', () => {
        const { roomCode, playerId } = socket.data;
        console.log(`[SERVER] END_GAME received from ${playerId} in room ${roomCode}`);
        try {
            const room = gameManager.endGame(roomCode, playerId);
            console.log(`[SERVER] Game ended, resetting to lobby. Phase: ${room.phase}`);

            // Send GAME_RESET to all players (including host)
            io.to(roomCode).emit('GAME_RESET', { roomCode });

            // Also emit PHASE_CHANGED to update UI
            io.to(roomCode).emit('PHASE_CHANGED', {
                phase: 'lobby',
                day: 0,
                logs: room.actionLog
            });
        } catch (error) {
            console.error('[SERVER] END_GAME error:', error);
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('RESET_GAME', () => {
        const { roomCode, playerId } = socket.data;
        try {
            const room = gameManager.resetGame(roomCode, playerId);
            io.to(roomCode).emit('GAME_RESET', { roomCode });
            // Re-emit player joined to refresh lists? 
            // Better to emit a full refresh/lobby event
            const playerView = gameManager.getPlayerView(roomCode, playerId);
            io.to(roomCode).emit('PHASE_CHANGED', {
                phase: 'lobby',
                day: 0,
                logs: room.actionLog
            });
        } catch (error) {
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('KICK_PLAYER', (data) => {
        try {
            const { roomCode, playerId } = socket.data;
            const { targetId } = data;

            gameManager.kickPlayer(roomCode, playerId, targetId);

            // Broadcast update
            io.to(roomCode).emit('PLAYER_DISCONNECTED', { playerId: targetId, kicked: true });

            // Also force refresh for everyone
            const playerView = gameManager.getPlayerView(roomCode, playerId); // Host view
            // Actually simplest is to tell everyone to update. 
            // Reuse PLAYER_DISCONNECTED logic or emit PLAYER_JOINED with new list?
            // Existing logic for PLAYER_DISCONNECTED triggers GET_PLAYERS in Host.
            // Players might need it too?
            // Let's emit PLAYER_JOINED with updated list to force immediate update for everyone.
            // Note: We need a generic view for players, but Host needs specific.
            // Let's rely on GET_PLAYERS for Host and broadcast generic for now?
            // Or just emit a "PLAYER_LEFT" event?
            // Re-using PLAYER_DISCONNECTED is fine, Host catches it.

        } catch (error) {
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('GET_PLAYERS', () => {
        const { roomCode } = socket.data;
        if (roomCode) {
            const room = gameManager.getRoom(roomCode);
            if (room) {
                // Get player view for Host (so all roles are visible? No, helper getPlayerView hides stuff)
                // BUT Host needs to see Roles? Spec says "Host is Moderator".
                // Our getPlayerView has logic: "role: (p.id === playerId || room.phase === 'end' || isActiveHost...) ? ..."
                // The Host calls this, so playerId is hostId. 
                // Host IS valid in this check: room.players.find(h => h.id === playerId)?.isHost
                // So getPlayerView SHOULD reveal all roles to Host.

                const playerView = gameManager.getPlayerView(roomCode, socket.data.playerId);
                socket.emit('PLAYER_JOINED', { players: playerView.players });
            }
        }
    });

    socket.on('disconnect', () => {
        const { roomCode, playerId } = socket.data;
        if (roomCode && playerId) {
            const room = gameManager.getRoom(roomCode);
            if (room) {
                // Check if disconnecting player is host
                const player = room.players.find(p => p.id === playerId);
                if (player && player.isHost) {
                    console.log(`[SERVER] Host ${playerId} disconnected from room ${roomCode}. Closing room.`);

                    // Emit HOST_LEFT to all players in room
                    io.to(roomCode).emit('HOST_LEFT', {
                        message: 'Host đã rời phòng. Phòng sẽ bị đóng.'
                    });

                    // Delete room after short delay to allow message delivery
                    setTimeout(() => {
                        gameManager.rooms.delete(roomCode);
                        console.log(`[SERVER] Room ${roomCode} deleted`);
                    }, 1000);
                } else {
                    // Regular player disconnect
                    gameManager.handleDisconnect(roomCode, playerId);
                    io.to(roomCode).emit('PLAYER_DISCONNECTED', { playerId });
                }
            }
            console.log(`Player ${playerId} disconnected from room ${roomCode}`);
        }
        rateLimiter.cleanup(socket.id);
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Ma Sói Server running on port ${PORT}`);
    console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);

    // Keep-alive mechanism for Render free tier
    // Render sleeps after 15 minutes of no HTTP activity
    // WebSocket connections don't count, so we need to ping ourselves
    if (process.env.RENDER_SERVICE_NAME) {
        console.log('🔄 Keep-alive enabled for Render hosting');
        const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes

        setInterval(() => {
            const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
            fetch(`${url}/api/health`)
                .then(res => {
                    if (res.ok) {
                        console.log('✅ Keep-alive ping successful');
                    } else {
                        console.log('⚠️ Keep-alive ping failed:', res.status);
                    }
                })
                .catch(err => {
                    console.log('❌ Keep-alive ping error:', err.message);
                });
        }, PING_INTERVAL);
    }
});

