const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Initialize Express and HTTP server
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

// Environment variables
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://durak_game_db_user:sYBK7oZf8Iwe8ueNDboivwEk9KbJAERh@dpg-d0bs2tuuk2gs7383n0o0-a/durak_game_db';

// Initialize PostgreSQL client
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Test database connection
async function checkDatabaseConnection() {
    try {
        const client = await pool.connect();
        console.log('Connected to PostgreSQL database');
        client.release();
    } catch (err) {
        console.error('Error connecting to database:', err.message);
        process.exit(1);
    }
}
checkDatabaseConnection();

// Create database schema
async function initDatabase() {
    try {
        await pool.query('DROP TABLE IF EXISTS players');
        await pool.query('DROP TABLE IF EXISTS rooms');
        console.log('Old tables dropped');

        await pool.query(`
            CREATE TABLE rooms (
                roomId TEXT PRIMARY KEY,
                trump TEXT,
                deck TEXT,
                gameTable TEXT,
                currentAttacker TEXT,
                currentDefender TEXT,
                createdAt BIGINT,
                lastActivity BIGINT,
                activePlayers INTEGER DEFAULT 0,
                gameEnded INTEGER DEFAULT 0
            )
        `);
        console.log('Rooms table created');

        await pool.query(`
            CREATE TABLE players (
                id TEXT PRIMARY KEY,
                roomId TEXT,
                playerId TEXT UNIQUE,
                name TEXT,
                ready INTEGER DEFAULT 0,
                hand TEXT,
                joinedAt BIGINT,
                isDisconnected INTEGER DEFAULT 0,
                lastDisconnectedAt BIGINT,
                language TEXT DEFAULT 'en',
                socketIds TEXT DEFAULT '[]',
                CONSTRAINT fk_room FOREIGN KEY (roomId) REFERENCES rooms (roomId) ON DELETE CASCADE
            )
        `);
        console.log('Players table created');

        await pool.query('DELETE FROM rooms');
        await pool.query('DELETE FROM players');
        console.log('Tables cleared');
    } catch (err) {
        console.error('Error initializing database:', err.message);
        process.exit(1);
    }
}
initDatabase();

// Sanitize input data
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 50);
}

// Sanitize language input
function sanitizeLanguage(lang) {
    const validLanguages = ['en', 'ru', 'uk'];
    return validLanguages.includes(lang) ? lang : 'en';
}

// Generate 4-digit room code
async function generateRoomCode() {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    try {
        const result = await pool.query('SELECT roomId FROM rooms WHERE roomId = $1', [code]);
        if (result.rows.length > 0) {
            return generateRoomCode();
        }
        return code;
    } catch (err) {
        console.error('Error checking room code:', err.message);
        return null;
    }
}

// Manage socket IDs for a player
async function addSocketId(playerId, socketId) {
    try {
        const result = await pool.query('SELECT socketIds FROM players WHERE playerId = $1', [playerId]);
        let socketIds = result.rows[0]?.socketIds ? JSON.parse(result.rows[0].socketIds) : [];
        socketIds.forEach(id => {
            if (id !== socketId && io.sockets.sockets.get(id)) {
                console.log(`Disconnecting old socket ${id} for playerId ${playerId}`);
                io.to(id).emit('errorMessage', 'Another session has taken over this player');
                io.sockets.sockets.get(id)?.disconnect(true);
            }
        });
        socketIds = socketIds.filter(id => id === socketId || io.sockets.sockets.get(id));
        if (!socketIds.includes(socketId)) {
            socketIds.push(socketId);
        }
        await pool.query('UPDATE players SET socketIds = $1 WHERE playerId = $2', [JSON.stringify(socketIds), playerId]);
    } catch (err) {
        console.error('Error updating socketIds:', err.message);
        throw err;
    }
}

async function removeSocketId(playerId, socketId) {
    try {
        const result = await pool.query('SELECT socketIds FROM players WHERE playerId = $1', [playerId]);
        let socketIds = result.rows[0]?.socketIds ? JSON.parse(result.rows[0].socketIds) : [];
        socketIds = socketIds.filter(id => id !== socketId);
        await pool.query('UPDATE players SET socketIds = $1 WHERE playerId = $2', [JSON.stringify(socketIds), playerId]);
    } catch (err) {
        console.error('Error updating socketIds:', err.message);
        throw err;
    }
}

// Clean duplicate players
async function cleanDuplicatePlayers(roomId, playerName, socketId, playerId) {
    try {
        const result = await pool.query(
            'SELECT playerId, id, socketIds FROM players WHERE roomId = $1 AND name = $2 AND playerId != $3',
            [roomId, playerName, playerId]
        );
        console.log(`Cleaning duplicates for ${playerName} in room ${roomId}, socket=${socketId}, playerId=${playerId}, found ${result.rows.length} duplicates`);
        for (const row of result.rows) {
            await pool.query('DELETE FROM players WHERE roomId = $1 AND playerId = $2', [roomId, row.playerId]);
            console.log(`Removed duplicate player ${playerName} with playerId ${row.playerId} from room ${roomId}`);
        }
    } catch (err) {
        console.error('Error fetching duplicate players:', err.message);
        throw err;
    }
}

// Restrict player join
async function restrictPlayerJoin(roomId, playerName, playerId, socketId) {
    try {
        const result = await pool.query(
            'SELECT playerId, isDisconnected, socketIds FROM players WHERE roomId = $1 AND name = $2 AND playerId != $3',
            [roomId, playerName, playerId]
        );
        const row = result.rows[0];
        if (row && !row.isDisconnected) {
            const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
            if (socketIds.some(id => io.sockets.sockets.get(id))) {
                console.log(`Player ${playerName} already active in room ${roomId} with different playerId ${row.playerId}, blocking join`);
                return false;
            }
        }
        return true;
    } catch (err) {
        console.error('Error checking player join:', err.message);
        return false;
    }
}

// Handle single player game
async function handleSinglePlayerGame(roomId) {
    try {
        const roomResult = await pool.query('SELECT trump FROM rooms WHERE roomId = $1', [roomId]);
        const room = roomResult.rows[0];
        if (!room || !room.trump) return;
        const playersResult = await pool.query(
            'SELECT DISTINCT playerId, name FROM players WHERE roomId = $1 AND isDisconnected = 0',
            [roomId]
        );
        const players = playersResult.rows;
        if (players.length === 1) {
            const winner = players[0];
            console.log(`Declaring ${winner.name} as winner in room ${roomId} due to single unique player`);
            await pool.query('UPDATE rooms SET gameEnded = 1 WHERE roomId = $1', [roomId]);
            io.to(roomId).emit('gameOver', { winners: [winner.name] });
            await deleteRoom(roomId);
        }
    } catch (err) {
        console.error('Error handling single player game:', err.message);
    }
}

// Serve static files
app.use(express.static(__dirname, {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css');
        }
        if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));

app.get('/style.css', (req, res) => {
    res.setHeader('Content-Type', 'text/css');
    res.sendFile(path.join(__dirname, 'style.css'), (err) => {
        if (err) {
            console.error('Error serving style.css:', err.message);
            res.status(404).send('CSS file not found');
        }
    });
});

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/room', (req, res) => {
    res.sendFile(path.join(__dirname, 'room.html'));
});

app.get('/game', (req, res) => {
    res.sendFile(path.join(__dirname, 'game.html'));
});

// Endpoint to fetch room state
app.get('/room/:roomId', async (req, res) => {
    const roomId = sanitizeInput(req.params.roomId);
    console.log(`HTTP request for room state: room=${roomId}`);
    try {
        const playersResult = await pool.query(
            'SELECT name, ready, hand, language, playerId FROM players WHERE roomId = $1',
            [roomId]
        );
        const players = playersResult.rows;
        const roomResult = await pool.query(
            'SELECT roomId, trump, deck, gameTable, currentAttacker, currentDefender FROM rooms WHERE roomId = $1',
            [roomId]
        );
        const row = roomResult.rows[0];
        if (!row) {
            console.log(`Room ${roomId} not found for HTTP request`);
            res.status(404).json({ error: 'Room not found' });
            return;
        }
        const playerNames = players.map(player => player.name);
        const readyCount = players.filter(player => player.ready).length;
        const totalCount = players.length;
        console.log(`HTTP response for room ${roomId}: players=${playerNames.join(',') || 'none'}, ready=${readyCount}/${totalCount}`);
        res.json({
            players: players.map(player => ({
                name: player.name,
                ready: !!player.ready,
                hand: player.hand ? JSON.parse(player.hand) : [],
                language: player.language,
                playerId: player.playerId
            })),
            readyCount: readyCount,
            totalCount: totalCount,
            trump: row.trump,
            deckCount: row.deck ? JSON.parse(row.deck).length : 0,
            table: row.gameTable ? JSON.parse(row.gameTable) : [],
            currentAttacker: row.currentAttacker,
            currentDefender: row.currentDefender
        });
    } catch (err) {
        console.error('Error fetching room state:', err.message);
        res.status(500).json({ error: 'Server error fetching players' });
    }
});

// Create game deck
function createDeck() {
    const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
    const ranks = ['6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
    const deck = [];
    for (let suit of suits) {
        for (let rank of ranks) {
            deck.push({ rank, suit });
        }
    }
    console.log('Deck created:', deck.length, 'cards');
    return deck;
}

// Shuffle deck
function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    console.log('Deck shuffled');
}

// Find lowest trump card for first attacker
function findLowestTrumpCard(players, trump) {
    const rankOrder = ['6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
    let lowestTrumpCard = null;
    let firstAttacker = null;

    players.forEach(player => {
        const hand = player.hand ? JSON.parse(player.hand) : [];
        const trumpCards = hand.filter(card => card.suit === trump);
        if (trumpCards.length > 0) {
            const lowestCard = trumpCards.reduce((min, card) => {
                const minRankIndex = rankOrder.indexOf(min.rank);
                const cardRankIndex = rankOrder.indexOf(card.rank);
                return cardRankIndex < minRankIndex ? card : min;
            }, trumpCards[0]);
            if (!lowestTrumpCard || rankOrder.indexOf(lowestCard.rank) < rankOrder.indexOf(lowestTrumpCard.rank)) {
                lowestTrumpCard = lowestCard;
                firstAttacker = player.playerId;
            }
        }
    });

    return { lowestTrumpCard, firstAttacker };
}

// Start turn timer
function startTurnTimer(roomId) {
    clearTurnTimer(roomId);
    const timer = setTimeout(async () => {
        try {
            const roomResult = await pool.query(
                'SELECT currentDefender, gameEnded FROM rooms WHERE roomId = $1',
                [roomId]
            );
            const row = roomResult.rows[0];
            if (!row) {
                console.error(`Room ${roomId} not found for timer`);
                return;
            }
            if (row.gameEnded) {
                console.log(`Room ${roomId} has ended, skipping timer action`);
                return;
            }
            const playersResult = await pool.query(
                'SELECT DISTINCT playerId FROM players WHERE roomId = $1 AND isDisconnected = 0',
                [roomId]
            );
            const players = playersResult.rows;
            if (players.length < 2) {
                await handleSinglePlayerGame(roomId);
                return;
            }
            const playerIds = players.map(p => p.playerId);
            const currentIndex = playerIds.indexOf(row.currentDefender);
            const nextAttackerIndex = (currentIndex + 1) % playerIds.length;
            const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
            const newAttacker = playerIds[nextAttackerIndex];
            const newDefender = playerIds[nextDefenderIndex] || playerIds[0];
            await pool.query(
                'UPDATE rooms SET gameTable = $1, currentAttacker = $2, currentDefender = $3, lastActivity = $4 WHERE roomId = $5',
                [JSON.stringify([]), newAttacker, newDefender, Date.now(), roomId]
            );
            console.log(`Turn timed out in room ${roomId}, new attacker: ${newAttacker}, new defender: ${newDefender}`);
            io.to(roomId).emit('errorMessage', 'Turn timed out');
            await updateGameState(roomId);
        } catch (err) {
            console.error('Error updating turn on timeout:', err.message);
        }
    }, 30000);
    io.to(roomId).emit('startTimer', { duration: 30000 });
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room) {
        room.timer = timer;
        console.log(`Timer set for room ${roomId}`);
    } else {
        console.warn(`Room ${roomId} not found in adapter.rooms, timer not set`);
    }
}

// Clear turn timer
function clearTurnTimer(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.timer) {
        clearTimeout(room.timer);
        delete room.timer;
        console.log(`Timer cleared for room ${roomId}`);
    }
}

// Update room state (for room.html)
async function updateRoomState(roomId) {
    try {
        const playersResult = await pool.query(
            'SELECT name, ready, isDisconnected, language, playerId, id, socketIds FROM players WHERE roomId = $1',
            [roomId]
        );
        const players = playersResult.rows;
        const readyCount = players.filter(player => player.ready).length;
        const totalCount = players.length;
        const activeCount = players.filter(p => !p.isDisconnected).length;
        await pool.query('UPDATE rooms SET activePlayers = $1 WHERE roomId = $2', [activeCount, roomId]);
        console.log(`Updating room ${roomId}: players=${players.map(p => p.name).join(',') || 'none'}, ready=${readyCount}/${totalCount}, active=${activeCount}`);
        io.to(roomId).emit('updateRoom', {
            players: players.map(player => ({
                name: player.name,
                ready: !!player.ready,
                playerId: player.playerId
            })),
            readyCount,
            totalCount,
            playerLanguages: players.map(player => ({ name: player.name, language: player.language }))
        });
        players.forEach(player => {
            const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
            socketIds.forEach(socketId => {
                io.to(socketId).emit('playerStatus', {
                    playerId: player.playerId,
                    ready: !!player.ready,
                    isDisconnected: !!player.isDisconnected
                });
            });
        });
    } catch (err) {
        console.error('Error fetching players:', err.message);
        io.to(roomId).emit('errorMessage', 'Server error fetching players.');
    }
}

// Update game state (for game.html)
async function updateGameState(roomId) {
    try {
        const roomResult = await pool.query(
            'SELECT trump, deck, gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = $1',
            [roomId]
        );
        const row = roomResult.rows[0];
        if (!row) {
            console.log(`Room ${roomId} not found for game state`);
            io.to(roomId).emit('errorMessage', 'Game room does not exist.');
            return;
        }
        if (row.gameEnded) {
            console.log(`Room ${roomId} has ended, skipping game state update`);
            return;
        }
        const playersResult = await pool.query(
            'SELECT id, name, hand, playerId, isDisconnected, language, socketIds FROM players WHERE roomId = $1',
            [roomId]
        );
        const players = playersResult.rows;
        const activePlayers = players.filter(p => !p.isDisconnected);
        await pool.query('UPDATE rooms SET activePlayers = $1 WHERE roomId = $2', [activePlayers.length, roomId]);
        if (activePlayers.length < 2 && row.trump) {
            await handleSinglePlayerGame(roomId);
            return;
        }
        const gameState = {
            players: players.map(player => ({
                id: player.playerId,
                name: player.name,
                hand: player.hand ? JSON.parse(player.hand) : [],
                isDisconnected: !!player.isDisconnected,
                language: player.language
            })),
            trump: row.trump ? JSON.parse(row.trump) : null,
            deckCount: row.deck ? JSON.parse(row.deck).length : 0,
            table: row.gameTable ? JSON.parse(row.gameTable) : [],
            currentAttacker: row.currentAttacker,
            currentDefender: row.currentDefender
        };
        console.log(`Updating game ${roomId}: players=${players.map(p => p.name).join(',') || 'none'}, trump=${JSON.stringify(gameState.trump)}, deck=${gameState.deckCount}, table=${JSON.stringify(gameState.table)}, attacker=${row.currentAttacker}, defender=${row.currentDefender}`);
        players.forEach(player => {
            const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
            socketIds.forEach(socketId => {
                io.to(socketId).emit('updateGame', gameState);
            });
        });
        await checkGameEnd(roomId);
        await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
    } catch (err) {
        console.error('Error fetching game state:', err.message);
        io.to(roomId).emit('errorMessage', 'Server error fetching game state.');
    }
}

// Start game
async function startGame(roomId) {
    console.log(`Attempting to start game in room ${roomId}`);
    try {
        const roomResult = await pool.query('SELECT trump FROM rooms WHERE roomId = $1', [roomId]);
        const row = roomResult.rows[0];
        if (row && row.trump) {
            console.log(`Game already started in room ${roomId}, updating state`);
            await updateGameState(roomId);
            return;
        }
        const playersResult = await pool.query(
            'SELECT id, playerId, name, ready, isDisconnected, socketIds, hand FROM players WHERE roomId = $1',
            [roomId]
        );
        const players = playersResult.rows;
        const activePlayers = players.filter(player => !player.isDisconnected);
        if (activePlayers.length < 2) {
            console.log(`Not enough active players to start game in room ${roomId}: ${activePlayers.length}`);
            io.to(roomId).emit('errorMessage', 'Minimum 2 players required to start game.');
            return;
        }
        const readyCount = activePlayers.filter(player => player.ready).length;
        if (readyCount !== activePlayers.length) {
            console.log(`Not all active players ready in room ${roomId}: ${readyCount}/${activePlayers.length}`);
            io.to(roomId).emit('errorMessage', 'All active players must be ready to start game.');
            return;
        }

        const deck = createDeck();
        shuffleDeck(deck);

        const trumpCard = deck[Math.floor(Math.random() * deck.length)];
        const trump = { card: trumpCard, suit: trumpCard.suit };
        deck.splice(deck.indexOf(trumpCard), 1);
        deck.push(trumpCard);

        for (const player of activePlayers) {
            const hand = deck.splice(0, 6);
            await pool.query(
                'UPDATE players SET hand = $1 WHERE playerId = $2',
                [JSON.stringify(hand), player.playerId]
            );
            console.log(`Hand assigned to player ${player.name} in room ${roomId}`);
        }

        const { lowestTrumpCard, firstAttacker } = findLowestTrumpCard(activePlayers, trump.suit);
        let currentAttacker, currentDefender;

        if (firstAttacker) {
            console.log(`First attacker in room ${roomId}: playerId=${firstAttacker}, lowest trump card=${lowestTrumpCard.rank} of ${lowestTrumpCard.suit}`);
            currentAttacker = firstAttacker;
            const activePlayerIds = activePlayers.map(p => p.playerId);
            const attackerIndex = activePlayerIds.indexOf(firstAttacker);
            const defenderIndex = (attackerIndex + 1) % activePlayerIds.length;
            currentDefender = activePlayerIds[defenderIndex];
        } else {
            console.log(`No trump cards found in room ${roomId}, selecting random attacker`);
            const activePlayerIds = activePlayers.map(p => p.playerId);
            currentAttacker = activePlayerIds[0];
            currentDefender = activePlayerIds[1];
        }

        await pool.query(
            'UPDATE rooms SET trump = $1, deck = $2, gameTable = $3, currentAttacker = $4, currentDefender = $5, lastActivity = $6, activePlayers = $7, gameEnded = 0 WHERE roomId = $8',
            [JSON.stringify(trump), JSON.stringify(deck), JSON.stringify([]), currentAttacker, currentDefender, Date.now(), activePlayers.length, roomId]
        );
        console.log(`Game started in room ${roomId}, trump: ${JSON.stringify(trump)}, attacker: ${currentAttacker}, defender: ${currentDefender}, deck: ${deck.length}`);
        io.to(roomId).emit('startGame', { trump, currentAttacker, currentDefender });
        await updateGameState(roomId);
        const room = io.sockets.adapter.rooms.get(roomId);
        console.log(`Room ${roomId} sockets before timer: ${room ? Array.from(room).join(',') : 'none'}`);
        if (!room) {
            console.warn(`Room ${roomId} not found in adapter.rooms, joining active players`);
            for (const player of activePlayers) {
                const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
                for (const socketId of socketIds) {
                    io.sockets.sockets.get(socketId)?.join(roomId);
                    console.log(`Socket ${socketId} joined room ${roomId}`);
                }
            }
        }
        startTurnTimer(roomId);
    } catch (err) {
        console.error('Error starting game:', err.message);
        io.to(roomId).emit('errorMessage', 'Server error setting game state.');
    }
}

// Validate card play
function isValidAttackCard(card, table, trump) {
    if (!table.length) return true;
    return table.some(pair => pair.attack.rank === card.rank);
}

function isValidDefenseCard(defenseCard, attackCard, trump) {
    const rankOrder = ['6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
    if (defenseCard.suit === attackCard.suit) {
        return rankOrder.indexOf(defenseCard.rank) > rankOrder.indexOf(attackCard.rank);
    }
    return defenseCard.suit === trump;
}

// Draw cards
async function drawCards(roomId, playerIds, callback) {
    try {
        const roomResult = await pool.query('SELECT deck, gameEnded FROM rooms WHERE roomId = $1', [roomId]);
        const row = roomResult.rows[0];
        if (!row) {
            console.log(`Room ${roomId} does not exist for drawCards`);
            return;
        }
        if (row.gameEnded) {
            console.log(`Room ${roomId} has ended, skipping drawCards`);
            return;
        }
        let deck = row.deck ? JSON.parse(row.deck) : [];
        let updates = [];
        for (const playerId of playerIds) {
            const playerResult = await pool.query(
                'SELECT hand, isDisconnected FROM players WHERE playerId = $1',
                [playerId]
            );
            const player = playerResult.rows[0];
            if (player.isDisconnected) continue;
            let hand = player.hand ? JSON.parse(player.hand) : [];
            while (hand.length < 6 && deck.length > 0) {
                hand.push(deck.shift());
            }
            updates.push({ id: playerId, hand });
        }
        for (const update of updates) {
            await pool.query('UPDATE players SET hand = $1 WHERE playerId = $2', [JSON.stringify(update.hand), update.id]);
        }
        await pool.query('UPDATE rooms SET deck = $1, lastActivity = $2 WHERE roomId = $3', [JSON.stringify(deck), Date.now(), roomId]);
        callback();
    } catch (err) {
        console.error('Error drawing cards:', err.message);
    }
}

// Check game end
async function checkGameEnd(roomId) {
    try {
        const roomResult = await pool.query('SELECT deck, gameEnded FROM rooms WHERE roomId = $1', [roomId]);
        const row = roomResult.rows[0];
        if (!row) {
            console.log(`Room ${roomId} not found for game end check`);
            return;
        }
        if (row.gameEnded) {
            console.log(`Room ${roomId} already ended, skipping game end check`);
            return;
        }
        const deck = row.deck ? JSON.parse(row.deck) : [];
        const playersResult = await pool.query(
            'SELECT playerId, name, hand, isDisconnected FROM players WHERE roomId = $1',
            [roomId]
        );
        const players = playersResult.rows;
        const activePlayers = players.filter(p => !p.isDisconnected);
        if (activePlayers.length < 2) {
            await handleSinglePlayerGame(roomId);
            return;
        }
        const winners = activePlayers.filter(p => JSON.parse(p.hand || '[]').length === 0);
        if (deck.length === 0 && winners.length > 0) {
            const winnerNames = winners.map(p => p.name).join(', ');
            console.log(`Game over in room ${roomId}: Winners: ${winnerNames}`);
            await pool.query('UPDATE rooms SET gameEnded = 1 WHERE roomId = $1', [roomId]);
            io.to(roomId).emit('gameOver', { winners: winners.map(p => p.name) });
            await deleteRoom(roomId);
        }
    } catch (err) {
        console.error('Error checking game end:', err.message);
    }
}

// Delete room
async function deleteRoom(roomId) {
    clearTurnTimer(roomId);
    try {
        await pool.query('UPDATE rooms SET gameEnded = 1 WHERE roomId = $1', [roomId]);
        await pool.query('DELETE FROM players WHERE roomId = $1', [roomId]);
        await pool.query('DELETE FROM rooms WHERE roomId = $1', [roomId]);
        console.log(`Room ${roomId} deleted after game end`);
        io.to(roomId).emit('roomDeleted', 'Game has ended and room was deleted.');
    } catch (err) {
        console.error('Error deleting room:', err.message);
    }
}

// Socket.io event handlers
io.on('connection', (socket) => {
    console.log(`New user connected: socket=${socket.id}`);

    socket.on('createRoom', async (data) => {
        let playerName, playerId, language;
        if (typeof data === 'string') {
            playerName = data;
            playerId = uuidv4();
            language = 'en';
            console.log(`Received old createRoom format: playerName=${playerName}`);
        } else if (typeof data === 'object' && data.playerName && data.playerName.trim()) {
            playerName = data.playerName;
            playerId = data.playerId || uuidv4();
            language = sanitizeLanguage(data.language || 'en');
        } else {
            console.error('Invalid createRoom data:', data);
            socket.emit('errorMessage', 'Invalid data.');
            return;
        }

        playerName = sanitizeInput(playerName ? playerName.trim() : '');
        playerId = sanitizeInput(playerId);
        console.log(`Request to create room: player=${playerName}, playerId=${playerId}, language=${language}, socket=${socket.id}`);
        if (!playerName || playerName === 'undefined') {
            socket.emit('errorMessage', 'Enter a valid name.');
            socket.emit('setPlayerId', playerId);
            return;
        }
        try {
            const playerResult = await pool.query('SELECT playerId FROM players WHERE playerId = $1', [playerId]);
            if (playerResult.rows.length > 0) {
                playerId = uuidv4();
                socket.emit('setPlayerId', playerId);
                console.log(`Duplicate playerId detected, assigned new playerId: ${playerId}`);
            }
            const roomId = await generateRoomCode();
            if (!roomId) {
                socket.emit('errorMessage', 'Failed to generate room code.');
                return;
            }
            await pool.query(
                'INSERT INTO rooms (roomId, createdAt, lastActivity, gameEnded) VALUES ($1, $2, $3, $4)',
                [roomId, Date.now(), Date.now(), 0]
            );
            await pool.query('DELETE FROM players WHERE id = $1', [socket.id]);
            await cleanDuplicatePlayers(roomId, playerName, socket.id, playerId);
            await pool.query(
                'INSERT INTO players (id, roomId, playerId, name, ready, joinedAt, isDisconnected, language, socketIds) VALUES ($1, $2, $3, $4, 0, $5, 0, $6, $7)',
                [socket.id, roomId, playerId, playerName, Date.now(), language, JSON.stringify([socket.id])]
            );
            console.log(`Room ${roomId} created, player ${playerName} added with playerId ${playerId}, language ${language}, socket=${socket.id}`);
            socket.join(roomId);
            console.log(`Socket ${socket.id} joined room ${roomId}`);
            socket.emit('roomCreated', { roomId, playerId, language, playerName });
            socket.emit('roomJoined', { roomId, playerId, language, playerName });
            socket.emit('playerStatus', { playerId, ready: false, isDisconnected: false });
            await updateRoomState(roomId);
        } catch (err) {
            console.error('Error creating room:', err.message);
            socket.emit('errorMessage', 'Server error.');
        }
    });

    socket.on('joinRoom', async (data) => {
        let roomId, playerName, playerId, language;
        if (typeof data === 'object' && data.roomId && data.playerName && data.playerName.trim()) {
            roomId = data.roomId;
            playerName = data.playerName;
            playerId = data.playerId || uuidv4();
            language = sanitizeLanguage(data.language || 'en');
        } else {
            console.error('Invalid joinRoom data:', data);
            socket.emit('errorMessage', 'Invalid data.');
            return;
        }

        roomId = sanitizeInput(roomId ? roomId.trim().toLowerCase() : '');
        playerName = sanitizeInput(playerName ? playerName.trim() : '');
        playerId = sanitizeInput(playerId);
        console.log(`Request to join room: room=${roomId}, player=${playerName}, playerId=${playerId}, language=${language}, socket=${socket.id}`);
        if (!roomId || !playerName || playerName === 'undefined') {
            socket.emit('errorMessage', 'Invalid room ID or name.');
            socket.emit('setPlayerId', playerId);
            return;
        }
        try {
            const roomResult = await pool.query('SELECT roomId FROM rooms WHERE roomId = $1', [roomId]);
            if (roomResult.rows.length === 0) {
                socket.emit('errorMessage', 'Room does not exist.');
                socket.emit('setPlayerId', playerId);
                return;
            }
            const playerResult = await pool.query(
                'SELECT name, playerId, id, isDisconnected, hand, lastDisconnectedAt, language, ready, socketIds FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const row = playerResult.rows[0];
            if (row) {
                if (row.name !== playerName) {
                    socket.emit('errorMessage', 'Player name mismatch for this ID.');
                    return;
                }
                if (!row.isDisconnected) {
                    await addSocketId(playerId, socket.id);
                    console.log(`Player ${playerName} added socket ${socket.id} to existing playerId ${playerId} in room ${roomId}`);
                    socket.join(roomId);
                    socket.emit('roomJoined', { roomId, playerId, language: row.language, playerName });
                    socket.emit('playerStatus', { playerId, ready: !!row.ready, isDisconnected: false });
                    await updateRoomState(roomId);
                    const gameResult = await pool.query('SELECT trump FROM rooms WHERE roomId = $1', [roomId]);
                    if (gameResult.rows[0]?.trump) {
                        await updateGameState(roomId);
                    }
                    return;
                } else {
                    await pool.query(
                        'UPDATE players SET id = $1, isDisconnected = 0, lastDisconnectedAt = NULL, language = $2, socketIds = $3 WHERE roomId = $4 AND playerId = $5',
                        [socket.id, language, JSON.stringify([socket.id]), roomId, playerId]
                    );
                    console.log(`Player ${playerName} reconnected to room ${roomId}, playerId: ${playerId}, socket: ${socket.id}`);
                    socket.join(roomId);
                    socket.emit('roomJoined', { roomId, playerId, language: row.language, playerName });
                    socket.emit('playerStatus', { playerId, ready: !!row.ready, isDisconnected: false });
                    io.to(roomId).emit('playerReconnected', { playerName });
                    await updateRoomState(roomId);
                    const gameResult = await pool.query('SELECT trump FROM rooms WHERE roomId = $1', [roomId]);
                    if (gameResult.rows[0]?.trump) {
                        await updateGameState(roomId);
                    }
                    return;
                }
            }
            const canJoin = await restrictPlayerJoin(roomId, playerName, playerId, socket.id);
            if (!canJoin) {
                socket.emit('errorMessage', 'Player with this name already active with a different ID.');
                return;
            }
            await cleanDuplicatePlayers(roomId, playerName, socket.id, playerId);
            await pool.query('DELETE FROM players WHERE id = $1', [socket.id]);
            const countResult = await pool.query('SELECT COUNT(*) as count FROM players WHERE roomId = $1', [roomId]);
            if (parseInt(countResult.rows[0].count) >= 2) {
                socket.emit('errorMessage', 'Room is full.');
                socket.emit('setPlayerId', playerId);
                return;
            }
            socket.join(roomId);
            console.log(`Socket ${socket.id} joined room ${roomId}`);
            await pool.query(
                'INSERT INTO players (id, roomId, playerId, name, ready, joinedAt, isDisconnected, language, socketIds) VALUES ($1, $2, $3, $4, 0, $5, 0, $6, $7)',
                [socket.id, roomId, playerId, playerName, Date.now(), language, JSON.stringify([socket.id])]
            );
            console.log(`Player ${playerName} joined room ${roomId} with playerId ${playerId}, language ${language}, socket=${socket.id}`);
            socket.emit('roomJoined', { roomId, playerId, language, playerName });
            socket.emit('playerStatus', { playerId, ready: false, isDisconnected: false });
            await updateRoomState(roomId);
            await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
        } catch (err) {
            console.error('Error joining room:', err.message);
            socket.emit('errorMessage', 'Server error.');
        }
    });

    socket.on('takeCards', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Player ${playerName} requested to take cards in room ${roomId}, playerId: ${playerId}`);
        try {
            const roomResult = await pool.query(
                'SELECT gameTable, currentDefender, deck, gameEnded FROM rooms WHERE roomId = $1',
                [roomId]
            );
            const row = roomResult.rows[0];
            if (!row) {
                console.log(`Room ${roomId} does not exist or was deleted`);
                socket.emit('errorMessage', 'Game room does not exist.');
                return;
            }
            if (row.gameEnded) {
                console.log(`Room ${roomId} has ended, rejecting takeCards action`);
                socket.emit('errorMessage', 'Game has ended.');
                return;
            }
            if (playerId !== row.currentDefender) {
                socket.emit('errorMessage', 'Only defender can take cards.');
                return;
            }
            let table = row.gameTable ? JSON.parse(row.gameTable) : [];
            let deck = row.deck ? JSON.parse(row.deck) : [];
            if (!table.some(pair => pair.attack && !pair.defense)) {
                socket.emit('errorMessage', 'No cards to take.');
                return;
            }
            const playerResult = await pool.query(
                'SELECT hand, isDisconnected FROM players WHERE playerId = $1',
                [playerId]
            );
            const player = playerResult.rows[0];
            if (!player) {
                console.error('Player not found');
                socket.emit('errorMessage', 'Player not found.');
                return;
            }
            if (player.isDisconnected) {
                socket.emit('errorMessage', 'Cannot take cards while disconnected.');
                return;
            }
            let defenderHand = player.hand ? JSON.parse(player.hand) : [];
            table.forEach(pair => {
                if (pair.attack) defenderHand.push(pair.attack);
                if (pair.defense) defenderHand.push(pair.defense);
            });
            await pool.query('UPDATE players SET hand = $1 WHERE playerId = $2', [JSON.stringify(defenderHand), playerId]);
            console.log(`Player ${playerName} took ${table.length} card pairs in room ${roomId}`);
            table = [];
            await pool.query('UPDATE rooms SET gameTable = $1, lastActivity = $2 WHERE roomId = $3', [JSON.stringify(table), Date.now(), roomId]);
            const playersResult = await pool.query('SELECT playerId, isDisconnected FROM players WHERE roomId = $1', [roomId]);
            const players = playersResult.rows;
            const activePlayers = players.filter(p => !p.isDisconnected);
            if (activePlayers.length < 2) {
                await handleSinglePlayerGame(roomId);
                return;
            }
            const playerIds = activePlayers.map(p => p.playerId);
            const currentDefenderIndex = playerIds.indexOf(row.currentDefender);
            const nextAttackerIndex = (currentDefenderIndex + 1) % playerIds.length;
            const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
            const newAttacker = playerIds[nextAttackerIndex];
            const newDefender = playerIds[nextDefenderIndex] || playerIds[0];
            await drawCards(roomId, [newAttacker, newDefender], async () => {
                await pool.query(
                    'UPDATE rooms SET currentAttacker = $1, currentDefender = $2, lastActivity = $3 WHERE roomId = $4',
                    [newAttacker, newDefender, Date.now(), roomId]
                );
                console.log(`Turn updated in room ${roomId}: new attacker=${newAttacker}, new defender=${newDefender}`);
                await updateGameState(roomId);
                await checkGameEnd(roomId);
                startTurnTimer(roomId);
            });
        } catch (err) {
            console.error('Error taking cards:', err.message);
            socket.emit('errorMessage', 'Server error.');
        }
    });

    socket.on('changeLanguage', async ({ playerId, language }) => {
        language = sanitizeLanguage(language);
        playerId = sanitizeInput(playerId);
        console.log(`Player ${playerId} changing language to ${language}`);
        try {
            await pool.query(
                'UPDATE players SET language = $1 WHERE playerId = $2',
                [language, playerId]
            );
            const playerResult = await pool.query(
                'SELECT roomId, socketIds FROM players WHERE playerId = $1',
                [playerId]
            );
            const row = playerResult.rows[0];
            if (!row) {
                console.error('Player not found');
                socket.emit('errorMessage', 'Player not found.');
                return;
            }
            console.log(`Language updated for player ${playerId} to ${language} in room ${row.roomId}`);
            const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
            socketIds.forEach(socketId => {
                io.to(socketId).emit('languageChanged', { language });
            });
            await updateRoomState(row.roomId);
            await updateGameState(row.roomId);
        } catch (err) {
            console.error('Error updating language:', err.message);
            socket.emit('errorMessage', 'Server error updating language.');
        }
    });

    socket.on('ready', async ({ roomId, playerId }) => {
        roomId = sanitizeInput(roomId);
        playerId = sanitizeInput(playerId);
        console.log(`Player ready in room ${roomId}, socket: ${socket.id}, playerId: ${playerId}`);
        try {
            const playerResult = await pool.query(
                'SELECT ready, isDisconnected, socketIds FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const row = playerResult.rows[0];
            if (!row) {
                console.warn(`Player ${playerId} not found in room ${roomId}`);
                socket.emit('errorMessage', 'Player not found.');
                return;
            }
            if (row.ready === 1) {
                console.log(`Player ${playerId} already ready in room ${roomId}, sending status`);
                const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
                socketIds.forEach(socketId => {
                    io.to(socketId).emit('playerStatus', { playerId, ready: true, isDisconnected: false });
                });
                return;
            }
            const updateResult = await pool.query(
                'UPDATE players SET isDisconnected = 0, lastDisconnectedAt = NULL, ready = 1 WHERE roomId = $1 AND playerId = $2 RETURNING *',
                [roomId, playerId]
            );
            console.log(`Ready status updated for playerId ${playerId} in room ${roomId}, rows affected: ${updateResult.rowCount}`);
            if (updateResult.rowCount === 0) {
                console.warn(`No rows updated for playerId ${playerId} in room ${roomId}`);
                socket.emit('errorMessage', 'Failed to set ready status.');
                return;
            }
            const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
            socketIds.forEach(socketId => {
                io.to(socketId).emit('playerStatus', { playerId, ready: true, isDisconnected: false });
            });
            const statusResult = await pool.query(
                'SELECT COUNT(*) as total, SUM(ready) as ready FROM players WHERE roomId = $1 AND isDisconnected = 0',
                [roomId]
            );
            const status = statusResult.rows[0];
            console.log(`Room ${roomId} status: ${status.ready}/${status.total} ready`);
            await updateRoomState(roomId);
            await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
            if (status.ready >= 2 && status.ready === status.total) {
                console.log(`All players ready in room ${roomId}, starting game`);
                await startGame(roomId);
            }
        } catch (err) {
            console.error('Error setting ready status:', err.message);
            socket.emit('errorMessage', 'Server error.');
        }
    });

    socket.on('requestPlayerUpdate', async (roomId) => {
        roomId = sanitizeInput(roomId);
        console.log(`Requested player update for room ${roomId}`);
        await updateRoomState(roomId);
        await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
    });

    socket.on('leaveRoom', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Player ${playerName} requested to leave room ${roomId}, playerId: ${playerId}`);
        try {
            await removeSocketId(playerId, socket.id);
            const playerResult = await pool.query(
                'SELECT socketIds FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const row = playerResult.rows[0];
            if (!row) return;
            const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
            if (socketIds.length === 0) {
                await pool.query('DELETE FROM players WHERE roomId = $1 AND playerId = $2', [roomId, playerId]);
                console.log(`Player ${playerName} removed from room ${roomId}`);
                socket.leave(roomId);
                await updateRoomState(roomId);
                await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
            } else {
                socket.leave(roomId);
                await updateRoomState(roomId);
            }
        } catch (err) {
            console.error('Error leaving room:', err.message);
            socket.emit('errorMessage', 'Server error leaving room.');
        }
    });

    socket.on('leaveGame', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Player ${playerName} requested to leave game ${roomId}, playerId: ${playerId}`);
        try {
            await pool.query(
                'UPDATE players SET isDisconnected = 1, lastDisconnectedAt = $1 WHERE roomId = $2 AND playerId = $3',
                [Date.now(), roomId, playerId]
            );
            console.log(`Player ${playerName} marked as disconnected in game ${roomId}`);
            await removeSocketId(playerId, socket.id);
            socket.leave(roomId);
            await updateGameState(roomId);
            await handleSinglePlayerGame(roomId);
            await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
        } catch (err) {
            console.error('Error leaving game:', err.message);
            socket.emit('errorMessage', 'Server error leaving game.');
        }
    });

    socket.on('playCard', async ({ roomId, playerName, playerId, card, role }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Player ${playerName} (${role}) played card ${card.rank} of ${card.suit} in room ${roomId}, socket=${socket.id}`);
        try {
            const roomResult = await pool.query(
                'SELECT trump, gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = $1',
                [roomId]
            );
            const row = roomResult.rows[0];
            if (!row) {
                socket.emit('errorMessage', 'Game room does not exist.');
                return;
            }
            if (row.gameEnded) {
                console.log(`Room ${roomId} has ended, rejecting playCard action`);
                socket.emit('errorMessage', 'Game has ended.');
                return;
            }
            const trump = row.trump ? JSON.parse(row.trump).suit : null;
            let table = row.gameTable ? JSON.parse(row.gameTable) : [];
            const playerResult = await pool.query(
                'SELECT id, isDisconnected, hand, socketIds FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const player = playerResult.rows[0];
            if (!player) {
                console.error('Player not found');
                socket.emit('errorMessage', 'Player not found.');
                return;
            }
            if (player.isDisconnected) {
                socket.emit('errorMessage', 'Cannot play cards while disconnected.');
                return;
            }
            const isAttacker = playerId === row.currentAttacker;
            const isDefender = playerId === row.currentDefender;

            if (role === 'attack' && !isAttacker) {
                socket.emit('errorMessage', 'Not your turn to attack.');
                return;
            }
            if (role === 'defend' && !isDefender) {
                socket.emit('errorMessage', 'Not your turn to defend.');
                return;
            }

            let hand = player.hand ? JSON.parse(player.hand) : [];
            const cardIndex = hand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
            if (cardIndex === -1) {
                socket.emit('errorMessage', 'Invalid card.');
                return;
            }

            if (role === 'attack') {
                if (!isValidAttackCard(card, table, trump) || table.length >= 12) {
                    socket.emit(' ContiType="text/javascript">
                    'errorMessage', 'Invalid attack card.');
                    return;
                }
                table.push({ attack: card, defense: null });
            } else if (role === 'defend') {
                const lastAttack = table.find(pair => !pair.defense);
                if (!lastAttack) {
                    socket.emit('errorMessage', 'No attack card to defend against.');
                    return;
                }
                if (!isValidDefenseCard(card, lastAttack.attack, trump)) {
                    socket.emit('errorMessage', 'Invalid defense card.');
                    return;
                }
                lastAttack.defense = card;
            }

            hand.splice(cardIndex, 1);
            await pool.query('UPDATE players SET hand = $1 WHERE playerId = $2', [JSON.stringify(hand), playerId]);
            await pool.query('UPDATE rooms SET gameTable = $1, lastActivity = $2 WHERE roomId = $3', [JSON.stringify(table), Date.now(), roomId]);
            await updateGameState(roomId);
            await checkGameEnd(roomId);
        } catch (err) {
            console.error('Error playing card:', err.message);
            socket.emit('errorMessage', 'Server error.');
        }
    });

    socket.on('endTurn', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Player ${playerName} ended turn in room ${roomId}`);
        try {
            const roomResult = await pool.query(
                'SELECT gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = $1',
                [roomId]
            );
            const row = roomResult.rows[0];
            if (!row) {
                socket.emit('errorMessage', 'Game room does not exist.');
                return;
            }
            if (row.gameEnded) {
                console.log(`Room ${roomId} has ended, rejecting endTurn action`);
                socket.emit('errorMessage', 'Game has ended.');
                return;
            }
            let table = row.gameTable ? JSON.parse(row.gameTable) : [];
            const playerResult = await pool.query(
                'SELECT id, isDisconnected, socketIds FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const player = playerResult.rows[0];
            if (!player) {
                console.error('Player not found');
                socket.emit('errorMessage', 'Player not found.');
                return;
            }
            if (player.isDisconnected) {
                socket.emit('errorMessage', 'Cannot end turn while disconnected.');
                return;
            }
            const isDefender = playerId === row.currentDefender;

            if (!isDefender) {
                socket.emit('errorMessage', 'Only defender can end turn.');
                return;
            }

            const hasUndefended = table.some(pair => !pair.defense);
            if (hasUndefended) {
                const playersResult = await pool.query(
                    'SELECT playerId, name, hand, isDisconnected, socketIds FROM players WHERE roomId = $1',
                    [roomId]
                );
                const players = playersResult.rows;
                const defender = players.find(p => p.playerId === row.currentDefender);
                if (!defender) {
                    console.error(`Defender ${row.currentDefender} not found among players`);
                    socket.emit('errorMessage', 'Defender not missing text`);
                    return;
                }
                let defenderHand = defender.hand ? JSON.parse(defender.hand) : [];
                table.forEach(pair => {
                    defenderHand.push(pair.attack);
                    if (pair.defense) defenderHand.push(pair.defense);
                });
                await pool.query('UPDATE players SET hand = $1 WHERE playerId = $2', [JSON.stringify(defenderHand), defender.playerId]);
                console.log(`Defender ${defender.name} took cards in room ${roomId}`);
                table = [];
                await pool.query('UPDATE rooms SET gameTable = $1, lastActivity = $2 WHERE roomId = $3', [JSON.stringify(table), Date.now(), roomId]);
                const activePlayers = players.filter(p => !p.isDisconnected);
                if (activePlayers.length < 2) {
                    await handleSinglePlayerGame(roomId);
                    return;
                }
                const playerIds = activePlayers.map(p => p.playerId);
                const currentIndex = playerIds.indexOf(row.currentAttacker);
                const nextAttackerIndex = (currentIndex + 1) % playerIds.length;
                const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                const newAttacker = playerIds[nextAttackerIndex];
                const newDefender = playerIds[nextDefenderIndex] || playerIds[0];
                await drawCards(roomId, [newAttacker, newDefender], async () => {
                    await pool.query(
                        'UPDATE rooms SET currentAttacker = $1, currentDefender = $2, lastActivity = $3 WHERE roomId = $4',
                        [newAttacker, newDefender, Date.now(), roomId]
                    );
                    await updateGameState(roomId);
                    await checkGameEnd(roomId);
                    startTurnTimer(roomId);
                });
            } else {
                console.log(`Defender ${playerName} defended successfully in room ${roomId}`);
                table = [];
                await pool.query('UPDATE rooms SET gameTable = $1, lastActivity = $2 WHERE roomId = $3', [JSON.stringify(table), Date.now(), roomId]);
                const playersResult = await pool.query(
                    'SELECT playerId, name, isDisconnected FROM players WHERE roomId = $1',
                    [roomId]
                );
                const players = playersResult.rows;
                const activePlayers = players.filter(p => !p.isDisconnected);
                if (activePlayers.length < 2) {
                    await handleSinglePlayerGame(roomId);
                    return;
                }
                const playerIds = activePlayers.map(p => p.playerId);
                const currentIndex = playerIds.indexOf(row.currentAttacker);
                const nextAttackerIndex = (currentIndex + 1) % playerIds.length;
                const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                const newAttacker = playerIds[nextAttackerIndex];
                const newDefender = playerIds[nextDefenderIndex] || playerIds[0];
                await drawCards(roomId, [newAttacker, newDefender], async () => {
                    await pool.query(
                        'UPDATE rooms SET currentAttacker = $1, currentDefender = $2, lastActivity = $3 WHERE roomId = $4',
                        [newAttacker, newDefender, Date.now(), roomId]
                    );
                    await updateGameState(roomId);
                    await checkGameEnd(roomId);
                    startTurnTimer(roomId);
                });
            }
        } catch (err) {
            console.error('Error ending turn:', err.message);
            socket.emit('errorMessage', 'Server error.');
        }
    });

    socket.on('chatMessage', ({ roomId, playerName, message }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        message = sanitizeInput(message ? message.trim().slice(0, 200) : '');
        console.log(`Chat message in room ${roomId} from ${playerName}: ${message}`);
        io.to(roomId).emit('chatMessage', { playerName, message });
    });

    socket.on('tempDisconnect', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Temporary disconnect: player=${playerName}, playerId=${playerId}, room=${roomId}, socket=${socket.id}`);
        try {
            await pool.query(
                'UPDATE players SET isDisconnected = 1, lastDisconnectedAt = $1 WHERE roomId = $2 AND playerId = $3',
                [Date.now(), roomId, playerId]
            );
            console.log(`Player ${playerName} marked as temporarily disconnected in room ${roomId}`);
            await removeSocketId(playerId, socket.id);
            await updateGameState(roomId);
            await handleSinglePlayerGame(roomId);
        } catch (err) {
            console.error('Error marking player as temporarily disconnected:', err.message);
        }
    });

    socket.on('reconnectPlayer', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Reconnect request: player=${playerName}, playerId=${playerId}, room=${roomId}, socket=${socket.id}`);
        try {
            const playerResult = await pool.query(
                'SELECT isDisconnected, language, ready, socketIds, name FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const row = playerResult.rows[0];
            if (!row) {
                console.warn(`Player ${playerName} not found in room ${roomId} for reconnect`);
                socket.emit('errorMessage', 'Player not found.');
                return;
            }
            if (row.name !== playerName) {
                socket.emit('errorMessage', 'Player name mismatch.');
                return;
            }
            await pool.query(
                'UPDATE players SET isDisconnected = 0, lastDisconnectedAt = NULL WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            await addSocketId(playerId, socket.id);
            console.log(`Player ${playerName} reconnected to room ${roomId}, playerId: ${playerId}, socket: ${socket.id}`);
            socket.join(roomId);
            socket.emit('roomJoined', { roomId, playerId, language: row.language, playerName });
            socket.emit('playerStatus', { playerId, ready: !!row.ready, isDisconnected: false });
            io.to(roomId).emit('playerReconnected', { playerName });
            await updateRoomState(roomId);
            const gameResult = await pool.query('SELECT trump FROM rooms WHERE roomId = $1', [roomId]);
            if (gameResult.rows[0]?.trump) {
                await updateGameState(roomId);
                await handleSinglePlayerGame(roomId);
            }
        } catch (err) {
            console.error('Error reconnecting player:', err.message);
            socket.emit('errorMessage', 'Server error.');
        }
    });

    socket.on('disconnect', async () => {
        console.log(`User disconnected: socket=${socket.id}`);
        try {
            const playerResult = await pool.query(
                'SELECT roomId, playerId, name FROM players WHERE id = $1',
                [socket.id]
            );
            const player = playerResult.rows[0];
            if (!player) return;
            const { roomId, playerId, name } = player;
            console.log(`Player ${name} disconnected from room ${roomId}, playerId: ${playerId}, socket=${socket.id}`);
            await removeSocketId(playerId, socket.id);
            const socketResult = await pool.query(
                'SELECT socketIds FROM players WHERE roomId = $1 AND playerId = $2',
                [roomId, playerId]
            );
            const row = socketResult.rows[0];
            if (!row) return;
            const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
            if (socketIds.length === 0) {
                await pool.query(
                    'UPDATE players SET isDisconnected = 1, lastDisconnectedAt = $1 WHERE roomId = $2 AND playerId = $3',
                    [Date.now(), roomId, playerId]
                );
                console.log(`Player ${name} marked as disconnected in room ${roomId}`);
                const gameResult = await pool.query('SELECT trump FROM rooms WHERE roomId = $1', [roomId]);
                if (gameResult.rows[0]?.trump) {
                    await updateGameState(roomId);
                    await handleSinglePlayerGame(roomId);
                } else {
                    await updateRoomState(roomId);
                }
                await pool.query('UPDATE rooms SET lastActivity = $1 WHERE roomId = $2', [Date.now(), roomId]);
            } else {
                await updateRoomState(roomId);
            }
        } catch (err) {
            console.error('Error handling disconnect:', err.message);
        }
    });
});

// Periodic database cleanup
async function cleanOldRooms() {
    const oneHourAgo = Date.now() - 3600000;
    try {
        const roomsResult = await pool.query('SELECT roomId FROM rooms WHERE lastActivity < $1', [oneHourAgo]);
        const rooms = roomsResult.rows;
        for (const room of rooms) {
            const playersResult = await pool.query('SELECT COUNT(*) as count FROM players WHERE roomId = $1', [room.roomId]);
            const count = parseInt(playersResult.rows[0].count);
            console.log(`Cleaning up room ${room.roomId} with ${count} players`);
            if (count === 0) {
                clearTurnTimer(room.roomId);
                await pool.query('DELETE FROM players WHERE roomId = $1', [room.roomId]);
                await pool.query('DELETE FROM rooms WHERE roomId = $1', [room.roomId]);
                console.log(`Room ${room.roomId} deleted`);
            }
        }
    } catch (err) {
        console.error('Error cleaning old rooms:', err.message);
    }
}
setInterval(cleanOldRooms, 60000);

// Handle server shutdown
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, shutting down');
    try {
        await pool.end();
        console.log('Database connection closed');
        server.close(() => {
            console.log('Server stopped');
            process.exit(0);
        });
    } catch (err) {
        console.error('Error during shutdown:', err.message);
        process.exit(1);
    }
});

// Start server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
