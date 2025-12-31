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

// Server start time for uptime calculation
const serverStartTime = Date.now();

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Admin authentication middleware
const adminAuth = (req, res, next) => {
    const auth = req.headers['x-admin-auth'];
    if (auth === 'true') {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
});

// Admin page
app.get('/admin', (req, res) => {
    res.sendFile(__dirname + '/public/admin.html');
});

// Admin API - Server Stats
app.get('/api/admin/stats', adminAuth, (req, res) => {
    const rooms = Array.from(gameManager.rooms.values());
    const totalPlayers = rooms.reduce((sum, room) => {
        return sum + room.players.filter(p => !p.isHost && p.connected).length;
    }, 0);
    const activeGames = rooms.filter(r => r.phase !== 'lobby').length;
    const uptime = Math.floor((Date.now() - serverStartTime) / 1000);

    // Memory usage
    const memUsage = process.memoryUsage();
    const memoryUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const memoryTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const memoryPercent = Math.round((memUsage.heapUsed / memUsage.heapTotal) * 100);

    // CPU usage (approximate)
    const cpuUsage = process.cpuUsage();
    const cpuPercent = Math.min(100, Math.round((cpuUsage.user + cpuUsage.system) / 1000000 / uptime * 100));

    const roomsData = rooms.map(room => ({
        roomCode: room.roomCode,
        phase: room.phase,
        day: room.day,
        playerCount: room.players.filter(p => !p.isHost).length,
        maxPlayers: room.maxPlayers,
        hostName: room.players.find(p => p.isHost)?.name || 'Unknown'
    }));

    res.json({
        totalRooms: rooms.length,
        totalPlayers,
        activeGames,
        uptime,
        memoryUsedMB,
        memoryTotalMB,
        memoryPercent,
        cpuPercent,
        rooms: roomsData
    });
});

// Admin API - Close Room
app.post('/api/admin/close-room', adminAuth, (req, res) => {
    const { roomCode } = req.body;

    if (!roomCode) {
        return res.status(400).json({ error: 'Room code required' });
    }

    const room = gameManager.rooms.get(roomCode);
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }

    // Notify all players in room
    io.to(roomCode).emit('ADMIN_ROOM_CLOSED', {
        message: 'Phòng đã bị đóng bởi Admin'
    });

    // Delete room
    gameManager.rooms.delete(roomCode);
    console.log(`[ADMIN] Room ${roomCode} closed by admin`);

    res.json({ message: `Room ${roomCode} closed successfully` });
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

    socket.on('SET_MAX_PLAYERS', ({ maxPlayers }) => {
        const { roomCode, playerId } = socket.data;
        try {
            const room = gameManager.setMaxPlayers(roomCode, playerId, maxPlayers);
            // Broadcast updated maxPlayers to all clients
            io.to(roomCode).emit('MAX_PLAYERS_UPDATED', { maxPlayers: room.maxPlayers });
            console.log(`Max players set to ${maxPlayers} in room ${roomCode}`);
        } catch (error) {
            console.error('SET_MAX_PLAYERS error:', error);
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('SET_DAY_DURATION', ({ duration }) => {
        const { roomCode, playerId } = socket.data;
        try {
            const room = gameManager.setDayPhaseDuration(roomCode, playerId, duration);
            // Broadcast updated duration to all clients
            io.to(roomCode).emit('DAY_DURATION_UPDATED', { duration: room.dayPhaseDuration });
            console.log(`Day phase duration set to ${duration}s in room ${roomCode}`);
        } catch (error) {
            console.error('SET_DAY_DURATION error:', error);
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

            // Also notify dead players (they get host-like visibility)
            const deadPlayers = room.players.filter(p => !p.alive && !p.isHost);
            const observerSockets = [];

            if (host && host.connected) {
                const hostSocket = Array.from(io.sockets.sockets.values()).find(s => s.data.playerId === host.id);
                if (hostSocket) observerSockets.push(hostSocket);
            }

            deadPlayers.forEach(deadPlayer => {
                const deadSocket = Array.from(io.sockets.sockets.values()).find(s => s.data.playerId === deadPlayer.id);
                if (deadSocket) observerSockets.push(deadSocket);
            });

            // Send updates to all observers (host + dead players)
            observerSockets.forEach(observerSocket => {
                observerSocket.emit('HOST_UPDATE', {
                    actionStatus: status,
                    actionLog: actionDetails
                });
            });

        } catch (error) {
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('VOTE', ({ targetId }) => {
        const { roomCode, playerId } = socket.data;
        try {
            const result = gameManager.submitVote(roomCode, playerId, targetId);

            if (result) {
                const room = gameManager.getRoom(roomCode);
                const voter = room.players.find(p => p.id === playerId);
                const target = room.players.find(p => p.id === targetId);

                // Broadcast individual vote to all players
                io.to(roomCode).emit('VOTE_CAST', {
                    voterName: voter ? voter.name : 'Unknown',
                    targetName: targetId === 'SKIP' ? 'Bỏ qua' : (target ? target.name : 'Unknown'),
                    voterId: playerId,
                    targetId: targetId
                });

                // Broadcast vote leader update
                if (result.leaderId) {
                    io.to(roomCode).emit('VOTE_LEADER_UPDATE', {
                        leaderName: result.leaderName,
                        voteCount: result.voteCount,
                        totalVotes: result.totalVotes
                    });
                }
            }

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

            // Clear any existing timer when changing phase
            if (room.phaseTimer) {
                clearInterval(room.phaseTimer);
                room.phaseTimer = null;
            }

            io.to(roomCode).emit('PHASE_CHANGED', {
                phase: room.phase,
                day: room.day,
                logs: room.actionLog,
                winner: room.winner, // Send winner data for game over screen
                executedPlayerId: room.executedPlayerId // Send who was executed
            });

            // Start auto-timer for DAY phase
            if (room.phase === 'day') {
                const duration = room.dayPhaseDuration || 60;
                console.log(`[TIMER] Starting ${duration}s timer for DAY phase in room ${roomCode}`);

                let timeLeft = duration;

                // Emit initial timer
                io.to(roomCode).emit('TIMER_UPDATE', { timeLeft });

                // Update timer every second
                room.phaseTimer = setInterval(() => {
                    timeLeft--;
                    io.to(roomCode).emit('TIMER_UPDATE', { timeLeft });

                    if (timeLeft <= 0) {
                        clearInterval(room.phaseTimer);
                        room.phaseTimer = null;

                        // Auto-advance to VOTE phase
                        console.log(`[TIMER] Auto-advancing to VOTE phase in room ${roomCode}`);
                        try {
                            const updatedRoom = gameManager.advancePhase(roomCode, playerId);

                            // Clear timer and hide UI
                            io.to(roomCode).emit('TIMER_UPDATE', { timeLeft: -1 });

                            io.to(roomCode).emit('PHASE_CHANGED', {
                                phase: updatedRoom.phase,
                                day: updatedRoom.day,
                                logs: updatedRoom.actionLog,
                                winner: updatedRoom.winner,
                                executedPlayerId: updatedRoom.executedPlayerId
                            });
                        } catch (error) {
                            console.error('[TIMER] Auto-advance error:', error);
                        }
                    }
                }, 1000);
            } else {
                // Hide timer for non-DAY phases
                io.to(roomCode).emit('TIMER_UPDATE', { timeLeft: -1 });
            }
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
                const player = room.players.find(p => p.id === playerId);

                if (player && player.isHost) {
                    // Host disconnect - close room
                    console.log(`[SERVER] Host ${playerId} disconnected from room ${roomCode}. Closing room.`);
                    io.to(roomCode).emit('HOST_LEFT', {
                        message: 'Host đã rời phòng. Phòng sẽ bị đóng.'
                    });
                    setTimeout(() => {
                        gameManager.rooms.delete(roomCode);
                        console.log(`[SERVER] Room ${roomCode} deleted`);
                    }, 1000);
                } else if (player) {
                    // Regular player disconnect - REMOVE IMMEDIATELY
                    console.log(`[SERVER] Player ${player.name} (${playerId}) disconnected from room ${roomCode}. Removing player.`);

                    // Clean up player's votes and actions
                    room.votes.delete(playerId);
                    room.actions.delete(playerId);

                    // Remove player from room
                    const playerIndex = room.players.findIndex(p => p.id === playerId);
                    if (playerIndex !== -1) {
                        room.players.splice(playerIndex, 1);
                    }

                    // Broadcast removal to all remaining players
                    io.to(roomCode).emit('PLAYER_REMOVED', {
                        playerId,
                        playerName: player.name,
                        message: `${player.name} đã rời phòng.`
                    });

                    console.log(`[SERVER] Player ${player.name} removed from room ${roomCode}`);
                }
            }
        }
        rateLimiter.cleanup(socket.id);
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Ma Sói Server running on port ${PORT}`);
    console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
});
