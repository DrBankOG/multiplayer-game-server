const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Game configuration
const MAX_PLAYERS = 50;
const MAP_WIDTH = 4000;
const MAP_HEIGHT = 4000;

// Farm configuration
const FARM_WIDTH = 8;          // tiles per player (x)
const FARM_HEIGHT = 8;         // tiles per player (y)
const TILE_SIZE = 50;          // world units (used by client)
const CROP_GROW_MS = 2 * 60 * 1000; // 2 minutes from water to ready

// Game state
let gameState = {
  players: new Map(), // id -> Player
  host: null
};

class Player {
  constructor(id, ws, farmIndex) {
    this.id = id;
    this.ws = ws;

    // Farm allocation (grid of farms on big map)
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

    // Farm tiles (1D array)
    this.farmWidth = FARM_WIDTH;
    this.farmHeight = FARM_HEIGHT;
    this.farm = Array.from({ length: FARM_WIDTH * FARM_HEIGHT }, () => ({
      state: 'empty',        // 'empty' | 'seeded' | 'growing' | 'ready'
      cropType: null,        // e.g. 'wheat'
      plantedAt: null,
      wateredAt: null
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

// Helper: broadcast to everyone
function broadcastMessage(message) {
  const data = JSON.stringify(message);
  gameState.players.forEach(player => {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(data);
    }
  });
}

// Helper: broadcast full game state
function broadcastGameState() {
  const message = {
    type: 'gameStateUpdate',
    players: Array.from(gameState.players.values()).map(p => p.toJSON())
  };
  broadcastMessage(message);
}

// Helper: collision
function checkCollision(rect1, rect2) {
  return (
    rect1.x < rect2.x + rect2.width &&
    rect1.x + rect1.width > rect2.x &&
    rect1.y < rect2.y + rect2.height &&
    rect1.y + rect1.height > rect2.y
  );
}

// Host selection (lowest ping)
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

// Crop helpers
function getTile(player, tileIndex) {
  if (!player || !player.farm) return null;
  if (tileIndex == null || tileIndex < 0 || tileIndex >= player.farm.length) return null;
  return player.farm[tileIndex];
}

function handlePlant(player, tileIndex, cropType) {
  const tile = getTile(player, tileIndex);
  if (!tile) return;
  if (tile.state !== 'empty') return;

  tile.state = 'seeded';
  tile.cropType = cropType || 'wheat';
  tile.plantedAt = Date.now();
  tile.wateredAt = null;

  broadcastMessage({
    type: 'tileUpdate',
    playerId: player.id,
    tileIndex,
    tile
  });
}

function handleWater(player, tileIndex) {
  const tile = getTile(player, tileIndex);
  if (!tile) return;
  if (tile.state !== 'seeded') return;

  tile.state = 'growing';
  tile.wateredAt = Date.now();

  broadcastMessage({
    type: 'tileUpdate',
    playerId: player.id,
    tileIndex,
    tile
  });
}

function handleHarvest(player, tileIndex) {
  const tile = getTile(player, tileIndex);
  if (!tile) return;
  if (tile.state !== 'ready') return;

  // Reward: treat all crops as "food" for now
  player.food += 1;

  const newTile = {
    state: 'empty',
    cropType: null,
    plantedAt: null,
    wateredAt: null
  };
  player.farm[tileIndex] = newTile;

  broadcastMessage({
    type: 'tileUpdate',
    playerId: player.id,
    tileIndex,
    tile: newTile,
    harvested: true,
    food: player.food
  });
}

// Growth tick: growing -> ready after CROP_GROW_MS
function updateCropGrowth() {
  const now = Date.now();
  const changed = [];

  gameState.players.forEach(player => {
    player.farm.forEach((tile, idx) => {
      if (tile.state === 'growing' && tile.wateredAt) {
        if (now - tile.wateredAt >= CROP_GROW_MS) {
          tile.state = 'ready';
          changed.push({ playerId: player.id, tileIndex: idx, tile });
        }
      }
    });
  });

  changed.forEach(c => {
    broadcastMessage({
      type: 'tileUpdate',
      playerId: c.playerId,
      tileIndex: c.tileIndex,
      tile: c.tile
    });
  });
}

// WebSocket connection handler
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

  // Join response
  ws.send(JSON.stringify({
    type: 'joinResponse',
    playerId,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT
  }));

  // Let everyone know player count
  broadcastMessage({
    type: 'playerCount',
    count: gameState.players.size
  });

  // Send initial state to new player
  ws.send(JSON.stringify({
    type: 'gameStateUpdate',
    players: Array.from(gameState.players.values()).map(p => p.toJSON())
  }));

  selectHost();

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch (e) {
      console.error('Bad message JSON', e);
      return;
    }

    const p = gameState.players.get(playerId);
    if (!p) return;

    switch (message.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'getPing':
        p.ping = message.ping || 0;
        selectHost();
        break;

      case 'playerMove':
        p.x = Math.max(0, Math.min(message.x, MAP_WIDTH - p.width));
        p.y = Math.max(0, Math.min(message.y, MAP_HEIGHT - p.height));
        broadcastMessage({
          type: 'playerMoved',
          playerId,
          x: p.x,
          y: p.y
        });
        break;

      case 'plant':
        handlePlant(p, message.tileIndex, message.cropType);
        break;

      case 'water':
        handleWater(p, message.tileIndex);
        break;

      case 'harvest':
        handleHarvest(p, message.tileIndex);
        break;
    }
  });

  ws.on('close', () => {
    console.log(`Player ${playerId} disconnected.`);
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

// Periodic updates
setInterval(() => {
  updateCropGrowth();
  broadcastGameState();
}, 2000);

// Health endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', players: gameState.players.size });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
