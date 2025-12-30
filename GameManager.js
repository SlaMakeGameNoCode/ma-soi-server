const { nanoid } = require('nanoid');

const ROLE_TYPES = {
  ALPHA_WOLF: 'alphaWolf',
  WOLF: 'wolf',
  DETECTIVE: 'detective',
  LAWYER: 'lawyer',
  TRAITOR: 'traitor',
  VILLAGER: 'villager'
};

const FACTIONS = {
  WOLF: 'wolf',
  VILLAGER: 'villager',
  NEUTRAL: 'neutral'
};

class GameManager {
  constructor() {
    this.rooms = new Map();
  }

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
        faction: null,
        alive: true,
        connected: true,
        isHost: true,
        hasVoted: false,
        lastAction: Date.now(),
        token,
        attributes: {} // For cursed status, etc.
      }],
      votes: new Map(),
      actions: new Map(), // General actions map (night & day)
      winner: null,
      actionLog: [],
      config: null // Store role config
    };

    this.rooms.set(roomCode, room);
    return { roomCode, playerId: hostId, token };
  }

  joinRoom(roomCode, playerName, reconnectToken = null) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Room not found');

    if (reconnectToken) {
      const existingPlayer = room.players.find(p => p.token === reconnectToken);
      if (existingPlayer) {
        existingPlayer.connected = true;
        return { playerId: existingPlayer.id, token: existingPlayer.token, reconnected: true };
      }
    }

    if (room.phase !== 'lobby') throw new Error('Game already started');

    const playerId = nanoid();
    const token = nanoid(32);

    room.players.push({
      id: playerId,
      name: playerName,
      role: null,
      faction: null,
      alive: true,
      connected: true,
      isHost: false,
      hasVoted: false,
      lastAction: Date.now(),
      token,
      attributes: {}
    });

    return { playerId, token, reconnected: false };
  }

  startGame(roomCode, hostId, roleConfig) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Room not found');

    const host = room.players.find(p => p.id === hostId);
    if (!host || !host.isHost) throw new Error('Permission denied');

    // Validation
    const totalPlayers = room.players.length;
    const totalRoles = Object.values(roleConfig).reduce((sum, r) => sum + r.count, 0);

    // We can have more players than configured roles (rest become Villagers)
    // But duplicate checks should be handled

    this.assignRoles(room, roleConfig);

    room.phase = 'night';
    room.day = 1;
    room.actionLog.push(`Game bắt đầu với ${totalPlayers} người chơi (trừ Host).`);

    return room;
  }

  assignRoles(room, config) {
    let pool = [];

    // Add configured roles
    Object.entries(config).forEach(([roleKey, data]) => {
      for (let i = 0; i < data.count; i++) {
        pool.push(roleKey);
      }
    });

    // Fill rest with Villagers
    // Target only non-host players
    const playersToAssign = room.players.filter(p => !p.isHost);

    while (pool.length < playersToAssign.length) {
      pool.push(ROLE_TYPES.VILLAGER);
    }

    // Shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    // Assign
    playersToAssign.forEach((player, i) => {
      const role = pool[i];
      player.role = role;
      player.attributes = {}; // Reset attributes

      // Set Faction
      if (role === ROLE_TYPES.ALPHA_WOLF || role === ROLE_TYPES.WOLF) {
        player.faction = FACTIONS.WOLF;
      } else if (role === ROLE_TYPES.TRAITOR) {
        player.faction = FACTIONS.NEUTRAL;
      } else {
        player.faction = FACTIONS.VILLAGER;
      }
    });
  }

  // Handle Action (Night or Day)
  submitAction(roomCode, playerId, actionType, targetId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Room not found');

    const player = room.players.find(p => p.id === playerId);
    if (!player || !player.alive) throw new Error('Invalid player');

    // Store action
    // Key: playerId, Value: { type, targetId }
    room.actions.set(playerId, { type: actionType, targetId });
    player.hasVoted = true;

    // Return sensitive details for Host Log
    return {
      actorName: player.name,
      actorRole: player.role,
      actionType: actionType,
      targetName: room.players.find(p => p.id === targetId)?.name || 'Unknown'
    };
  }

  // Determine if phase (Night/Day) is ready to end
  // For basic version, Host manually advances phase. 
  // But we can check if all "Active" roles have acted.

  resolveNight(room) {
    const logs = [];

    // 1. Collect Actions
    const wolfKills = new Map(); // targetId -> count
    let alphaCurseTarget = null;
    let detectiveTarget = null;

    // Map actions
    room.actions.forEach((data, actorId) => {
      const actor = room.players.find(p => p.id === actorId);
      if (!actor || !actor.alive) return;

      if (actor.role === ROLE_TYPES.WOLF || actor.role === ROLE_TYPES.ALPHA_WOLF) {
        if (data.type === 'KILL') {
          wolfKills.set(data.targetId, (wolfKills.get(data.targetId) || 0) + 1);
        }
        if (actor.role === ROLE_TYPES.ALPHA_WOLF && data.type === 'CURSE') {
          if (!actor.attributes.hasCursed) { // Check if used once
            alphaCurseTarget = data.targetId;
            actor.attributes.hasCursed = true; // Mark used
          }
        }
      }

      if (actor.role === ROLE_TYPES.DETECTIVE && data.type === 'CHECK') {
        detectiveTarget = data.targetId;
      }
    });

    // 2. Determine Wolf Kill Target (Consensus)
    let killTargetId = null;
    let maxVotes = 0;
    wolfKills.forEach((count, targetId) => {
      if (count > maxVotes) {
        maxVotes = count;
        killTargetId = targetId;
      }
    });

    // 3. Resolve Alpha Curse + Kill Interaction
    if (killTargetId) {
      const victim = room.players.find(p => p.id === killTargetId);
      if (victim) {
        // CURSE LOGIC: If cursed target is killed by wolves SAME NIGHT
        if (alphaCurseTarget === killTargetId) {
          // Revive & Convert
          victim.faction = FACTIONS.WOLF;
          logs.push(`🌙 ${victim.name} bị cắn nhưng sống sót... một cách kỳ lạ.`);
          // Note: Spec says "Target switches faction". Role display should eventually update?
          // For now, internal faction change.
        } else {
          // Provide death
          victim.alive = false;
          logs.push(`💀 ${victim.name} đã bị Sói giết.`);
        }
      }
    } else {
      logs.push('🌙 Không có ai bị giết đêm qua.');
    }

    // 4. Detective Logic
    // "Has night action" or "Has no night action"
    // Roles with actions: Wolves, Alpha, Doctor/Lawyer(if night?), Seer, Detective.
    // Spec doesn't define "night action" list clearly, assume active roles.
    if (detectiveTarget) {
      const target = room.players.find(p => p.id === detectiveTarget);
      if (target) {
        // Send PRIVATE message to Detective (how? Socket emission needed later)
        // For now, log to generic log is bad (public). 
        // We need a way to store private feedback.
        const hasAction = [ROLE_TYPES.WOLF, ROLE_TYPES.ALPHA_WOLF, ROLE_TYPES.DETECTIVE, ROLE_TYPES.LAWYER].includes(target.role);
        // Lawyer checks person at night? Spec says Lawyer protects from DAY execution.
        // Assuming Lawyer acts at night to setup protection? Or during day?
        // Let's assume Lawyer acts at NIGHT to protect for the NEXT DAY.

        const msg = hasAction ? "Mục tiêu CÓ hoạt động đêm nay." : "Mục tiêu KHÔNG hoạt động đêm nay.";
        // Store this to send to detective specifically? 
        // Implementation detail: Append to room.privateMessages?
        // Temporary hack: log to main log but only readable effectively if we had private channels.
        // Since we don't have private channels yet, we will just log it generally but this ruins secrecy.
        // BETTER: Append to specific player's action response or just leave for now until private msgs implemented.
        // For now, let's Push to generic log with specific styling or just Generic Log.
        logs.push(`🔍 Thám tử soi: ${target.name} -> ${msg}`);
      }
    }

    // Cleanup
    room.actions.clear();
    room.players.forEach(p => p.hasVoted = false);

    // Transition
    room.phase = 'day';
    room.actionLog.push(...logs);
  }

  submitVote(roomCode, playerId, targetId) {
    const room = this.rooms.get(roomCode);
    if (!room || room.phase !== 'vote') return;

    const player = room.players.find(p => p.id === playerId);
    if (player && player.alive) {
      room.votes.set(playerId, targetId);
      player.hasVoted = true;
    }
  }

  // Lawyer Action (Protection)
  // Spec: "Protect 1 player from day execution". "Activates after voting ends".
  // This implies Lawyer submits this BEFORE vote resolution.
  submitLawyerProtect(roomCode, playerId, targetId) {
    const room = this.rooms.get(roomCode);
    const player = room.players.find(p => p.id === playerId);
    if (player && player.role === ROLE_TYPES.LAWYER && player.alive) {
      if (!player.attributes.hasProtected) { // One time use
        room.actions.set('LAWYER_PROTECT', targetId); // Gloal action key
        player.attributes.hasProtected = true;
      }
    }
  }

  resolveVote(room) {
    const votes = new Map();
    room.votes.forEach(t => votes.set(t, (votes.get(t) || 0) + 1));

    let max = 0;
    let targetId = null;
    votes.forEach((c, id) => {
      if (c > max) { max = c; targetId = id; }
    });

    if (targetId) {
      const victim = room.players.find(p => p.id === targetId);

      // Lawyer Intervention
      const protectedId = room.actions.get('LAWYER_PROTECT');
      if (protectedId === targetId) {
        room.actionLog.push(`⚖️ Luật sự can thiệp! ${victim.name} được miễn án tử.`);
      } else {
        victim.alive = false;
        room.actionLog.push(`⚖️ ${victim.name} đã bị treo cổ.`);

        // Traitor Win Logic
        if (victim.role === ROLE_TYPES.TRAITOR) {
          if (room.day === 1) { // Night 1 or Day 1 (Day count usually starts at 1)
            room.winner = 'TRAITOR';
            room.actionLog.push(`🎭 Kẻ Phản Bội ${victim.name} THẮNG nhờ bị treo cổ!`);
            room.phase = 'end';
            return;
          } else {
            // Become normal villager (logic handled implicitly, they are dead anyway?)
            // Spec: "After Day 1: Becomes normal Villager". 
            // This means if they survive Day 1, they change faction?
            // "Loses special win condition".
          }
        }
      }
    } else {
      room.actionLog.push('⚖️ Không ai bị treo cổ.');
    }

    room.votes.clear();
    room.actions.delete('LAWYER_PROTECT'); // Clear lawyer action

    // Win Check
    this.checkWin(room);

    if (room.phase !== 'end') {
      room.day++;
      room.phase = 'night';
    }
  }

  // Manual Phase Advance (Host)
  advancePhase(roomCode, hostId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Không tìm thấy phòng');
    const host = room.players.find(p => p.id === hostId);
    if (!host || !host.isHost) throw new Error('Không có quyền Host');

    if (room.phase === 'night') {
      this.resolveNight(room);
    } else if (room.phase === 'day') {
      room.phase = 'vote';
      room.actionLog.push('☀️ Thảo luận kết thúc. Bắt đầu bỏ phiếu!');
    } else if (room.phase === 'vote') {
      this.resolveVote(room);
    }

    return room;
  }

  endGame(roomCode, hostId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Không tìm thấy phòng');
    if (!room.players.find(p => p.id === hostId && p.isHost)) throw new Error('Không có quyền Host');

    room.phase = 'end';
    room.actionLog.push('🛑 Host đã kết thúc game.');
    return room;
  }

  resetGame(roomCode, hostId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Không tìm thấy phòng');
    if (!room.players.find(p => p.id === hostId && p.isHost)) throw new Error('Không có quyền Host');

    room.phase = 'lobby';
    room.day = 0;
    room.votes.clear();
    room.actions.clear();
    room.winner = null;
    room.actionLog = ['🔄 Game đã được reset.'];

    // Reset players
    room.players.forEach(p => {
      p.role = null;
      p.faction = null;
      p.alive = true;
      p.hasVoted = false;
      p.attributes = {};
    });

    return room;
  }

  checkWin(room) {
    const wolves = room.players.filter(p => p.alive && p.faction === FACTIONS.WOLF).length;
    const others = room.players.filter(p => p.alive && p.faction !== FACTIONS.WOLF).length;

    if (wolves === 0) {
      room.winner = 'VILLAGERS';
      room.phase = 'end';
      room.actionLog.push('🏆 DÂN LÀNG CHIẾN THẮNG!');
    } else if (wolves >= others) {
      room.winner = 'WOLVES';
      room.phase = 'end';
      room.actionLog.push('🐺 SÓI ĐÃ CHIẾN THẮNG!');
    }
  }

  getActionStatus(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    let total = 0;
    let submitted = 0;

    if (room.phase === 'vote') {
      total = room.players.filter(p => p.alive).length;
      submitted = room.votes.size;
    } else if (room.phase === 'night') {
      const nightRoles = [ROLE_TYPES.ALPHA_WOLF, ROLE_TYPES.WOLF, ROLE_TYPES.DETECTIVE];
      const activePlayers = room.players.filter(p => p.alive && nightRoles.includes(p.role));
      total = activePlayers.length;
      submitted = activePlayers.filter(p => room.actions.has(p.id)).length;
    }

    return { submitted, total };
  }

  // Getters & Helpers matching old API to avoid breaking server.js too much
  getRoom(roomCode) { return this.rooms.get(roomCode); }
  getPlayerView(roomCode, playerId) {
    const room = this.rooms.get(roomCode);
    if (!room) return null;
    // ... (implementation similar to before but with roles hidden)
    return {
      ...room,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        isHost: p.isHost,
        alive: p.alive,
        // Show role ONLY if self OR End Game OR Host
        role: (p.id === playerId || room.phase === 'end' || (room.players.find(h => h.id === playerId)?.isHost)) ? p.role : '???'
      }))
    };
  }
  handleDisconnect(roomCode, pid) {
    const room = this.rooms.get(roomCode);
    if (room) {
      const p = room.players.find(i => i.id === pid);
      if (p) p.connected = false;
    }
  }

  kickPlayer(roomCode, hostId, targetId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Không tìm thấy phòng');

    // Validate Host
    const host = room.players.find(p => p.id === hostId);
    if (!host || !host.isHost) throw new Error('Không có quyền Host');

    // Prevent kicking Host
    if (hostId === targetId) throw new Error('Không thể tự kick mình');

    const targetIndex = room.players.findIndex(p => p.id === targetId);
    if (targetIndex === -1) throw new Error('Không tìm thấy người chơi');

    // Remove
    const removedPlayer = room.players[targetIndex];
    room.players.splice(targetIndex, 1);

    // Log
    // room.actionLog.push(`👢 ${removedPlayer.name} đã bị kick khỏi phòng.`); 
    // ^ Maybe not needed for fresh lobby log, but good for debug

    return room;
  }
}

module.exports = { GameManager, ROLE_TYPES };
