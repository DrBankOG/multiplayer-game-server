const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Game configuration
const MAX_PLAYERS = 50;
const MAP_WIDTH = 2000;
const MAP_HEIGHT = 2000;
const RESOURCE_COUNT = 30;
const RESOURCE_SPAWN_INTERVAL = 5000;

// Game state
let gameState = {
  players: new Map(),
  resources: [],
  host: null,
  lastResourceSpawn: Date.now()
};

// Player class
class Player {
  constructor(id, ws) {
    this.id = id;
    this.ws = ws;
    this.x = Math.random() * (MAP_WIDTH - 50) + 25;
    this.y = Math.random() * (MAP_HEIGHT - 50) + 25;
    this.width = 25;
    this.height = 25;
    this.wood = 0;
    this.food = 0;
    this.ping = 0;
    this.joinTime = Date.now();
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
      ping: this.ping
    };
  }
}

// Resource class
class Resource {
  constructor(id) {
    this.id = id;
    this.x = Math.random() * (MAP_WIDTH - 40) + 20;
    this.y = Math.random() * (MAP_HEIGHT - 40) + 20;
    this.width = 20;
    this.height = 20;
    this.type = Math.random() > 0.5 ? 'wood' : 'food';
  }

  toJSON() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      type: this.type
    };
  }
}

// Initialize resources
function initializeResources() {
  gameState.resources = [];
  for (let i = 0; i < RESOURCE_COUNT; i++) {
    gameState.resources.push(new Resource(`resource_${i}`));
  }
}

// Select host (lowest ping player)
function selectHost() {
  if (gameState.players.size === 0) {
    gameState.host = null;
    return;
  }

  let newHost = null;
  let lowestPing = Infinity;

  gameState.players.forEach(player => {
    if (player.ping < lowestPing) {
      lowestPing = player.ping;
      newHost = player;
    }
  });

  if (gameState.host !== newHost) {
    gameState.host = newHost;
    broadcastMessage({
      type: 'hostChange',
      hostId: newHost ? newHost.id : null
    });
  }
}

// Broadcast message to all connected clients
function broadcastMessage(message) {
  const data = JSON.stringify(message);
  gameState.players.forEach(player => {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(data);
    }
  });
}

// Send game state to all players
function broadcastGameState() {
  const message = {
    type: 'gameStateUpdate',
    players: Array.from(gameState.players.values()).map(p => p.toJSON()),
    resources: gameState.resources.map(r => r.toJSON()),
    playerCount: gameState.players.size
  };
  broadcastMessage(message);
}

// Collision detection
function checkCollision(rect1, rect2) {
  return rect1.x < rect2.x + rect2.width &&
         rect1.x + rect1.width > rect2.x &&
         rect1.y < rect2.y + rect2.height &&
         rect1.y + rect1.height > rect2.y;
}

// Spawn new resources if needed
function spawnResources() {
  const now = Date.now();
  if (now - gameState.lastResourceSpawn > RESOURCE_SPAWN_INTERVAL) {
    if (gameState.resources.length < RESOURCE_COUNT) {
      const newResource = new Resource(`resource_${Date.now()}_${Math.random()}`);
      gameState.resources.push(newResource);
      gameState.lastResourceSpawn = now;
    }
  }
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  const playerId = `player_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Check if server is full
  if (gameState.players.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Server is full (50/50 players)'
    }));
    ws.close();
    return;
  }

  const player = new Player(playerId, ws);
  gameState.players.set(playerId, player);

  console.log(`Player ${playerId} joined. Total players: ${gameState.players.size}`);

  // Send join response
  ws.send(JSON.stringify({
    type: 'joinResponse',
    playerId: playerId,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT
  }));

  // Send initial game state
  ws.send(JSON.stringify({
    type: 'gameStateUpdate',
    players: Array.from(gameState.players.values()).map(p => p.toJSON()),
    resources: gameState.resources.map(r => r.toJSON())
  }));

  // Notify all clients of player count
  broadcastMessage({
    type: 'playerCount',
    count: gameState.players.size
  });

  // Re-select host
  selectHost();

  // Handle messages from client
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong' }));
          break;

        case 'playerMove':
          if (gameState.players.has(playerId)) {
            const p = gameState.players.get(playerId);
            p.x = Math.max(0, Math.min(message.x, MAP_WIDTH - p.width));
            p.y = Math.max(0, Math.min(message.y, MAP_HEIGHT - p.height));

            // Broadcast position update
            broadcastMessage({
              type: 'playerMoved',
              playerId: playerId,
              x: p.x,
              y: p.y
            });
          }
          break;

        case 'collectResource':
          if (gameState.players.has(playerId)) {
            const p = gameState.players.get(playerId);
            const resourceIndex = gameState.resources.findIndex(r => r.id === message.resourceId);

            if (resourceIndex !== -1) {
              const resource = gameState.resources[resourceIndex];

              // Check collision
              if (checkCollision(p, resource)) {
                if (resource.type === 'wood') {
                  p.wood++;
                } else {
                  p.food++;
                }

                // Remove resource
                gameState.resources.splice(resourceIndex, 1);

                // Broadcast collection
                broadcastMessage({
                  type: 'resourceCollected',
                  playerId: playerId,
                  resourceId: message.resourceId,
                  resourceType: resource.type
                });

                // Spawn new resource
                spawnResources();
              }
            }
          }
          break;

        case 'getPing':
          if (gameState.players.has(playerId)) {
            const p = gameState.players.get(playerId);
            p.ping = message.ping || 0;
            selectHost();
          }
          break;
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
    gameState.players.delete(playerId);
    console.log(`Player ${playerId} disconnected. Total players: ${gameState.players.size}`);

    broadcastMessage({
      type: 'playerCount',
      count: gameState.players.size
    });

    broadcastMessage({
      type: 'playerDisconnected',
      playerId: playerId
    });

    selectHost();
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Periodically broadcast game state
setInterval(() => {
  spawnResources();
  broadcastGameState();
}, 1000);

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', players: gameState.players.size });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initializeResources();
});
