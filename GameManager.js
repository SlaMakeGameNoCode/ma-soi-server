const { nanoid } = require('nanoid');

const ROLE_TYPES = {
  ALPHA_WOLF: 'alphaWolf',
  WOLF: 'wolf',
  DETECTIVE: 'detective',
  SEER: 'seer',
  WITCH: 'witch',
  HUNTER: 'hunter',
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

    // Bodyguard Constraint: Cannot protect same person twice
    if (player.role === ROLE_TYPES.BODYGUARD && actionType === 'PROTECT') {
      if (player.attributes.lastProtectedId === targetId) {
        throw new Error('Không được bảo vệ cùng 1 người 2 đêm liên tiếp!');
      }
    }

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

    // 4. Bodyguard Logic (Collect Protection)
    let protectedTargetId = null;
    room.actions.forEach((data, actorId) => {
      const actor = room.players.find(p => p.id === actorId);
      if (actor && actor.role === ROLE_TYPES.BODYGUARD && actor.alive && data.type === 'PROTECT') {
        protectedTargetId = data.targetId;
        // Validated in submitAction (lastProtectedId)
        actor.attributes.lastProtectedId = data.targetId;
        logs.push(`🛡️ Bảo vệ đã chọn người để bảo vệ.`);
      }
    });

    // 5. Hunter Logic (Collect Pins)
    const hunterPins = new Map(); // hunterId -> targetId
    room.actions.forEach((data, actorId) => {
      const actor = room.players.find(p => p.id === actorId);
      if (actor && actor.role === ROLE_TYPES.HUNTER && actor.alive && data.type === 'PIN') {
        hunterPins.set(actorId, data.targetId);
        actor.attributes.pinnedTargetId = data.targetId;
      }
    });

    // 6. Witch Logic (KILL Potion)
    // Note: Witch CAN kill Bodyguard protected target? Usually NO.


    room.actions.forEach((data, actorId) => {
      const actor = room.players.find(p => p.id === actorId);
      if (actor && actor.role === ROLE_TYPES.WITCH && actor.alive) {
        if (data.type === 'KILL') {
          if (!actor.attributes.hasKilled) {
            const target = room.players.find(p => p.id === data.targetId);
            if (target && target.alive) {
              if (target.id === protectedTargetId) {
                logs.push(`🛡️ ${target.name} bị tấn công nhưng được Bảo vệ cứu sống!`);
                actor.attributes.hasKilled = true;
              } else {
                target.alive = false;
                logs.push(`💀 ${target.name} đã chết một cách bí ẩn (Phù thủy).`);
                actor.attributes.hasKilled = true;
              }
            }
          }
        } else if (data.type === 'SAVE') {
          if (killTargetId && data.targetId === killTargetId) {
            if (!actor.attributes.hasSaved) {
              const victim = room.players.find(p => p.id === killTargetId);
              if (victim) {
                victim.alive = true;
                logs.push(`🧙 Phù thủy đã cứu sống ${victim.name}!`);
                actor.attributes.hasSaved = true;
              }
            }
          }
        }
      }
    });

    // 5. Seer Logic
    if (detectiveTarget) { // Reusing variable name or create new? Let's fix variable checking
      // Detective Code ...
    }

    // Separate loop for Seer to avoid variable mixup
    room.actions.forEach((data, actorId) => {
      const actor = room.players.find(p => p.id === actorId);
      if (actor && actor.role === ROLE_TYPES.SEER && actor.alive && data.type === 'CHECK') {
        const target = room.players.find(p => p.id === data.targetId);
        if (target) {
          // Log result. Ideally private.
          const isWolf = target.faction === FACTIONS.WOLF;
          logs.push(`🔮 Tiên tri soi: ${target.name} là ${isWolf ? 'SÓI 🐺' : 'NGƯỜI 🧑'}`);
        }
      }
    });

    // 6. Detective Logic
    // ... Existing Detective Code ...
    if (detectiveTarget) {
      const target = room.players.find(p => p.id === detectiveTarget);
      if (target) {
        const hasAction = [ROLE_TYPES.WOLF, ROLE_TYPES.ALPHA_WOLF, ROLE_TYPES.DETECTIVE, ROLE_TYPES.LAWYER, ROLE_TYPES.SEER, ROLE_TYPES.WITCH].includes(target.role);
        const msg = hasAction ? "Mục tiêu CÓ hoạt động đêm nay." : "Mục tiêu KHÔNG hoạt động đêm nay.";
        logs.push(`🔍 Thám tử soi: ${target.name} -> ${msg}`);
      }
    }


    // 7. Hunter Death Check (If Hunter died tonight, kill pinned target)
    // Who died tonight? Check 'alive' status of Hunters.
    hunterPins.forEach((targetId, hunterId) => {
      const hunter = room.players.find(p => p.id === hunterId);
      // If Hunter IS NOW DEAD (set to false in steps above)
      if (hunter && !hunter.alive) {
        const target = room.players.find(p => p.id === targetId);
        if (target && target.alive) {
          // Check Bodyguard? Usually Hunter shot is Unstoppable.
          // Spec says "If Hunter dies, pinned person dies".
          target.alive = false;
          logs.push(`🏹 Thợ săn ${hunter.name} chết đã kéo theo ${target.name}!`);
        }
      }
    });

    // Cleanup
    room.actions.clear();
    room.players.forEach(p => p.hasVoted = false);

    // Check win condition after night deaths
    this.checkWin(room);

    // Transition to day (unless game ended)
    if (room.phase !== 'end') {
      room.phase = 'day';
      room.actionLog.push(...logs);
    }
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

    // Track executed player for client notification
    room.executedPlayerId = null;

    if (targetId) {
      const victim = room.players.find(p => p.id === targetId);

      // Lawyer Intervention
      const protectedId = room.actions.get('LAWYER_PROTECT');
      if (protectedId === targetId) {
        room.actionLog.push(`⚖️ Luật sự can thiệp! ${victim.name} được miễn án tử.`);
      } else {
        victim.alive = false;
        room.executedPlayerId = targetId; // Store for client notification
        room.actionLog.push(`⚖️ ${victim.name} đã bị treo cổ.`);

        if (victim.role === ROLE_TYPES.HUNTER) {
          const pinId = victim.attributes.pinnedTargetId;
          if (pinId) {
            const target = room.players.find(p => p.id === pinId);
            if (target && target.alive) {
              target.alive = false;
              room.actionLog.push(`🏹 Thợ săn ${victim.name} chết đã kéo theo ${target.name}!`);
            }
          }
        }

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
      // Change: Go to 'execution_reveal' instead of 'night' directly
      room.phase = 'execution_reveal';
      room.actionLog.push('🗣️ Chuẩn bị công bố kết quả bầu cử...');
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
      // resolveVote now sets phase to 'execution_reveal' (unless game end)
    } else if (room.phase === 'execution_reveal') {
      room.phase = 'night';
      room.actionLog.push('🌙 Màn đêm buông xuống...');
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
      // Update Night Roles
      const nightRoles = [ROLE_TYPES.ALPHA_WOLF, ROLE_TYPES.WOLF, ROLE_TYPES.DETECTIVE, ROLE_TYPES.SEER, ROLE_TYPES.WITCH, ROLE_TYPES.BODYGUARD, ROLE_TYPES.HUNTER];
      // Hunter now has PIN action, so they are ACTIVE at night
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
