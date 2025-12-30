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
            gameManager.submitAction(roomCode, playerId, type, targetId);
            // socket.emit('ACTION_CONFIRMED', { type, targetId });
        } catch (error) {
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('VOTE', ({ targetId }) => {
        const { roomCode, playerId } = socket.data;
        try {
            gameManager.submitVote(roomCode, playerId, targetId);
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
                logs: room.actionLog
            });
        } catch (error) {
            socket.emit('ERROR', { message: error.message });
        }
    });

    socket.on('disconnect', () => {
        const { roomCode, playerId } = socket.data;
        if (roomCode && playerId) {
            gameManager.handleDisconnect(roomCode, playerId);
            const room = gameManager.getRoom(roomCode);
            if (room) {
                io.to(roomCode).emit('PLAYER_DISCONNECTED', { playerId });
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
