const { nanoid } = require('nanoid');

const ROLE_TYPES = {
  ALPHA_WOLF: 'alphaWolf',
  WOLF: 'wolf',
  DETECTIVE: 'detective',
  SEER: 'seer',
  WITCH: 'witch',
  BODYGUARD: 'bodyguard',
  HUNTER: 'hunter',
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
    const safeHostName = String(hostName || 'Host').trim() || 'Host';
    const normalizedHostName = safeHostName.slice(0, 30);
    const roomCode = nanoid(6).toUpperCase();
    const hostId = nanoid();
    const token = nanoid(32);

    const room = {
      roomCode,
      ownerId: hostId,
      phase: 'lobby',
      day: 0,
      maxPlayers: 15, // Default max players (excluding host)
      dayPhaseDuration: 60, // Default day phase duration in seconds
      players: [{
        id: hostId,
        name: normalizedHostName,
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
      finalVotes: new Map(), // For mercy/execute vote after defense
      discussionReady: new Set(), // Players confirming end of discussion
      winner: null,
      actionLog: [],
      config: null, // Store role config
      chatEnabled: true,
      chatLog: [], // keep latest 20 messages
      aiHostEnabled: false,
      aiHostId: null,
      phaseTimer: null,
      pendingExecutionId: null,
      defenseEndsAt: null,
      lastNightDeaths: [],
      aiConfig: {
        nightDuration: 45,
        voteDuration: 30,
        revealDuration: 5
      }
    };

    this.rooms.set(roomCode, room);
    return { roomCode, playerId: hostId, token };
  }

  ensureAIHost(room) {
    if (!room.aiHostId) {
      const botId = nanoid();
      room.aiHostId = botId;
      room.players.push({
        id: botId,
        name: 'AI Host',
        role: null,
        faction: null,
        alive: true,
        connected: true,
        isHost: true,
        hasVoted: false,
        lastAction: Date.now(),
        token: nanoid(32),
        attributes: {}
      });
    }
  }

  enableAIHost(roomCode, hostId, enabled) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Không tìm thấy phòng');
    const host = room.players.find(p => p.id === hostId && p.isHost);
    if (!host) throw new Error('Không có quyền Host');
    room.aiHostEnabled = !!enabled;
    if (room.aiHostEnabled) {
      this.ensureAIHost(room);
    }
    return room;
  }

  setChatEnabled(roomCode, hostId, enabled) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Không tìm thấy phòng');
    const host = room.players.find(p => p.id === hostId && p.isHost);
    if (!host) throw new Error('Không có quyền Host');
    room.chatEnabled = !!enabled;
    return room;
  }

  markDiscussionReady(roomCode, playerId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Không tìm thấy phòng');
    if (room.phase !== 'day') throw new Error('Chỉ xác nhận trong pha thảo luận (ban ngày)');

    const player = room.players.find(p => p.id === playerId);
    if (!player || !player.alive || player.isHost) throw new Error('Người chơi không hợp lệ');

    if (!room.discussionReady) room.discussionReady = new Set();
    room.discussionReady.add(playerId);

    const total = room.players.filter(p => !p.isHost && p.alive).length;
    const ready = room.discussionReady.size;

    return {
      ready,
      total,
      playerName: player.name
    };
  }

  addChatMessage(roomCode, playerId, message) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Không tìm thấy phòng');
    if (!room.chatEnabled) throw new Error('Chat đang tắt');

    const player = room.players.find(p => p.id === playerId);
    if (!player) throw new Error('Người chơi không hợp lệ');

    const trimmed = String(message || '').trim();
    if (!trimmed) throw new Error('Tin nhắn trống');
    const payload = {
      id: nanoid(8),
      playerId,
      name: player.name,
      message: trimmed.slice(0, 200),
      ts: Date.now()
    };

    room.chatLog.push(payload);
    if (room.chatLog.length > 20) {
      room.chatLog = room.chatLog.slice(-20);
    }
    return payload;
  }

  autoMaybeStart(room) {
    if (!room.aiHostEnabled || room.phase !== 'lobby') return;
    const nonHostPlayers = room.players.filter(p => !p.isHost).length;
    const totalRoles = room.config ? Object.values(room.config).reduce((s, r) => s + r.count, 0) : 0;
    if (nonHostPlayers >= Math.max(3, totalRoles || 3)) {
      try {
        this.startGame(room.roomCode, room.aiHostId || room.players.find(p => p.isHost)?.id, room.config || this.defaultRoleConfig(nonHostPlayers));
      } catch (e) {
        // ignore if validation fails
      }
    }
  }

  defaultRoleConfig(count) {
    // minimal fallback roles: 1 wolf, rest villagers
    const wolf = Math.max(1, Math.floor(count / 5));
    return {
      alphaWolf: { count: 0 },
      wolf: { count: wolf },
      detective: { count: 0 },
      seer: { count: 0 },
      witch: { count: 0 },
      bodyguard: { count: 0 },
      hunter: { count: 0 },
      traitor: { count: 0 },
      villager: { count: Math.max(0, count - wolf) }
    };
  }

  schedulePhaseTimer(room) {
    if (room.phaseTimer) {
      clearTimeout(room.phaseTimer);
      room.phaseTimer = null;
    }
    if (!room.aiHostEnabled) return;

    const hostId = room.aiHostId || room.players.find(p => p.isHost)?.id;
    if (!hostId) return;

    const advance = () => {
      try {
        this.advancePhase(room.roomCode, hostId);
      } catch (e) {
        console.error('[AI_HOST] advance error', e.message);
      }
    };

    if (room.phase === 'night') {
      room.phaseTimer = setTimeout(advance, (room.aiConfig.nightDuration || 45) * 1000);
    } else if (room.phase === 'day') {
      room.phaseTimer = setTimeout(advance, (room.dayPhaseDuration || 60) * 1000);
    } else if (room.phase === 'vote') {
      room.phaseTimer = setTimeout(advance, (room.aiConfig.voteDuration || 30) * 1000);
    } else if (room.phase === 'execution_reveal') {
      room.phaseTimer = setTimeout(advance, (room.aiConfig.revealDuration || 5) * 1000);
    } else if (room.phase === 'defense') {
      room.phaseTimer = setTimeout(advance, 30000);
    } else if (room.phase === 'final_verdict') {
      room.phaseTimer = setTimeout(advance, 20000);
    }
  }

  joinRoom(roomCode, playerName, reconnectToken = null) {
    const safePlayerName = String(playerName || 'Người chơi').trim() || 'Người chơi';
    const normalizedPlayerName = safePlayerName.slice(0, 30);
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Room not found');

    if (reconnectToken) {
      const existingPlayer = room.players.find(p => p.token === reconnectToken);
      if (existingPlayer) {
        existingPlayer.connected = true;
        // Safety: if game just started and somehow flags were stale, revive everyone
        if (room.phase === 'night' && room.day === 1) {
          this.resetAliveState(room);
        }
        return { playerId: existingPlayer.id, token: existingPlayer.token, reconnected: true };
      }
    }

    if (room.phase !== 'lobby') throw new Error('Game already started');

    // Check max players limit (excluding host)
    const currentPlayerCount = room.players.filter(p => !p.isHost).length;
    if (currentPlayerCount >= room.maxPlayers) {
      throw new Error(`Phòng đã đầy! Tối đa ${room.maxPlayers} người chơi.`);
    }

    const playerId = nanoid();
    const token = nanoid(32);

    room.players.push({
      id: playerId,
      name: normalizedPlayerName,
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
    const aiHostOk = room.aiHostEnabled && room.aiHostId === hostId;
    if (!host || (!host.isHost && !aiHostOk)) throw new Error('Permission denied');

    if (room.aiHostEnabled) {
      this.ensureAIHost(room);
      // Convert owner host to player so they get a role
      const owner = room.players.find(p => p.id === room.ownerId);
      if (owner) {
        owner.isHost = false;
      }
    }

  // Reset player state for a fresh game
  this.resetAliveState(room);

    // Validation
    const totalPlayers = room.players.length;
    const totalRoles = Object.values(roleConfig).reduce((sum, r) => sum + r.count, 0);

    // We can have more players than configured roles (rest become Villagers)
    // But duplicate checks should be handled

  this.assignRoles(room, roleConfig);

  // Debug: log alive status right after role assignment
  const aliveNonHost = room.players.filter(p => !p.isHost && p.alive).length;
  console.log(`[START_GAME] room ${roomCode} alive non-host after reset: ${aliveNonHost}/${room.players.filter(p => !p.isHost).length}`);

  room.phase = 'night';
  room.day = 1;
  room.discussionReady = new Set();
  room.finalVotes = new Map();
  room.pendingExecutionId = null;
  room.defenseEndsAt = null;
  room.lastNightDeaths = [];
  room.winner = null;
  room.actionLog = [`Game bắt đầu với ${totalPlayers} người chơi (trừ Host).`];

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
    // Special case: Witch can have multiple actions (SAVE + KILL)
    if (player.role === ROLE_TYPES.WITCH) {
      // Get existing actions or create new array
      const existingActions = room.actions.get(playerId) || [];
      // Add new action to array
      existingActions.push({ type: actionType, targetId });
      room.actions.set(playerId, existingActions);
    } else {
      // Other roles: single action
      room.actions.set(playerId, { type: actionType, targetId });
    }
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
    room.lastNightDeaths = [];

    const recordDeath = (player) => {
      if (!player) return;
      if (!room.lastNightDeaths) room.lastNightDeaths = [];
      if (!room.lastNightDeaths.find(d => d.id === player.id)) {
        room.lastNightDeaths.push({ id: player.id, name: player.name });
      }
    };
    const wasAlive = new Map();
    room.players.forEach(p => wasAlive.set(p.id, p.alive));
    room.lastNightDeaths = [];

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

    // 1.5 CRITICAL: Collect Hunter PIN actions BEFORE any deaths are processed
    // This ensures pinnedTargetId is saved even if Hunter dies in the same night
    console.log(`[HUNTER] Collecting PIN actions BEFORE death processing`);
    room.actions.forEach((data, actorId) => {
      const actor = room.players.find(p => p.id === actorId);
      if (!actor || !actor.alive) return;

      const actions = Array.isArray(data) ? data : [data];
      actions.forEach(action => {
        if (actor.role === ROLE_TYPES.HUNTER && action.type === 'PIN') {
          actor.attributes.pinnedTargetId = action.targetId;
          console.log(`[HUNTER] ${actor.name} pinned ${action.targetId} (will persist even if hunter dies)`);
        }
      });
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

    // 2.1 Check Bodyguard Protection (BEFORE Witch SAVE and Wolf kill)
    let protectedTargetId = null;
    console.log(`[BODYGUARD] Checking protection, total actions: ${room.actions.size}`);
    room.actions.forEach((data, actorId) => {
      const actor = room.players.find(p => p.id === actorId);
      // Handle both single action (object) and multiple actions (array for Witch)
      const actions = Array.isArray(data) ? data : [data];
      actions.forEach(action => {
        console.log(`[BODYGUARD] Action from ${actorId}: type=${action.type}, role=${actor?.role}`);
        if (actor && actor.role === ROLE_TYPES.BODYGUARD && actor.alive && action.type === 'PROTECT') {
          protectedTargetId = action.targetId;
          actor.attributes.lastProtectedId = action.targetId;
          console.log(`[BODYGUARD] Protected ${action.targetId}`);
        }
      });
    });

    // 2.5 Check Witch SAVE (BEFORE applying wolf kill)
    let witchSavedTarget = null;
    console.log(`[WITCH_SAVE] Checking saves, total actions: ${room.actions.size}`);
    room.actions.forEach((data, actorId) => {
      const actor = room.players.find(p => p.id === actorId);
      // Handle both single action and multiple actions (array for Witch)
      const actions = Array.isArray(data) ? data : [data];
      actions.forEach(action => {
        console.log(`[WITCH_SAVE] Action from ${actorId}: type=${action.type}, role=${actor?.role}, alive=${actor?.alive}`);
        if (actor && actor.role === ROLE_TYPES.WITCH && actor.alive && action.type === 'SAVE') {
          console.log(`[WITCH_SAVE] Witch ${actor.name} trying to save ${action.targetId}, wolf target: ${killTargetId}`);
          if (killTargetId && action.targetId === killTargetId && !actor.attributes.hasSaved) {
            witchSavedTarget = killTargetId;
            console.log(`[WITCH_SAVE] SUCCESS! Saved ${killTargetId}`);
            actor.attributes.hasSaved = true;
          } else {
            console.log(`[WITCH_SAVE] FAILED - killTargetId: ${killTargetId}, match: ${action.targetId === killTargetId}, hasSaved: ${actor.attributes.hasSaved}`);
          }
        }
      });
    });

    // 3. Resolve Alpha Curse + Kill Interaction (AFTER Bodyguard and Witch checks)
    console.log(`[WOLF_KILL] killTargetId: ${killTargetId}, protectedTargetId: ${protectedTargetId}, witchSavedTarget: ${witchSavedTarget}`);

    // Check if target is protected by Bodyguard OR saved by Witch
    if (killTargetId && killTargetId !== witchSavedTarget && killTargetId !== protectedTargetId) {
      const victim = room.players.find(p => p.id === killTargetId);
      if (victim) {
        console.log(`[WOLF_KILL] Applying kill to ${victim.name}`);
        // CURSE LOGIC: If cursed target is killed by wolves SAME NIGHT
        if (alphaCurseTarget === killTargetId) {
          // Revive & Convert
          victim.faction = FACTIONS.WOLF;
          logs.push(`🌙 ${victim.name} bị cắn nhưng sống sót... một cách kỳ lạ.`);
        } else {
          // Apply death
          victim.alive = false;
            recordDeath(victim);
          logs.push(`💀 ${victim.name} đã bị Sói giết.`);
        }
      }
    } else if (!killTargetId) {
      logs.push('🌙 Không có ai bị giết đêm qua.');
    } else if (killTargetId === protectedTargetId) {
      // Bodyguard protected
      console.log(`[BODYGUARD] Protection successful!`);
      logs.push('🌙 Không có ai chết đêm qua.');
    } else {
      // Witch saved someone
      console.log(`[WOLF_KILL] CANCELLED by Witch save`);
      logs.push('🌙 Không có ai chết đêm qua.');
    }

    // 4. Bodyguard Logic - MOVED EARLIER (before wolf kill)
    // Protection already collected above

    // 5. Hunter PIN collection already done at step 1.5 above

    // 6. Witch Logic (KILL Potion)
    console.log(`[WITCH_KILL] Checking witch kills`);
    room.actions.forEach((data, actorId) => {
      const actor = room.players.find(p => p.id === actorId);
      if (actor && actor.role === ROLE_TYPES.WITCH && actor.alive) {
        const actions = Array.isArray(data) ? data : [data];
        actions.forEach(action => {
          console.log(`[WITCH_KILL] Witch action: type=${action.type}, targetId=${action.targetId}`);
          if (action.type === 'KILL') {
            if (!actor.attributes.hasKilled) {
              const target = room.players.find(p => p.id === action.targetId);
              if (target && target.alive) {
                if (action.targetId === protectedTargetId) {
                  // Don't reveal Bodyguard protection to players
                  actor.attributes.hasKilled = true;
                } else {
                  target.alive = false;
                  recordDeath(target);
                  logs.push(`💀 ${target.name} đã chết một cách bí ẩn (Phù thủy).`);
                  actor.attributes.hasKilled = true;
                  console.log(`[WITCH_KILL] SUCCESS! Killed ${target.name}`);
                }
              }
            }
          }
        });
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
    // IMPORTANT: Process this BEFORE checkWin so deaths are counted
    // Hunter death link is UNSTOPPABLE - bypasses Bodyguard protection
    console.log(`[HUNTER] Checking death links`);
    room.players.forEach(hunter => {
      if (hunter.role === ROLE_TYPES.HUNTER) {
        console.log(`[HUNTER] Found hunter ${hunter.name}: alive=${hunter.alive}, pinnedTargetId=${hunter.attributes.pinnedTargetId}`);
      }
      if (hunter.role === ROLE_TYPES.HUNTER && !hunter.alive && hunter.attributes.pinnedTargetId) {
        const targetId = hunter.attributes.pinnedTargetId;
        const target = room.players.find(p => p.id === targetId);
        console.log(`[HUNTER] Death link check: target=${target?.name}, target.alive=${target?.alive}`);
        if (target && target.alive) {
          target.alive = false;
            recordDeath(target);
          logs.push(`🏹 Thợ săn ${hunter.name} chết đã kéo theo ${target.name}!`);
          console.log(`[HUNTER] Death link triggered: ${target.name} dies with hunter`);
        }
      }
    });

    // Cleanup
    room.actions.clear();
    room.players.forEach(p => p.hasVoted = false);

    // Capture deaths from night
    room.lastNightDeaths = room.players
      .filter(p => wasAlive.get(p.id) && !p.alive && !p.isHost)
      .map(p => ({ id: p.id, name: p.name }));

    // Check win condition after ALL deaths (including hunter death link)
    this.checkWin(room);

    // Transition to day (unless game ended)
    if (room.phase !== 'end') {
      room.phase = 'day';
      room.discussionReady = new Set();
      room.pendingExecutionId = null;
      room.finalVotes = new Map();
      room.actionLog.push(...logs);
    }
  }

  submitVote(roomCode, playerId, targetId) {
    const room = this.rooms.get(roomCode);
    if (!room || (room.phase !== 'vote' && room.phase !== 'final_verdict')) return null;

    const player = room.players.find(p => p.id === playerId);
    if (player && player.alive) {
      if (room.phase === 'vote') {
        // Support SKIP votes (targetId can be "SKIP" or null)
        room.votes.set(playerId, targetId);
        player.hasVoted = true;

        // Calculate current vote leader and get vote details
        const voteLeader = this.getVoteLeader(room);
        const voteDetails = this.getVoteDetails(room);

        return { ...voteLeader, voteDetails };
      } else if (room.phase === 'final_verdict') {
        if (!room.finalVotes) room.finalVotes = new Map();
        const choice = targetId === 'EXECUTE' ? 'EXECUTE' : 'SPARE';
        room.finalVotes.set(playerId, choice);
        player.hasVoted = true;

        const totalVotes = room.players.filter(p => p.alive).length;
        const executeVotes = Array.from(room.finalVotes.values()).filter(v => v === 'EXECUTE').length;

        return {
          leaderId: null,
          leaderName: choice === 'EXECUTE' ? 'Giết' : 'Không giết',
          voteCount: executeVotes,
          totalVotes,
          final: true
        };
      }
    }
    return null;
  }

  getVoteLeader(room) {
    const voteCounts = new Map();

    // Count votes for each player (exclude SKIP votes)
    room.votes.forEach((targetId) => {
      if (targetId && targetId !== 'SKIP') {
        voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
      }
    });

    // Find player with most votes
    let maxVotes = 0;
    let leaderId = null;
    let leaderName = null;

    voteCounts.forEach((count, targetId) => {
      if (count > maxVotes) {
        maxVotes = count;
        leaderId = targetId;
        const target = room.players.find(p => p.id === targetId);
        leaderName = target ? target.name : 'Unknown';
      }
    });

    return {
      leaderId,
      leaderName,
      voteCount: maxVotes,
      totalVotes: room.votes.size
    };
  }

  getVoteDetails(room) {
    const details = [];
    room.votes.forEach((targetId, voterId) => {
      const voter = room.players.find(p => p.id === voterId);
      const target = room.players.find(p => p.id === targetId);

      details.push({
        voterId,
        voterName: voter ? voter.name : 'Unknown',
        targetId,
        targetName: targetId === 'SKIP' ? 'Bỏ qua' : (target ? target.name : 'Unknown')
      });
    });
    return details;
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
    // Log vote details BEFORE resolution
    const voteDetails = this.getVoteDetails(room);
    const voteLog = voteDetails.map(v => `${v.voterName} → ${v.targetName}`).join(', ');
    room.actionLog.push(`🗳️ Kết quả bỏ phiếu: ${voteLog}`);

    const votes = new Map();
    // Count votes, excluding SKIP
    room.votes.forEach(t => {
      if (t && t !== 'SKIP') {
        votes.set(t, (votes.get(t) || 0) + 1);
      }
    });

    let max = 0;
    let targetId = null;
    votes.forEach((c, id) => {
      if (c > max) { max = c; targetId = id; }
    });

    room.executedPlayerId = null;
    room.pendingExecutionId = null;
    room.defenseEndsAt = null;

    // Lawyer Intervention check BEFORE starting defense
    const protectedId = room.actions.get('LAWYER_PROTECT');

    if (targetId && protectedId === targetId) {
      const victim = room.players.find(p => p.id === targetId);
      room.actionLog.push(`⚖️ Luật sư can thiệp! ${victim?.name || 'Người chơi'} được miễn án tử.`);
      targetId = null; // Cancel execution path
    }

    room.votes.clear();
    room.actions.delete('LAWYER_PROTECT'); // Clear lawyer action

    if (targetId) {
      const victim = room.players.find(p => p.id === targetId);
      room.pendingExecutionId = targetId;
      room.phase = 'defense';
      room.defenseEndsAt = Date.now() + 30000;
      room.actionLog.push(`🛡️ ${victim?.name || 'Người chơi'} có 30s để biện hộ!`);
    } else {
      room.actionLog.push('⚖️ Không ai bị treo cổ.');
      room.day++;
      room.phase = 'execution_reveal';
      room.actionLog.push('🗣️ Chuẩn bị công bố kết quả bầu cử...');
    }

    // Win Check BEFORE execution_reveal
    this.checkWin(room);
  }

  startFinalVerdict(room) {
    room.finalVotes = new Map();
    if (!room.pendingExecutionId) {
      room.actionLog.push('⚖️ Không có ai để xử.');
      room.day++;
      room.phase = 'execution_reveal';
      room.actionLog.push('🗣️ Chuẩn bị công bố kết quả bầu cử...');
      return;
    }

    const victim = room.players.find(p => p.id === room.pendingExecutionId);
    room.phase = 'final_verdict';
    room.actionLog.push(`⚔️ Bỏ phiếu cuối: ${victim?.name || 'Người chơi'} có bị xử tử không?`);
  }

  resolveFinalVerdict(room) {
    const victimId = room.pendingExecutionId;
    const victim = room.players.find(p => p.id === victimId);

    const executeVotes = Array.from(room.finalVotes.values()).filter(v => v === 'EXECUTE').length;
    const spareVotes = Array.from(room.finalVotes.values()).filter(v => v === 'SPARE').length;

    room.executedPlayerId = null;

    if (victim && executeVotes > spareVotes) {
      victim.alive = false;
      room.executedPlayerId = victimId;
      room.actionLog.push(`⚖️ Kết quả cuối: ${victim.name} bị xử tử (${executeVotes} vs ${spareVotes}).`);

      if (victim.role === ROLE_TYPES.TRAITOR && room.day === 1) {
        room.winner = 'TRAITOR';
        room.actionLog.push(`🎭 Kẻ Phản Bội ${victim.name} THẮNG nhờ bị treo cổ!`);
        room.phase = 'end';
        return;
      }

      if (victim.role === ROLE_TYPES.HUNTER && victim.attributes.pinnedTargetId) {
        const pinnedTarget = room.players.find(p => p.id === victim.attributes.pinnedTargetId);
        if (pinnedTarget && pinnedTarget.alive) {
          pinnedTarget.alive = false;
          room.actionLog.push(`🏹 Thợ săn ${victim.name} chết đã kéo theo ${pinnedTarget.name}!`);
        }
      }
    } else if (victim) {
      room.actionLog.push(`🙏 ${victim.name} được tha (${executeVotes} vs ${spareVotes}).`);
    } else {
      room.actionLog.push('⚖️ Không có mục tiêu để xử.');
    }

  this.checkWin(room);
  if (room.phase === 'end') return;

  room.pendingExecutionId = null;
  room.finalVotes.clear();
  room.discussionReady = new Set();
  room.day++;
  room.phase = 'execution_reveal';
  room.actionLog.push('🗣️ Chuẩn bị công bố kết quả bầu cử...');
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
      room.discussionReady = new Set();
      room.actionLog.push('☀️ Thảo luận kết thúc. Bắt đầu bỏ phiếu!');
    } else if (room.phase === 'vote') {
      this.resolveVote(room);
      // resolveVote now sets phase to 'defense' or 'execution_reveal'
    } else if (room.phase === 'defense') {
      this.startFinalVerdict(room);
    } else if (room.phase === 'final_verdict') {
      this.resolveFinalVerdict(room);
      // resolveFinalVerdict sets phase to 'execution_reveal' (unless game end)
    } else if (room.phase === 'execution_reveal') {
      room.phase = 'night';
      room.pendingExecutionId = null;
      room.executedPlayerId = null;
      room.lastNightDeaths = [];
      room.actionLog.push('🌙 Màn đêm buông xuống...');
    }

    return room;
  }

  endGame(roomCode, hostId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Không tìm thấy phòng');
    if (!room.players.find(p => p.id === hostId && p.isHost)) throw new Error('Không có quyền Host');

    // Reset to lobby instead of ending
    room.phase = 'lobby';
    room.day = 0;
    room.votes.clear();
    room.finalVotes.clear();
    room.discussionReady = new Set();
    room.pendingExecutionId = null;
    room.defenseEndsAt = null;
    room.lastNightDeaths = [];
    room.actions.clear();
    room.winner = null;
    room.actionLog = ['🔄 Host đã kết thúc game. Về Lobby.'];
  room.chatLog = [];

    // Restore owner as host in lobby
    const owner = room.players.find(p => p.id === room.ownerId);
    if (owner) {
      owner.isHost = true;
      owner.role = null;
      owner.faction = null;
    }

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

  resetGame(roomCode, hostId) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Không tìm thấy phòng');
    if (!room.players.find(p => p.id === hostId && p.isHost)) throw new Error('Không có quyền Host');

    room.phase = 'lobby';
    room.day = 0;
    room.votes.clear();
    room.finalVotes.clear();
    room.discussionReady = new Set();
    room.pendingExecutionId = null;
    room.defenseEndsAt = null;
    room.lastNightDeaths = [];
    room.actions.clear();
    room.winner = null;
    room.actionLog = ['🔄 Game đã được reset.'];
  room.chatLog = [];

    // Restore owner as host in lobby
    const owner = room.players.find(p => p.id === room.ownerId);
    if (owner) {
      owner.isHost = true;
      owner.role = null;
      owner.faction = null;
    }

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

  setMaxPlayers(roomCode, hostId, maxPlayers) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Không tìm thấy phòng');
    if (!room.players.find(p => p.id === hostId && p.isHost)) throw new Error('Không có quyền Host');
    if (room.phase !== 'lobby') throw new Error('Chỉ có thể thay đổi trong Lobby');

    // Validate maxPlayers
    if (maxPlayers < 3 || maxPlayers > 50) {
      throw new Error('Số người chơi phải từ 3 đến 50');
    }

    // Check current player count
    const currentPlayerCount = room.players.filter(p => !p.isHost).length;
    if (currentPlayerCount > maxPlayers) {
      throw new Error(`Hiện có ${currentPlayerCount} người chơi. Không thể giảm xuống ${maxPlayers}.`);
    }

    room.maxPlayers = maxPlayers;
    return room;
  }

  setDayPhaseDuration(roomCode, hostId, duration) {
    const room = this.rooms.get(roomCode);
    if (!room) throw new Error('Không tìm thấy phòng');
    if (!room.players.find(p => p.id === hostId && p.isHost)) throw new Error('Không có quyền Host');
    if (room.phase !== 'lobby') throw new Error('Chỉ có thể thay đổi trong Lobby');

    // Validate duration (30s to 300s / 5 minutes)
    if (duration < 30 || duration > 300) {
      throw new Error('Thời gian phải từ 30 đến 300 giây');
    }

    room.dayPhaseDuration = duration;
    return room;
  }

  checkWin(room) {
    // CRITICAL: Exclude Host from win condition checks
    // Host has alive=true but doesn't participate in the game
    const wolves = room.players.filter(p => !p.isHost && p.alive && p.faction === FACTIONS.WOLF).length;
    const others = room.players.filter(p => !p.isHost && p.alive && p.faction !== FACTIONS.WOLF).length;

    console.log(`[WIN_CHECK] Wolves: ${wolves}, Others: ${others}`);

    if (wolves === 0) {
      room.winner = 'VILLAGERS';
      room.phase = 'end';
      room.actionLog.push('🏆 DÂN LÀNG CHIẾN THẮNG!');
      console.log('[WIN_CHECK] Villagers win - no wolves left');
    } else if (wolves >= others) {
      room.winner = 'WOLVES';
      room.phase = 'end';
      room.actionLog.push('🐺 SÓI ĐÃ CHIẾN THẮNG!');
      console.log('[WIN_CHECK] Wolves win - wolves >= others');
    }

    if (room.winner && room.aiHostEnabled) {
      // clear timer on game end
      if (room.phaseTimer) {
        clearTimeout(room.phaseTimer);
        room.phaseTimer = null;
      }
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
    } else if (room.phase === 'final_verdict') {
      total = room.players.filter(p => p.alive).length;
      submitted = room.finalVotes ? room.finalVotes.size : 0;
    }

    return { submitted, total };
  }

  // AI helper: if all actions/votes submitted, auto advance
  maybeAutoAdvance(roomCode) {
    const room = this.rooms.get(roomCode);
    if (!room || !room.aiHostEnabled) return;
    const hostId = room.aiHostId || room.players.find(p => p.isHost)?.id;
    if (!hostId) return;

    if (room.phase === 'night') {
      const status = this.getActionStatus(roomCode);
      if (status && status.total > 0 && status.submitted >= status.total) {
        // Add 2s delay so players can see their action confirmed before phase changes
        setTimeout(() => {
          const currentRoom = this.rooms.get(roomCode);
          if (currentRoom && currentRoom.phase === 'night') {
            this.advancePhase(roomCode, hostId);
          }
        }, 2000);
        return;
      }
    }
    if (room.phase === 'day') {
      const alive = room.players.filter(p => !p.isHost && p.alive).length;
      const ready = room.discussionReady ? room.discussionReady.size : 0;
      console.log(`[maybeAutoAdvance] day phase: ready=${ready}/${alive}`);
      if (alive > 0 && ready >= alive) {
        // Add small delay for UI feedback
        setTimeout(() => {
          const currentRoom = this.rooms.get(roomCode);
          if (currentRoom && currentRoom.phase === 'day') {
            this.advancePhase(roomCode, hostId);
          }
        }, 1500);
        return;
      }
    }
    if (room.phase === 'vote') {
      const status = this.getActionStatus(roomCode);
      if (status && status.total > 0 && status.submitted >= status.total) {
        setTimeout(() => {
          const currentRoom = this.rooms.get(roomCode);
          if (currentRoom && currentRoom.phase === 'vote') {
            this.advancePhase(roomCode, hostId);
          }
        }, 1500);
        return;
      }
    }
    if (room.phase === 'final_verdict') {
      const alive = room.players.filter(p => !p.isHost && p.alive).length;
      const submitted = room.finalVotes ? room.finalVotes.size : 0;
      if (alive > 0 && submitted >= alive) {
        setTimeout(() => {
          const currentRoom = this.rooms.get(roomCode);
          if (currentRoom && currentRoom.phase === 'final_verdict') {
            this.advancePhase(roomCode, hostId);
          }
        }, 1500);
        return;
      }
    }
  }

  // Getters & Helpers matching old API to avoid breaking server.js too much
  getRoom(roomCode) { return this.rooms.get(roomCode); }
  resetAliveState(room) {
    if (!room) return;
    room.players.forEach(p => {
      // Even host/aiHost can safely be marked alive here; isHost is excluded in win/role counts
      p.alive = true;
      p.connected = true;
      p.hasVoted = false;
      p.attributes = {};
    });
  }
  getPlayerView(roomCode, playerId) {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    // Safety net: if at Night 1 all non-host players are somehow marked dead, revive them
    if (room.phase === 'night' && room.day === 1) {
      const nonHost = room.players.filter(p => !p.isHost);
      const alive = nonHost.filter(p => p.alive).length;
      if (nonHost.length > 0 && alive === 0) {
        console.warn(`[SAFETY] Detected all non-host dead at Night 1 in room ${roomCode}; resetting alive state.`);
        this.resetAliveState(room);
      }
    }

  const requestingPlayer = room.players.find(p => p.id === playerId);
    const isHost = requestingPlayer?.isHost || false;
    const isDead = requestingPlayer ? !requestingPlayer.alive : false;

    // Dead players and hosts see everything
    const canSeeAll = isHost || isDead;

    return {
      ...room,
      players: room.players.map(p => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        isHost: p.isHost,
        alive: p.alive,
        // Show role if: self, end game, host, OR dead player
        role: (p.id === playerId || room.phase === 'end' || canSeeAll) ? p.role : '???'
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
