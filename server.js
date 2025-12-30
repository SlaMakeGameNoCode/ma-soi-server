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
            console.log(`[SERVER] Game ended. Winner: ${room.winner}, Phase: ${room.phase}`);
            io.to(roomCode).emit('GAME_ENDED', { winner: room.winner, logs: room.actionLog });
            // Also emit phase change to update UIs
            io.to(roomCode).emit('PHASE_CHANGED', {
                phase: room.phase,
                day: room.day,
                logs: room.actionLog,
                winner: room.winner // Send winner data for game over screen
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
            gameManager.handleDisconnect(roomCode, playerId);
            const room = gameManager.getRoom(roomCode);
            if (room) {
                // Broadcast updated list to room so Host and Lobby updates
                // We need to fetch the view for the HOST (or generic public view)
                // Actually, PLAYER_JOINED expects { players: [...] }
                // Let's rely on each client re-requesting or just send generic view.
                // Host needs to see updated connection status.
                // Reuse PLAYER_JOINED event which Host already listens to.

                // Ideally we send 'PLAYER_UPDATE' but let's stick to existing events if possible.
                // Host: socket.on('PLAYER_JOINED', renderPlayers).
                // We need to send the list.
                // Limitation: Who do we render as? If we send generic, Host sees "???" roles?
                // Host is special. 

                // Better approach: Host already listens to PLAYER_JOINED. 
                // We can emit PLAYER_JOINED to the ROOM.
                // But wait, PLAYER_JOINED payload is { players }.
                // If we send a generic list (roles hidden), Host loses role visibility?
                // YES. Host relies on PLAYER_JOINED to update the grid.

                // FIX: Send a signal for clients to RE-FETCH?
                // Or, on disconnect, we explicitly tell Host "Hey, refresh".
                // Host has logic: socket.on('PLAYER_JOINED', ...)

                // Let's emit a NEW event 'PLAYER_LEFT' with the ID, and Host can mark it offline locally?
                // Or Host can trigger GET_PLAYERS.

                io.to(roomCode).emit('PLAYER_DISCONNECTED', { playerId });

                // FORCE UPDATE:
                // Also emit a "REFRESH_PLAYERS" signal?
                // Let's modify Host to listen to PLAYER_DISCONNECTED and trigger GET_PLAYERS.
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
});
