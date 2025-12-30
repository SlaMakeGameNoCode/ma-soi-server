const { nanoid } = require('nanoid');

/**
 * GameManager - Server-authoritative game state management
 * Handles rooms, players, phases, and game logic
 */
class GameManager {
  constructor() {
    this.rooms = new Map(); // roomCode -> GameState
  }

  /**
   * Create a new game room
   */
  createRoom(hostName) {
    const roomCode = nanoid(6).toUpperCase();
    const hostId = nanoid();
    const token = nanoid(32);

    const room = {
      roomCode,
      phase: 'lobby',
      day: 0,
      players: [{
        id: hostId,
        name: hostName,
        role: null,
        alive: true,
        connected: true,
        isHost: true,
        hasVoted: false,
        lastAction: Date.now(),
        token,
        isSpectator: false
      }],
      votes: new Map(),
      nightActions: new Map(),
      winner: null,
      actionLog: [],
      phaseTimer: 0,
      phaseStartTime: null
    };

    this.rooms.set(roomCode, room);
    return { roomCode, playerId: hostId, token };
  }

  /**
   * Join an existing room
   */
  joinRoom(roomCode, playerName, reconnectToken = null) {
    const room = this.rooms.get(roomCode);
    if (!room) {
      throw new Error('Room not found');
    }

    // Check for reconnection
    if (reconnectToken) {
      const existingPlayer = room.players.find(p => p.token === reconnectToken);
      if (existingPlayer) {
        existingPlayer.connected = true;
        existingPlayer.lastAction = Date.now();
        return { playerId: existingPlayer.id, token: existingPlayer.token, reconnected: true };
      }
    }

    // New player
    if (room.phase !== 'lobby') {
      throw new Error('Game already started');
    }

    const playerId = nanoid();
    const token = nanoid(32);

    room.players.push({
      id: playerId,
      name: playerName,
      role: null,
      alive: true,
      connected: true,
      isHost: false,
      hasVoted: false,
      lastAction: Date.now(),
      token,
      isSpectator: false
    });

    return { playerId, token, reconnected: false };
  }

  /**
   * Start the game - assign roles and begin night phase
   */
  startGame(roomCode, hostId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Room not found');

    const host = room.players.find(p => p.id === hostId);
    if (!host || !host.isHost) {
      throw new Error('Only host can start game');
    }

    if (room.players.length < 4) {
      throw new Error('Need at least 4 players');
    }

    // Assign roles
    this.assignRoles(room);

    // Start night phase
    room.phase = 'night';
    room.day = 1;
    room.phaseStartTime = Date.now();
    room.phaseTimer = 60; // 60 seconds for night
    room.actionLog.push(`Game started with ${room.players.length} players`);

    return room;
  }

  /**
   * Assign roles randomly and balanced
   */
  assignRoles(room) {
    const playerCount = room.players.length;
    const roles = [];

    // Calculate role distribution
    const wolfCount = Math.floor(playerCount / 3); // 1 wolf per 3 players
    
    for (let i = 0; i < wolfCount; i++) roles.push('wolf');
    roles.push('seer');
    roles.push('doctor');
    
    // Fill rest with villagers
    while (roles.length < playerCount) {
      roles.push('villager');
    }

    // Shuffle roles
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }

    // Assign to players
    room.players.forEach((player, index) => {
      player.role = roles[index];
    });
  }

  /**
   * Submit night action
   */
  submitNightAction(roomCode, playerId, action, targetId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Room not found');
    if (room.phase !== 'night') throw new Error('Not night phase');

    const player = room.players.find(p => p.id === playerId);
    if (!player || !player.alive) throw new Error('Invalid player');

    // Validate action based on role
    if (player.role === 'wolf' && action === 'kill') {
      room.nightActions.set(playerId, { action, targetId });
      room.actionLog.push(`${player.name} (Wolf) chose target`);
    } else if (player.role === 'seer' && action === 'see') {
      room.nightActions.set(playerId, { action, targetId });
      const target = room.players.find(p => p.id === targetId);
      room.actionLog.push(`${player.name} (Seer) checked ${target ? target.name : "unknown"}`);
    } else if (player.role === 'doctor' && action === 'protect') {
      room.nightActions.set(playerId, { action, targetId });
      room.actionLog.push(`${player.name} (Doctor) protected someone`);
    }

    player.hasVoted = true;
    player.lastAction = Date.now();

    // Check if all players with night actions have acted
    this.checkNightComplete(room);
  }

  /**
   * Check if night phase is complete
   */
  checkNightComplete(room) {
    const activeRoles = room.players.filter(p => 
      p.alive && (p.role === 'wolf' || p.role === 'seer' || p.role === 'doctor')
    );

    const actedPlayers = activeRoles.filter(p => room.nightActions.has(p.id));

    // Auto-advance if all acted or timeout
    if (actedPlayers.length === activeRoles.length) {
      this.resolveNight(room);
    }
  }

  /**
   * Resolve night actions
   */
  resolveNight(room) {
    let killedPlayerId = null;
    let protectedPlayerId = null;

    // Get actions
    room.nightActions.forEach((actionData, playerId) => {
      if (actionData.action === 'kill') {
        killedPlayerId = actionData.targetId;
      } else if (actionData.action === 'protect') {
        protectedPlayerId = actionData.targetId;
      }
    });

    // Resolve kill
    if (killedPlayerId && killedPlayerId !== protectedPlayerId) {
      const victim = room.players.find(p => p.id === killedPlayerId);
      if (victim) {
        victim.alive = false;
        victim.isSpectator = true;
        room.actionLog.push(`${victim.name} was killed by wolves`);
      }
    } else if (killedPlayerId === protectedPlayerId) {
      room.actionLog.push('The doctor saved someone!');
    }

    // Clear night actions
    room.nightActions.clear();
    room.players.forEach(p => p.hasVoted = false);

    // Move to day phase
    room.phase = 'day';
    room.phaseStartTime = Date.now();
    room.phaseTimer = 120; // 2 minutes for discussion
  }

  /**
   * Submit vote
   */
  submitVote(roomCode, playerId, targetId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Room not found');
    if (room.phase !== 'vote') throw new Error('Not vote phase');

    const player = room.players.find(p => p.id === playerId);
    if (!player || !player.alive) throw new Error('Invalid player');

    room.votes.set(playerId, targetId);
    player.hasVoted = true;
    player.lastAction = Date.now();

    const target = room.players.find(p => p.id === targetId);
    room.actionLog.push(`${player.name} voted for ${(target && target.name) || 'skip'}`);

    // Check if all alive players voted
    this.checkVoteComplete(room);
  }

  /**
   * Check if voting is complete
   */
  checkVoteComplete(room) {
    const alivePlayers = room.players.filter(p => p.alive);
    const votedPlayers = alivePlayers.filter(p => p.hasVoted);

    if (votedPlayers.length === alivePlayers.length) {
      this.resolveVote(room);
    }
  }

  /**
   * Resolve voting
   */
  resolveVote(room) {
    const voteCounts = new Map();

    // Count votes
    room.votes.forEach((targetId) => {
      if (targetId) {
        voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
      }
    });

    // Find player with most votes
    let maxVotes = 0;
    let eliminatedId = null;

    voteCounts.forEach((count, playerId) => {
      if (count > maxVotes) {
        maxVotes = count;
        eliminatedId = playerId;
      }
    });

    // Eliminate player
    if (eliminatedId) {
      const eliminated = room.players.find(p => p.id === eliminatedId);
      if (eliminated) {
        eliminated.alive = false;
        eliminated.isSpectator = true;
        room.actionLog.push(`${eliminated.name} (${eliminated.role}) was eliminated by vote`);
      }
    } else {
      room.actionLog.push('No one was eliminated');
    }

    // Clear votes
    room.votes.clear();
    room.players.forEach(p => p.hasVoted = false);

    // Check win condition
    const winner = this.checkWinCondition(room);
    if (winner) {
      room.phase = 'end';
      room.winner = winner;
      room.actionLog.push(`${winner} wins!`);
    } else {
      // Move to next night
      room.day++;
      room.phase = 'night';
      room.phaseStartTime = Date.now();
      room.phaseTimer = 60;
    }
  }

  /**
   * Check win condition
   */
  checkWinCondition(room) {
    const aliveWolves = room.players.filter(p => p.alive && p.role === 'wolf').length;
    const aliveVillagers = room.players.filter(p => p.alive && p.role !== 'wolf').length;

    if (aliveWolves === 0) return 'villagers';
    if (aliveWolves >= aliveVillagers) return 'wolves';
    return null;
  }

  /**
   * Advance phase manually (host control)
   */
  advancePhase(roomCode, hostId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Room not found');

    const host = room.players.find(p => p.id === hostId);
    if (!host || !host.isHost) throw new Error('Only host can advance phase');

    if (room.phase === 'night') {
      this.resolveNight(room);
    } else if (room.phase === 'day') {
      room.phase = 'vote';
      room.phaseStartTime = Date.now();
      room.phaseTimer = 60;
    } else if (room.phase === 'vote') {
      this.resolveVote(room);
    }

    return room;
  }

  /**
   * Transfer host to another player
   */
  transferHost(roomCode, currentHostId, newHostId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Room not found');

    const currentHost = room.players.find(p => p.id === currentHostId);
    if (!currentHost || !currentHost.isHost) {
      throw new Error('Only host can transfer');
    }

    const newHost = room.players.find(p => p.id === newHostId);
    if (!newHost) throw new Error('New host not found');

    currentHost.isHost = false;
    newHost.isHost = true;

    room.actionLog.push(`Host transferred to ${newHost.name}`);
    return room;
  }

  /**
   * Auto-transfer host on disconnect
   */
  autoTransferHost(room) {
    const connectedPlayers = room.players.filter(p => p.connected);
    if (connectedPlayers.length === 0) return;

    const newHost = connectedPlayers[0];
    newHost.isHost = true;
    room.actionLog.push(`Host auto-transferred to ${newHost.name}`);
  }

  /**
   * Kick player
   */
  kickPlayer(roomCode, hostId, targetId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Room not found');

    const host = room.players.find(p => p.id === hostId);
    if (!host || !host.isHost) throw new Error('Only host can kick');

    room.players = room.players.filter(p => p.id !== targetId);
    room.actionLog.push('Player was kicked');
    return room;
  }

  /**
   * Reset game
   */
  resetGame(roomCode, hostId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Room not found');

    const host = room.players.find(p => p.id === hostId);
    if (!host || !host.isHost) throw new Error('Only host can reset');

    // Reset to lobby
    room.phase = 'lobby';
    room.day = 0;
    room.players.forEach(p => {
      p.role = null;
      p.alive = true;
      p.hasVoted = false;
      p.isSpectator = false;
    });
    room.votes.clear();
    room.nightActions.clear();
    room.winner = null;
    room.actionLog = ['Game reset'];

    return room;
  }

  /**
   * End game
   */
  endGame(roomCode, hostId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Room not found');

    const host = room.players.find(p => p.id === hostId);
    if (!host || !host.isHost) throw new Error('Only host can end game');

    room.phase = 'end';
    room.actionLog.push('Game ended by host');
    return room;
  }

  /**
   * Handle player disconnect
   */
  handleDisconnect(roomCode, playerId) {
    const room = this.rooms.get(roomCode);
    if (!room) return;

    const player = room.players.find(p => p.id === playerId);
    if (!player) return;

    player.connected = false;

    // If host disconnected, transfer host
    if (player.isHost) {
      player.isHost = false;
      this.autoTransferHost(room);
    }
  }

  /**
   * Get room state
   */
  getRoom(roomCode) {
    return this.rooms.get(roomCode);
  }

  /**
   * Get player's view of room (hide other players' roles)
   */
  getPlayerView(roomCode, playerId) {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const player = room.players.find(p => p.id === playerId);
    if (!player) return null;

    // Clone room and hide roles
    const playerView = {
      ...room,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        connected: p.connected,
        isHost: p.isHost,
        hasVoted: p.hasVoted,
        isSpectator: p.isSpectator,
        // Only show role if it's the player themselves or game ended
        role: (p.id === playerId || room.phase === 'end') ? p.role : null
      })),
      // Hide action log if not host
      actionLog: player.isHost ? room.actionLog : []
    };

    return playerView;
  }
}


module.exports = { GameManager };
