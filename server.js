const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// World and farm config
const MAX_PLAYERS = 50;
const MAP_WIDTH = 4000;
const MAP_HEIGHT = 4000;

const FARM_WIDTH = 8;          // tiles per player (x)
const FARM_HEIGHT = 8;         // tiles per player (y)
const TILE_SIZE = 50;          // must match client
const CROP_GROW_MS = 2 * 60 * 1000; // 2 minutes from water -> ready

// Action durations (ms)
const ACTION_DURATION = {
  plant: 2000,
  water: 1500,
  harvest: 2500
};

// Game state
let gameState = {
  players: new Map(), // id -> Player
  host: null
};

class Player {
  constructor(id, ws, farmIndex) {
    this.id = id;
    this.ws = ws;

    // Allocate farm slot in a grid
    const farmsPerRow = 10;
    const farmXIndex = farmIndex % farmsPerRow;
    const farmYIndex = Math.floor(farmIndex / farmsPerRow);

    this.farmOriginX = farmXIndex * FARM_WIDTH * TILE_SIZE + 50;
    this.farmOriginY = farmYIndex * FARM_HEIGHT * TILE_SIZE + 50;

    // Avatar position (center of farm)
    this.width = 25;
    this.height = 25;
    this.x = this.farmOriginX + (FARM_WIDTH * TILE_SIZE) / 2 - this.width / 2;
    this.y = this.farmOriginY + (FARM_HEIGHT * TILE_SIZE) / 2 - this.height / 2;

    // Stats
    this.wood = 0;
    this.food = 0;
    this.ping = 0;

    // Farm tiles
    this.farmWidth = FARM_WIDTH;
    this.farmHeight = FARM_HEIGHT;
    this.farm = Array.from({ length: FARM_WIDTH * FARM_HEIGHT }, () => ({
      state: 'empty',      // 'empty' | 'seeded' | 'growing' | 'ready'
      cropType: null,
      plantedAt: null,
      wateredAt: null,
      currentAction: null, // 'plant' | 'water' | 'harvest' | null
      actionEndsAt: null
    }));
  }

  toJSON() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      wood: this.wood,
      food: this.food,
      ping: this.ping,
      farmOriginX: this.farmOriginX,
      farmOriginY: this.farmOriginY,
      farmWidth: this.farmWidth,
      farmHeight: this.farmHeight,
      farm: this.farm
    };
  }
}

// Helpers
function broadcastMessage(message) {
  const data = JSON.stringify(message);
  gameState.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(data);
    }
  });
}

function broadcastGameState() {
  const msg = {
    type: 'gameStateUpdate',
    players: Array.from(gameState.players.values()).map(p => p.toJSON())
  };
  broadcastMessage(msg);
}

function selectHost() {
  if (gameState.players.size === 0) {
    gameState.host = null;
    return;
  }
  let newHost = null;
  let lowestPing = Infinity;
  gameState.players.forEach(p => {
    if (p.ping < lowestPing) {
      lowestPing = p.ping;
      newHost = p;
    }
  });
  if (!gameState.host || gameState.host.id !== newHost.id) {
    gameState.host = newHost;
    broadcastMessage({
      type: 'hostChange',
      hostId: newHost.id
    });
  }
}

function getTile(player, tileIndex) {
  if (!player || !player.farm) return null;
  if (tileIndex == null || tileIndex < 0 || tileIndex >= player.farm.length) return null;
  return player.farm[tileIndex];
}

// Start an action on a tile (plant / water / harvest)
function startActionOnTile(player, tileIndex, actionType) {
  const tile = getTile(player, tileIndex);
  if (!tile) return;
  if (tile.currentAction) return;

  if (actionType === 'plant' && tile.state !== 'empty') return;
  if (actionType === 'water' && tile.state !== 'seeded') return;
  if (actionType === 'harvest' && tile.state !== 'ready') return;

  const now = Date.now();
  const duration = ACTION_DURATION[actionType];
  if (!duration) return;

  tile.currentAction = actionType;
  tile.actionEndsAt = now + duration;

  broadcastMessage({
    type: 'tileActionStart',
    playerId: player.id,
    tileIndex,
    actionType,
    actionEndsAt: tile.actionEndsAt
  });
}

// Tick: finish actions and crop growth
function updateActionsAndGrowth() {
  const now = Date.now();
  const finishedActions = [];
  const grownTiles = [];

  gameState.players.forEach(player => {
    player.farm.forEach((tile, idx) => {
      // Finish actions
      if (tile.currentAction && tile.actionEndsAt && now >= tile.actionEndsAt) {
        const action = tile.currentAction;
        tile.currentAction = null;
        tile.actionEndsAt = null;

        if (action === 'plant') {
          tile.state = 'seeded';
          tile.cropType = 'wheat';
          tile.plantedAt = now;
          tile.wateredAt = null;
        } else if (action === 'water') {
          tile.state = 'growing';
          tile.wateredAt = now;
        } else if (action === 'harvest') {
          player.food += 1;
          tile.state = 'empty';
          tile.cropType = null;
          tile.plantedAt = null;
          tile.wateredAt = null;
        }

        finishedActions.push({
          playerId: player.id,
          tileIndex: idx,
          tile,
          action
        });
      }

      // Growth: growing → ready
      if (tile.state === 'growing' && tile.wateredAt) {
        if (now - tile.wateredAt >= CROP_GROW_MS) {
          tile.state = 'ready';
          grownTiles.push({ playerId: player.id, tileIndex: idx, tile });
        }
      }
    });
  });

  finishedActions.forEach(f => {
    broadcastMessage({
      type: 'tileActionEnd',
      playerId: f.playerId,
      tileIndex: f.tileIndex,
      tile: f.tile,
      action: f.action,
      food: f.action === 'harvest' ? gameState.players.get(f.playerId).food : undefined
    });
  });

  grownTiles.forEach(g => {
    broadcastMessage({
      type: 'tileUpdate',
      playerId: g.playerId,
      tileIndex: g.tileIndex,
      tile: g.tile
    });
  });
}

// WebSocket connections
wss.on('connection', (ws) => {
  const playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  if (gameState.players.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Server is full (50/50 players)'
    }));
    ws.close();
    return;
  }

  const farmIndex = gameState.players.size;
  const player = new Player(playerId, ws, farmIndex);
  gameState.players.set(playerId, player);

  console.log(`Player ${playerId} joined. Total: ${gameState.players.size}`);

  ws.send(JSON.stringify({
    type: 'joinResponse',
    playerId,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT
  }));

  broadcastMessage({
    type: 'playerCount',
    count: gameState.players.size
  });

  ws.send(JSON.stringify({
    type: 'gameStateUpdate',
    players: Array.from(gameState.players.values()).map(p => p.toJSON())
  }));

  selectHost();

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (e) {
      console.error('Bad JSON', e);
      return;
    }

    const p = gameState.players.get(playerId);
    if (!p) return;

    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'getPing':
        p.ping = msg.ping || 0;
        selectHost();
        break;

      case 'playerMove':
        p.x = Math.max(0, Math.min(msg.x, MAP_WIDTH - p.width));
        p.y = Math.max(0, Math.min(msg.y, MAP_HEIGHT - p.height));
        broadcastMessage({
          type: 'playerMoved',
          playerId,
          x: p.x,
          y: p.y
        });
        break;

      case 'plant':
        startActionOnTile(p, msg.tileIndex, 'plant');
        break;

      case 'water':
        startActionOnTile(p, msg.tileIndex, 'water');
        break;

      case 'harvest':
        startActionOnTile(p, msg.tileIndex, 'harvest');
        break;
    }
  });

  ws.on('close', () => {
    console.log(`Player ${playerId} disconnected`);
    gameState.players.delete(playerId);

    broadcastMessage({
      type: 'playerDisconnected',
      playerId
    });

    broadcastMessage({
      type: 'playerCount',
      count: gameState.players.size
    });

    selectHost();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error', err);
  });
});

// Periodic tick
setInterval(() => {
  updateActionsAndGrowth();
  broadcastGameState();
}, 200);

// Health endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', players: gameState.players.size });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
