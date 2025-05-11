const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
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
const dbPath = path.join('/tmp', 'durak_game.db');
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// Check database file permissions
function checkDatabasePermissions() {
    try {
        if (fs.existsSync(dbPath)) {
            fs.accessSync(dbPath, fs.constants.F_OK | fs.constants.W_OK);
            console.log('Database file is accessible and writable');
            fs.stat(dbPath, (err, stats) => {
                if (err) console.error('Error getting database file stats:', err.message);
                else console.log('Database file stats:', stats);
            });
        } else {
            console.log('Database file does not exist, will be created automatically');
        }
    } catch (err) {
        console.error('Error checking database file:', err.message);
        process.exit(1);
    }
}
checkDatabasePermissions();

// Initialize SQLite database
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
        process.exit(1);
    }
    console.log('Connected to SQLite database');
});

// Create database schema
function initDatabase() {
    db.serialize(() => {
        db.run('DROP TABLE IF EXISTS rooms', (err) => {
            if (err) console.error('Error dropping rooms table:', err.message);
            else console.log('Old rooms table dropped');
        });
        db.run('DROP TABLE IF EXISTS players', (err) => {
            if (err) console.error('Error dropping players table:', err.message);
            else console.log('Old players table dropped');
        });

        db.run(`
            CREATE TABLE rooms (
                roomId TEXT PRIMARY KEY,
                trump TEXT,
                deck TEXT,
                gameTable TEXT,
                currentAttacker TEXT,
                currentDefender TEXT,
                createdAt INTEGER,
                lastActivity INTEGER,
                activePlayers INTEGER DEFAULT 0,
                gameEnded INTEGER DEFAULT 0
            )
        `, (err) => {
            if (err) console.error('Error creating rooms table:', err.message);
            else console.log('Rooms table created');
        });

        db.run(`
            CREATE TABLE players (
                id TEXT PRIMARY KEY,
                roomId TEXT,
                playerId TEXT UNIQUE,
                name TEXT,
                ready INTEGER DEFAULT 0,
                hand TEXT,
                joinedAt INTEGER,
                isDisconnected INTEGER DEFAULT 0,
                lastDisconnectedAt INTEGER,
                language TEXT DEFAULT 'en',
                socketIds TEXT DEFAULT '[]',
                FOREIGN KEY (roomId) REFERENCES rooms (roomId)
            )
        `, (err) => {
            if (err) console.error('Error creating players table:', err.message);
            else console.log('Players table created');
        });

        db.run('DELETE FROM rooms', (err) => {
            if (err) console.error('Error clearing rooms:', err.message);
            else console.log('Rooms table cleared');
        });
        db.run('DELETE FROM players', (err) => {
            if (err) console.error('Error clearing players:', err.message);
            else console.log('Players table cleared');
        });
    });
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
function generateRoomCode(callback) {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    db.get('SELECT roomId FROM rooms WHERE roomId = ?', [code], (err, row) => {
        if (err) {
            console.error('Error checking room code:', err.message);
            callback(null);
            return;
        }
        if (row) {
            generateRoomCode(callback);
        } else {
            callback(code);
        }
    });
}

// Manage socket IDs for a player
function addSocketId(playerId, socketId, callback) {
    db.get('SELECT socketIds FROM players WHERE playerId = ?', [playerId], (err, row) => {
        if (err) {
            console.error('Error fetching socketIds:', err.message);
            callback(err);
            return;
        }
        let socketIds = row && row.socketIds ? JSON.parse(row.socketIds) : [];
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
        db.run('UPDATE players SET socketIds = ? WHERE playerId = ?', [JSON.stringify(socketIds), playerId], (err) => {
            if (err) console.error('Error updating socketIds:', err.message);
            callback(err);
        });
    });
}

function removeSocketId(playerId, socketId, callback) {
    db.get('SELECT socketIds FROM players WHERE playerId = ?', [playerId], (err, row) => {
        if (err) {
            console.error('Error fetching socketIds:', err.message);
            callback(err);
            return;
        }
        let socketIds = row && row.socketIds ? JSON.parse(row.socketIds) : [];
        socketIds = socketIds.filter(id => id !== socketId);
        db.run('UPDATE players SET socketIds = ? WHERE playerId = ?', [JSON.stringify(socketIds), playerId], (err) => {
            if (err) console.error('Error updating socketIds:', err.message);
            callback(err);
        });
    });
}

// Clean duplicate players
function cleanDuplicatePlayers(roomId, playerName, socketId, playerId, callback) {
    db.all('SELECT playerId, id, socketIds FROM players WHERE roomId = ? AND name = ? AND playerId != ?', [roomId, playerName, playerId], (err, rows) => {
        if (err) {
            console.error('Error fetching duplicate players:', err.message);
            callback(err);
            return;
        }
        console.log(`Cleaning duplicates for ${playerName} in room ${roomId}, socket=${socketId}, playerId=${playerId}, found ${rows.length} duplicates`);
        let deleted = 0;
        if (rows.length === 0) {
            callback(null);
            return;
        }
        rows.forEach(row => {
            db.run('DELETE FROM players WHERE roomId = ? AND playerId = ?', [roomId, row.playerId], err => {
                if (err) {
                    console.error('Error deleting duplicate player:', err.message);
                } else {
                    console.log(`Removed duplicate player ${playerName} with playerId ${row.playerId} from room ${roomId}`);
                }
                deleted++;
                if (deleted === rows.length) {
                    callback(null);
                }
            });
        });
    });
}

// Restrict player join
function restrictPlayerJoin(roomId, playerName, playerId, socketId, callback) {
    db.get('SELECT playerId, isDisconnected, socketIds FROM players WHERE roomId = ? AND name = ? AND playerId != ?', [roomId, playerName, playerId], (err, row) => {
        if (err) {
            console.error('Error checking player join:', err.message);
            callback(false);
            return;
        }
        if (row && !row.isDisconnected) {
            const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
            if (socketIds.some(id => io.sockets.sockets.get(id))) {
                console.log(`Player ${playerName} already active in room ${roomId} with different playerId ${row.playerId}, blocking join`);
                callback(false);
                return;
            }
        }
        callback(true);
    });
}

// Handle single player game
function handleSinglePlayerGame(roomId) {
    db.get('SELECT trump FROM rooms WHERE roomId = ?', [roomId], (err, room) => {
        if (err) {
            console.error('Error checking room:', err.message);
            return;
        }
        if (!room || !room.trump) return;
        db.all('SELECT DISTINCT playerId, name FROM players WHERE roomId = ? AND isDisconnected = 0', [roomId], (err, players) => {
            if (err) {
                console.error('Error fetching active players:', err.message);
                return;
            }
            if (players.length === 1) {
                const winner = players[0];
                console.log(`Declaring ${winner.name} as winner in room ${roomId} due to single unique player`);
                db.run('UPDATE rooms SET gameEnded = 1 WHERE roomId = ?', [roomId], err => {
                    if (err) console.error('Error marking game as ended:', err.message);
                    io.to(roomId).emit('gameOver', { winners: [winner.name] });
                    deleteRoom(roomId);
                });
            }
        });
    });
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
app.get('/room/:roomId', (req, res) => {
    const roomId = sanitizeInput(req.params.roomId);
    console.log(`HTTP request for room state: room=${roomId}`);
    db.all('SELECT name, ready, hand, language, playerId FROM players WHERE roomId = ?', [roomId], (err, players) => {
        if (err) {
            console.error('Error fetching players for HTTP:', err.message);
            res.status(500).json({ error: 'Server error fetching players' });
            return;
        }
        db.get('SELECT roomId, trump, deck, gameTable, currentAttacker, currentDefender FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
            if (err) {
                console.error('Error fetching room for HTTP:', err.message);
            }
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
        });
    });
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
    const timer = setTimeout(() => {
        db.get('SELECT currentDefender, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
            if (err || !row) {
                console.error('Error fetching currentDefender for timer:', err?.message);
                return;
            }
            if (row.gameEnded) {
                console.log(`Room ${roomId} has ended, skipping timer action`);
                return;
            }
            db.all('SELECT DISTINCT playerId FROM players WHERE roomId = ? AND isDisconnected = 0', [roomId], (err, players) => {
                if (err) {
                    console.error('Error fetching players for timer:', err.message);
                    return;
                }
                if (players.length < 2) {
                    handleSinglePlayerGame(roomId);
                    return;
                }
                const playerIds = players.map(p => p.playerId);
                const currentIndex = playerIds.indexOf(row.currentDefender);
                const nextAttackerIndex = (currentIndex + 1) % playerIds.length;
                const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                const newAttacker = playerIds[nextAttackerIndex];
                const newDefender = playerIds[nextDefenderIndex] || playerIds[0];
                db.run(
                    'UPDATE rooms SET gameTable = ?, currentAttacker = ?, currentDefender = ?, lastActivity = ? WHERE roomId = ?',
                    [JSON.stringify([]), newAttacker, newDefender, Date.now(), roomId],
                    err => {
                        if (err) {
                            console.error('Error updating turn on timeout:', err.message);
                            return;
                        }
                        console.log(`Turn timed out in room ${roomId}, new attacker: ${newAttacker}, new defender: ${newDefender}`);
                        io.to(roomId).emit('errorMessage', 'Turn timed out`"Turn timed out');
                        updateGameState(roomId);
                    }
                );
            });
        });
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
function updateRoomState(roomId) {
    db.all('SELECT name, ready, isDisconnected, language, playerId, id, socketIds FROM players WHERE roomId = ?', [roomId], (err, players) => {
        if (err) {
            console.error('Error fetching players:', err.message);
            io.to(roomId).emit('errorMessage', 'Server error fetching players.');
            return;
        }
        const readyCount = players.filter(player => player.ready).length;
        const totalCount = players.length;
        const activeCount = players.filter(p => !p.isDisconnected).length;
        db.run('UPDATE rooms SET activePlayers = ? WHERE roomId = ?', [activeCount, roomId], err => {
            if (err) console.error('Error updating activePlayers:', err.message);
        });
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
    });
}

// Update game state (for game.html)
function updateGameState(roomId) {
    db.get('SELECT trump, deck, gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
        if (err) {
            console.error('Error fetching room for game:', err.message);
            io.to(roomId).emit('errorMessage', 'Server error fetching game state.');
            return;
        }
        if (!row) {
            console.log(`Room ${roomId} not found for game state`);
            io.to(roomId).emit('errorMessage', 'Game room does not exist.');
            return;
        }
        if (row.gameEnded) {
            console.log(`Room ${roomId} has ended, skipping game state update`);
            return;
        }
        db.all('SELECT id, name, hand, playerId, isDisconnected, language, socketIds FROM players WHERE roomId = ?', [roomId], (err, players) => {
            if (err) {
                console.error('Error fetching players for game:', err.message);
            io.to(roomId).emit('errorMessage', 'Server error fetching game state.');
                return;
            }
            const activePlayers = players.filter(p => !p.isDisconnected);
            db.run('UPDATE rooms SET activePlayers = ? WHERE roomId = ?', [activePlayers.length, roomId], err => {
                if (err) console.error('Error updating activePlayers:', err.message);
            });
            if (activePlayers.length < 2 && row.trump) {
                handleSinglePlayerGame(roomId);
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
            checkGameEnd(roomId);
            db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], err => {
                if (err) console.error('Error updating lastActivity:', err.message);
            });
        });
    });
}

// Start game
function startGame(roomId) {
    console.log(`Attempting to start game in room ${roomId}`);
    db.get('SELECT trump FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
        if (err) {
            console.error('Error checking game state:', err.message);
            io.to(roomId).emit('errorMessage', 'Server error checking game state.');
            return;
        }
        if (row && row.trump) {
            console.log(`Game already started in room ${roomId}, updating state`);
            updateGameState(roomId);
            return;
        }
        db.all('SELECT id, playerId, name, ready, isDisconnected, socketIds, hand FROM players WHERE roomId = ?', [roomId], (err, players) => {
            if (err) {
                console.error('Error fetching players for game:', err.message);
                io.to(roomId).emit('errorMessage', 'Server error starting game.');
                return;
            }
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
            deck.splice(deck.indexOf(trumpCard), 1); // Remove trump from current position
            deck.push(trumpCard); // Place trump at the end

            activePlayers.forEach(player => {
                const hand = deck.splice(0, 6);
                db.run(
                    'UPDATE players SET hand = ? WHERE playerId = ?',
                    [JSON.stringify(hand), player.playerId],
                    (err) => {
                        if (err) console.error('Error updating player hand:', err.message);
                        else console.log(`Hand assigned to player ${player.name} in room ${roomId}`);
                    }
                );
            });

            // Determine first attacker
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

            db.run(
                'UPDATE rooms SET trump = ?, deck = ?, gameTable = ?, currentAttacker = ?, currentDefender = ?, lastActivity = ?, activePlayers = ?, gameEnded = 0 WHERE roomId = ?',
                [JSON.stringify(trump), JSON.stringify(deck), JSON.stringify([]), currentAttacker, currentDefender, Date.now(), activePlayers.length, roomId],
                (err) => {
                    if (err) {
                        console.error('Error updating room:', err.message);
                        io.to(roomId).emit('errorMessage', 'Server error setting game state.');
                        return;
                    }
                    console.log(`Game started in room ${roomId}, trump: ${JSON.stringify(trump)}, attacker: ${currentAttacker}, defender: ${currentDefender}, deck: ${deck.length}`);
                    io.to(roomId).emit('startGame', { trump, currentAttacker, currentDefender });
                    updateGameState(roomId);
                    const room = io.sockets.adapter.rooms.get(roomId);
                    console.log(`Room ${roomId} sockets before timer: ${room ? Array.from(room).join(',') : 'none'}`);
                    if (!room) {
                        console.warn(`Room ${roomId} not found in adapter.rooms, joining active players`);
                        activePlayers.forEach(player => {
                            const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
                            socketIds.forEach(socketId => {
                                io.sockets.sockets.get(socketId)?.join(roomId);
                                console.log(`Socket ${socketId} joined room ${roomId}`);
                            });
                        });
                    }
                    startTurnTimer(roomId);
                }
            );
        });
    });
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
function drawCards(roomId, playerIds, callback) {
    db.get('SELECT deck, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
        if (err) {
            console.error('Error fetching deck:', err.message);
            return;
        }
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
        playerIds.forEach(playerId => {
            db.get('SELECT hand, isDisconnected FROM players WHERE playerId = ?', [playerId], (err, player) => {
                if (err) {
                    console.error('Error fetching player hand:', err.message);
                    return;
                }
                if (player.isDisconnected) return;
                let hand = player.hand ? JSON.parse(player.hand) : [];
                while (hand.length < 6 && deck.length > 0) {
                    hand.push(deck.shift());
                }
                updates.push({ id: playerId, hand });
                if (updates.length === playerIds.length) {
                    updates.forEach(update => {
                        db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(update.hand), update.id], err => {
                            if (err) console.error('Error updating hand:', err.message);
                        });
                    });
                    db.run('UPDATE rooms SET deck = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(deck), Date.now(), roomId], err => {
                        if (err) console.error('Error updating deck:', err.message);
                        callback();
                    });
                }
            });
        });
    });
}

// Check game end
function checkGameEnd(roomId) {
    db.get('SELECT deck, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
        if (err) {
            console.error('Error fetching deck for game end:', err.message);
            return;
        }
        if (!row) {
            console.log(`Room ${roomId} not found for game end check`);
            return;
        }
        if (row.gameEnded) {
            console.log(`Room ${roomId} already ended, skipping game end check`);
            return;
        }
        const deck = row.deck ? JSON.parse(row.deck) : [];
        db.all('SELECT playerId, name, hand, isDisconnected FROM players WHERE roomId = ?', [roomId], (err, players) => {
            if (err) {
                console.error('Error checking game end:', err.message);
                return;
            }
            const activePlayers = players.filter(p => !p.isDisconnected);
            if (activePlayers.length < 2) {
                handleSinglePlayerGame(roomId);
                return;
            }
            const winners = activePlayers.filter(p => JSON.parse(p.hand || '[]').length === 0);
            if (deck.length === 0 && winners.length > 0) {
                const winnerNames = winners.map(p => p.name).join(', ');
                console.log(`Game over in room ${roomId}: Winners: ${winnerNames}`);
                db.run('UPDATE rooms SET gameEnded = 1 WHERE roomId = ?', [roomId], err => {
                    if (err) console.error('Error marking game as ended:', err.message);
                    io.to(roomId).emit('gameOver', { winners: winners.map(p => p.name) });
                    deleteRoom(roomId);
                });
            }
        });
    });
}

// Delete room
function deleteRoom(roomId) {
    clearTurnTimer(roomId);
    db.run('UPDATE rooms SET gameEnded = 1 WHERE roomId = ?', [roomId], err => {
        if (err) console.error('Error marking room as ended:', err.message);
        db.run('DELETE FROM players WHERE roomId = ?', [roomId], err => {
            if (err) console.error('Error deleting players:', err.message);
            db.run('DELETE FROM rooms WHERE roomId = ?', [roomId], err => {
                if (err) console.error('Error deleting room:', err.message);
                console.log(`Room ${roomId} deleted after game end`);
                io.to(roomId).emit('roomDeleted', 'Game has ended and room was deleted.');
            });
        });
    });
}

// Socket.io event handlers
io.on('connection', (socket) => {
    console.log(`New user connected: socket=${socket.id}`);

    socket.on('createRoom', (data) => {
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
        db.get('SELECT playerId FROM players WHERE playerId = ?', [playerId], (err, row) => {
            if (err) {
                console.error('Error checking playerId:', err.message);
                socket.emit('errorMessage', 'Server error.');
                return;
            }
            if (row) {
                playerId = uuidv4();
                socket.emit('setPlayerId', playerId);
                console.log(`Duplicate playerId detected, assigned new playerId: ${playerId}`);
            }
            generateRoomCode((roomId) => {
                if (!roomId) {
                    socket.emit('errorMessage', 'Failed to generate room code.');
                    return;
                }
                db.run(
                    'INSERT INTO rooms (roomId, createdAt, lastActivity, gameEnded) VALUES (?, ?, ?, ?)',
                    [roomId, Date.now(), Date.now(), 0],
                    (err) => {
                        if (err) {
                            console.error('Error creating room:', err.message);
                            socket.emit('errorMessage', 'Server error.');
                            return;
                        }
                        db.run('DELETE FROM players WHERE id = ?', [socket.id], err => {
                            if (err) console.error('Error cleaning old socket:', err.message);
                            cleanDuplicatePlayers(roomId, playerName, socket.id, playerId, (err) => {
                                if (err) {
                                    socket.emit('errorMessage', 'Server error cleaning duplicates.');
                                    return;
                                }
                                db.run(
                                    'INSERT INTO players (id, roomId, playerId, name, ready, joinedAt, isDisconnected, lastDisconnectedAt, language, socketIds) VALUES (?, ?, ?, ?, 0, ?, 0, NULL, ?, ?)',
                                    [socket.id, roomId, playerId, playerName, Date.now(), language, JSON.stringify([socket.id])],
                                    (err) => {
                                        if (err) {
                                            console.error('Error adding creator:', err.message);
                                            socket.emit('errorMessage', 'Server error.');
                                            return;
                                        }
                                        console.log(`Room ${roomId} created, player ${playerName} added with playerId ${playerId}, language ${language}, socket=${socket.id}`);
                                        socket.join(roomId);
                                        console.log(`Socket ${socket.id} joined room ${roomId}`);
                                        socket.emit('roomCreated', { roomId, playerId, language, playerName });
                                        socket.emit('roomJoined', { roomId, playerId, language, playerName });
                                        socket.emit('playerStatus', { playerId, ready: false, isDisconnected: false });
                                        updateRoomState(roomId);
                                    }
                                );
                            });
                        });
                    }
                );
            });
        });
    });

    socket.on('joinRoom', (data) => {
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
        db.get('SELECT roomId FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
            if (err) {
                console.error('Error checking room:', err.message);
                socket.emit('errorMessage', 'Server error.');
                return;
            }
            if (!row) {
                socket.emit('errorMessage', 'Room does not exist.');
                socket.emit('setPlayerId', playerId);
                return;
            }
            db.get('SELECT name, playerId, id, isDisconnected, hand, lastDisconnectedAt, language, ready, socketIds FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, row) => {
                if (err) {
                    console.error('Error checking player:', err.message);
                    socket.emit('errorMessage', 'Server error.');
                    return;
                }
                if (row) {
                    if (row.name !== playerName) {
                        socket.emit('errorMessage', 'Player name mismatch for this ID.');
                        return;
                    }
                    if (!row.isDisconnected) {
                        addSocketId(playerId, socket.id, (err) => {
                            if (err) {
                                socket.emit('errorMessage', 'Server error adding socket.');
                                return;
                            }
                            console.log(`Player ${playerName} added socket ${socket.id} to existing playerId ${playerId} in room ${roomId}`);
                            socket.join(roomId);
                            socket.emit('roomJoined', { roomId, playerId, language: row.language, playerName });
                            socket.emit('playerStatus', { playerId, ready: !!row.ready, isDisconnected: false });
                            updateRoomState(roomId);
                            db.get('SELECT trump FROM rooms WHERE roomId = ?', [roomId], (err, room) => {
                                if (err) {
                                    console.error('Error checking game state:', err.message);
                                    return;
                                }
                                if (room && room.trump) {
                                    updateGameState(roomId);
                                }
                            });
                        });
                        return;
                    } else {
                        db.run(
                            'UPDATE players SET id = ?, isDisconnected = 0, lastDisconnectedAt = NULL, language = ?, socketIds = ? WHERE roomId = ? AND playerId = ?',
                            [socket.id, language, JSON.stringify([socket.id]), roomId, playerId],
                            (err) => {
                                if (err) {
                                    console.error('Error updating player on reconnect:', err.message);
                                    socket.emit('errorMessage', 'Server error.');
                                    return;
                                }
                                console.log(`Player ${playerName} reconnected to room ${roomId}, playerId: ${playerId}, socket: ${socket.id}`);
                                socket.join(roomId);
                                socket.emit('roomJoined', { roomId, playerId, language: row.language, playerName });
                                socket.emit('playerStatus', { playerId, ready: !!row.ready, isDisconnected: false });
                                io.to(roomId).emit('playerReconnected', { playerName });
                                updateRoomState(roomId);
                                db.get('SELECT trump FROM rooms WHERE roomId = ?', [roomId], (err, room) => {
                                    if (err) {
                                        console.error('Error checking game state:', err.message);
                                        return;
                                    }
                                    if (room && room.trump) {
                                        updateGameState(roomId);
                                    }
                                });
                            }
                        );
                        return;
                    }
                }
                restrictPlayerJoin(roomId, playerName, playerId, socket.id, (canJoin) => {
                    if (!canJoin) {
                        socket.emit('errorMessage', 'Player with this name already active with a different ID.');
                        return;
                    }
                    cleanDuplicatePlayers(roomId, playerName, socket.id, playerId, (err) => {
                        if (err) {
                            socket.emit('errorMessage', 'Server error cleaning duplicates.');
                            return;
                        }
                        db.run('DELETE FROM players WHERE id = ?', [socket.id], err => {
                            if (err) console.error('Error cleaning old socket:', err.message);
                            db.get('SELECT COUNT(*) as count FROM players WHERE roomId = ?', [roomId], (err, row) => {
                                if (err) {
                                    console.error('Error counting players:', err.message);
                                    socket.emit('errorMessage', 'Server error.');
                                    return;
                                }
                                if (row.count >= 2) {
                                    socket.emit('errorMessage', 'Room is full.');
                                    socket.emit('setPlayerId', playerId);
                                    return;
                                }
                                socket.join(roomId);
                                console.log(`Socket ${socket.id} joined room ${roomId}`);
                                db.run(
                                    'INSERT INTO players (id, roomId, playerId, name, ready, joinedAt, isDisconnected, lastDisconnectedAt, language, socketIds) VALUES (?, ?, ?, ?, 0, ?, 0, NULL, ?, ?)',
                                    [socket.id, roomId, playerId, playerName, Date.now(), language, JSON.stringify([socket.id])],
                                    (err) => {
                                        if (err) {
                                            console.error('Error adding player:', err.message);
                                            socket.emit('errorMessage', 'Server error.');
                                            return;
                                        }
                                        console.log(`Player ${playerName} joined room ${roomId} with playerId ${playerId}, language ${language}, socket=${socket.id}`);
                                        socket.emit('roomJoined', { roomId, playerId, language, playerName });
                                        socket.emit('playerStatus', { playerId, ready: false, isDisconnected: false });
                                        updateRoomState(roomId);
                                        db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], err => {
                                            if (err) console.error('Error updating lastActivity:', err.message);
                                        });
                                    }
                                );
                            });
                        });
                    });
                });
            });
        });
    });

    socket.on('takeCards', ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Player ${playerName} requested to take cards in room ${roomId}, playerId: ${playerId}`);

        db.get('SELECT gameTable, currentDefender, deck, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
            if (err) {
                console.error('Error fetching room:', err.message);
                socket.emit('errorMessage', 'Server error.');
                return;
            }
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

            db.get('SELECT hand, isDisconnected FROM players WHERE playerId = ?', [playerId], (err, player) => {
                if (err || !player) {
                    console.error('Error fetching player:', err ? err.message : 'Player not found');
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

                db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(defenderHand), playerId], err => {
                    if (err) {
                        console.error('Error updating defender hand:', err.message);
                        socket.emit('errorMessage', 'Server error.');
                        return;
                    }
                    console.log(`Player ${playerName} took ${table.length} card pairs in room ${roomId}`);

                    table = [];
                    db.run('UPDATE rooms SET gameTable = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(table), Date.now(), roomId], err => {
                        if (err) {
                            console.error('Error clearing table:', err.message);
                            socket.emit('errorMessage', 'Server error.');
                            return;
                        }

                        db.all('SELECT playerId, isDisconnected FROM players WHERE roomId = ?', [roomId], (err, players) => {
                            if (err) {
                                console.error('Error fetching players:', err.message);
                                socket.emit('errorMessage', 'Server error.');
                                return;
                            }
                            const activePlayers = players.filter(p => !p.isDisconnected);
                            if (activePlayers.length < 2) {
                                handleSinglePlayerGame(roomId);
                                return;
                            }

                            const playerIds = activePlayers.map(p => p.playerId);
                            const currentDefenderIndex = playerIds.indexOf(row.currentDefender);
                            const nextAttackerIndex = (currentDefenderIndex + 1) % playerIds.length;
                            const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                            const newAttacker = playerIds[nextAttackerIndex];
                            const newDefender = playerIds[nextDefenderIndex] || playerIds[0];

                            drawCards(roomId, [newAttacker, newDefender], () => {
                                db.run(
                                    'UPDATE rooms SET currentAttacker = ?, currentDefender = ?, lastActivity = ? WHERE roomId = ?',
                                    [newAttacker, newDefender, Date.now(), roomId],
                                    err => {
                                        if (err) {
                                            console.error('Error updating roles:', err.message);
                                            socket.emit('errorMessage', 'Server error.');
                                            return;
                                        }
                                        console.log(`Turn updated in room ${roomId}: new attacker=${newAttacker}, new defender=${newDefender}`);
                                        updateGameState(roomId);
                                        checkGameEnd(roomId);
                                        startTurnTimer(roomId);
                                    }
                                );
                            });
                        });
                    });
                });
            });
        });
    });

    socket.on('changeLanguage', ({ playerId, language }) => {
        language = sanitizeLanguage(language);
        playerId = sanitizeInput(playerId);
        console.log(`Player ${playerId} changing language to ${language}`);
        db.run(
            'UPDATE players SET language = ? WHERE playerId = ?',
            [language, playerId],
            (err) => {
                if (err) {
                    console.error('Error updating language:', err.message);
                    socket.emit('errorMessage', 'Server error updating language.');
                    return;
                }
                db.get('SELECT roomId, socketIds FROM players WHERE playerId = ?', [playerId], (err, row) => {
                    if (err || !row) {
                        console.error('Error fetching roomId for player:', err ? err.message : 'Player not found');
                        socket.emit('errorMessage', 'Player not found.');
                        return;
                    }
                    console.log(`Language updated for player ${playerId} to ${language} in room ${row.roomId}`);
                    const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
                    socketIds.forEach(socketId => {
                        io.to(socketId).emit('languageChanged', { language });
                    });
                    updateRoomState(row.roomId);
                    updateGameState(row.roomId);
                });
            }
        );
    });

    socket.on('ready', ({ roomId, playerId }) => {
        roomId = sanitizeInput(roomId);
        playerId = sanitizeInput(playerId);
        console.log(`Player ready in room ${roomId}, socket: ${socket.id}, playerId: ${playerId}`);
        db.get('SELECT ready, isDisconnected, socketIds FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, row) => {
            if (err) {
                console.error('Error checking ready status:', err.message);
                socket.emit('errorMessage', 'Server error.');
                return;
            }
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
            db.run(
                'UPDATE players SET isDisconnected = 0, lastDisconnectedAt = NULL, ready = 1 WHERE roomId = ? AND playerId = ?',
                [roomId, playerId],
                function (err) {
                    if (err) {
                        console.error('Error setting ready status:', err.message);
                        socket.emit('errorMessage', 'Server error.');
                        return;
                    }
                    console.log(`Ready status updated for playerId ${playerId} in room ${roomId}, rows affected: ${this.changes}`);
                    if (this.changes === freerun 0) {
                        console.warn(`No rows updated for playerId ${playerId} in room ${roomId}`);
                        socket.emit('errorMessage', 'Failed to set ready status.');
                        return;
                    }
                    db.get('SELECT socketIds FROM players WHERE playerId = ?', [playerId], (err, row) => {
                        if (err) {
                            console.error('Error fetching socketIds:', err.message);
                            return;
                        }
                        const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
                        socketIds.forEach(socketId => {
                            io.to(socketId).emit('playerStatus', { playerId, ready: true, isDisconnected: false });
                        });
                    });
                    db.get(
                        'SELECT COUNT(*) as total, SUM(ready) as ready FROM players WHERE roomId = ? AND isDisconnected = 0',
                        [roomId],
                        (err, row) => {
                            if (err) {
                                console.error('Error checking ready status:', err.message);
                                return;
                            }
                            console.log(`Room ${roomId} status: ${row.ready}/${row.total} ready`);
                            updateRoomState(roomId);
                            db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], err => {
                                if (err) console.error('Error updating lastActivity:', err.message);
                            });
                            if (row.ready >= 2 && row.ready === row.total) {
                                console.log(`All players ready in room ${roomId}, starting game`);
                                startGame(roomId);
                            }
                        }
                    );
                }
            );
        });
    });

    socket.on('requestPlayerUpdate', (roomId) => {
        roomId = sanitizeInput(roomId);
        console.log(`Requested player update for room ${roomId}`);
        updateRoomState(roomId);
        db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], err => {
            if (err) console.error('Error updating lastActivity:', err.message);
        });
    });

    socket.on('leaveRoom', ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Player ${playerName} requested to leave room ${roomId}, playerId: ${playerId}`);
        removeSocketId(playerId, socket.id, (err) => {
            if (err) {
                socket.emit('errorMessage', 'Server error leaving room.');
                return;
            }
            db.get('SELECT socketIds FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, row) => {
                if (err) {
                    console.error('Error checking socketIds:', err.message);
                    socket.emit('errorMessage', 'Server error.');
                    return;
                }
                const socketIds = row && row.socketIds ? JSON.parse(row.socketIds) : [];
                if (socketIds.length === 0) {
                    db.run('DELETE FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err) => {
                        if (err) {
                            console.error('Error deleting player:', err.message);
                            socket.emit('errorMessage', 'Server error leaving room.');
                            return;
                        }
                        console.log(`Player ${playerName} removed from room ${roomId}`);
                        socket.leave(roomId);
                        updateRoomState(roomId);
                        db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], err => {
                            if (err) console.error('Error updating lastActivity:', err.message);
                        });
                    });
                } else {
                    socket.leave(roomId);
                    updateRoomState(roomId);
                }
            });
        });
    });

    socket.on('leaveGame', ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Player ${playerName} requested to leave game ${roomId}, playerId: ${playerId}`);
        db.run('UPDATE players SET isDisconnected = 1, lastDisconnectedAt = ? WHERE roomId = ? AND playerId = ?', [Date.now(), roomId, playerId], (err) => {
            if (err) {
                console.error('Error marking player as disconnected:', err.message);
                socket.emit('errorMessage', 'Server error leaving game.');
                return;
            }
            console.log(`Player ${playerName} marked as disconnected in game ${roomId}`);
            removeSocketId(playerId, socket.id, (err) => {
                if (err) console.error('Error removing socketId:', err.message);
            });
            socket.leave(roomId);
            updateGameState(roomId);
            handleSinglePlayerGame(roomId);
            db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], err => {
                if (err) console.error('Error updating lastActivity:', err.message);
            });
        });
    });

    socket.on('playCard', ({ roomId, playerName, playerId, card, role }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Player ${playerName} (${role}) played card ${card.rank} of ${card.suit} in room ${roomId}, socket=${socket.id}`);
        db.get('SELECT trump, gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
            if (err) {
                console.error('Error fetching room:', err.message);
                socket.emit('errorMessage', 'Server error.');
                return;
            }
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
            db.get('SELECT id, isDisconnected, hand, socketIds FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, player) => {
                if (err || !player) {
                    console.error('Error fetching player:', err ? err.message : 'Player not found');
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
                        socket.emit('errorMessage', 'Invalid attack card.');
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
                db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(hand), playerId], err => {
                    if (err) {
                        console.error('Error updating hand:', err.message);
                        socket.emit('errorMessage', 'Server error.');
                        return;
                    }
                    db.run('UPDATE rooms SET gameTable = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(table), Date.now(), roomId], err => {
                        if (err) {
                            console.error('Error updating table:', err.message);
                            socket.emit('errorMessage', 'Server error.');
                        }
                        updateGameState(roomId);
                        checkGameEnd(roomId);
                    });
                });
            });
        });
    });

    socket.on('endTurn', ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Player ${playerName} ended turn in room ${roomId}`);
        db.get('SELECT gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
            if (err) {
                console.error('Error fetching room:', err.message);
                socket.emit('errorMessage', 'Server error.');
                return;
            }
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
            db.get('SELECT id, isDisconnected, socketIds FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, player) => {
                if (err || !player) {
                    console.error('Error fetching player:', err ? err.message : 'Player not found');
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
                    db.all('SELECT playerId, name, hand, isDisconnected, socketIds FROM players WHERE roomId = ?', [roomId], (err, players) => {
                        if (err) {
                            console.error('Error fetching players:', err.message);
                            socket.emit('errorMessage', 'Server error.');
                            return;
                        }
                        const defender = players.find(p => p.playerId === row.currentDefender);
                        if (!defender) {
                            console.error(`Defender ${row.currentDefender} not found among players`);
                            socket.emit('errorMessage', 'Defender not found.');
                            return;
                        }
                        let defenderHand = defender.hand ? JSON.parse(defender.hand) : [];
                        table.forEach(pair => {
                            defenderHand.push(pair.attack);
                            if (pair.defense) defenderHand.push(pair.defense);
                        });
                        db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(defenderHand), defender.playerId], err => {
                            if (err) console.error('Error updating defender hand:', err.message);
                        });
                        console.log(`Defender ${defender.name} took cards in room ${roomId}`);
                        table = [];
                        db.run('UPDATE rooms SET gameTable = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(table), Date.now(), roomId], err => {
                            if (err) {
                                console.error('Error clearing table:', err.message);
                                return;
                            }
                            const activePlayers = players.filter(p => !p.isDisconnected);
                            if (activePlayers.length < 2) {
                                handleSinglePlayerGame(roomId);
                                return;
                            }
                            const playerIds = activePlayers.map(p => p.playerId);
                            const currentIndex = playerIds.indexOf(row.currentAttacker);
                            const nextAttackerIndex = (currentIndex + 1) % playerIds.length;
                            const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                            const newAttacker = playerIds[nextAttackerIndex];
                            const newDefender = playerIds[nextDefenderIndex] || playerIds[0];

                            drawCards(roomId, [newAttacker, newDefender], () => {
                                db.run(
                                    'UPDATE rooms SET currentAttacker = ?, currentDefender = ?, lastActivity = ? WHERE roomId = ?',
                                    [newAttacker, newDefender, Date.now(), roomId],
                                    err => {
                                        if (err) {
                                            console.error('Error updating roles:', err.message);
                                            return;
                                        }
                                        updateGameState(roomId);
                                        checkGameEnd(roomId);
                                        startTurnTimer(roomId);
                                    }
                                );
                            });
                        });
                    });
                } else {
                    console.log(`Defender ${playerName} defended successfully in room ${roomId}`);
                    table = [];
                    db.run('UPDATE rooms SET gameTable = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(table), Date.now(), roomId], err => {
                        if (err) {
                            console.error('Error clearing table:', err.message);
                            return;
                        }
                        db.all('SELECT playerId, name, isDisconnected FROM players WHERE roomId = ?', [roomId], (err, players) => {
                            if (err) {
                                console.error('Error fetching players:', err.message);
                                return;
                            }
                            const activePlayers = players.filter(p => !p.isDisconnected);
                            if (activePlayers.length < 2) {
                                handleSinglePlayerGame(roomId);
                                return;
                            }
                            const playerIds = activePlayers.map(p => p.playerId);
                            const currentIndex = playerIds.indexOf(row.currentAttacker);
                            const nextAttackerIndex = (currentIndex + 1) % playerIds.length;
                            const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                            const newAttacker = playerIds[nextAttackerIndex];
                            const newDefender = playerIds[nextDefenderIndex] || playerIds[0];

                            drawCards(roomId, [newAttacker, newDefender], () => {
                                db.run(
                                    'UPDATE rooms SET currentAttacker = ?, currentDefender = ?, lastActivity = ? WHERE roomId = ?',
                                    [newAttacker, newDefender, Date.now(), roomId],
                                    err => {
                                        if (err) {
                                            console.error('Error updating roles:', err.message);
                                            return;
                                        }
                                        updateGameState(roomId);
                                        checkGameEnd(roomId);
                                        startTurnTimer(roomId);
                                    }
                                );
                            });
                        });
                    });
                }
            });
        });
    });

    socket.on('chatMessage', ({ roomId, playerName, message }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        message = sanitizeInput(message ? message.trim().slice(0, 200) : '');
        console.log(`Chat message in room ${roomId} from ${playerName}: ${message}`);
        io.to(roomId).emit('chatMessage', { playerName, message });
    });

    socket.on('tempDisconnect', ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Temporary disconnect: player=${playerName}, playerId=${playerId}, room=${roomId}, socket=${socket.id}`);
        db.run(
            'UPDATE players SET isDisconnected = 1, lastDisconnectedAt = ? WHERE roomId = ? AND playerId = ?',
            [Date.now(), roomId, playerId],
            err => {
                if (err) {
                    console.error('Error marking player as temporarily disconnected:', err.message);
                    return;
                }
                console.log(`Player ${playerName} marked as temporarily disconnected in room ${roomId}`);
                removeSocketId(playerId, socket.id, (err) => {
                    if (err) console.error('Error removing socketId:', err.message);
                });
                updateGameState(roomId);
                handleSinglePlayerGame(roomId);
            }
        );
    });

    socket.on('reconnectPlayer', ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Reconnect request: player=${playerName}, playerId=${playerId}, room=${roomId}, socket=${socket.id}`);
        db.get('SELECT isDisconnected, language, ready, socketIds, name FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, row) => {
            if (err) {
                console.error('Error checking player for reconnect:', err.message);
                socket.emit('errorMessage', 'Server error.');
                return;
            }
            if (!row) {
                console.warn(`Player ${playerName} not found in room ${roomId} for reconnect`);
                socket.emit('errorMessage', 'Player not found.');
                return;
            }
            if (row.name !== playerName) {
                socket.emit('errorMessage', 'Player name mismatch.');
                return;
            }
            db.run(
                'UPDATE players SET isDisconnected = 0, lastDisconnectedAt = NULL WHERE roomId = ? AND playerId = ?',
                [roomId, playerId],
                err => {
                    if (err) {
                        console.error('Error reconnecting player:', err.message);
                        socket.emit('errorMessage', 'Server error.');
                        return;
                    }
                    addSocketId(playerId, socket.id, (err) => {
                        if (err) {
                            socket.emit('errorMessage', 'Server error adding socket.');
                            return;
                        }
                        console.log(`Player ${playerName} reconnected to room ${roomId}, playerId: ${playerId}, socket: ${socket.id}`);
                        socket.join(roomId);
                        socket.emit('roomJoined', { roomId, playerId, language: row.language, playerName });
                        socket.emit('playerStatus', { playerId, ready: !!row.ready, isDisconnected: false });
                        io.to(roomId).emit('playerReconnected', { playerName });
                        updateRoomState(roomId);
                        db.get('SELECT trump FROM rooms WHERE roomId = ?', [roomId], (err, room) => {
                            if (err) {
                                console.error('Error checking game state:', err.message);
                                return;
                            }
                            if (room && room.trump) {
                                updateGameState(roomId);
                                handleSinglePlayerGame(roomId);
                            }
                        });
                    });
                }
            );
        });
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: socket=${socket.id}`);
        db.get('SELECT roomId, playerId, name FROM players WHERE id = ?', [socket.id], (err, player) => {
            if (err) {
                console.error('Error checking player on disconnect:', err.message);
                return;
            }
            if (!player) return;
            const { roomId, playerId, name } = player;
            console.log(`Player ${name} disconnected from room ${roomId}, playerId: ${playerId}, socket=${socket.id}`);
            removeSocketId(playerId, socket.id, (err) => {
                if (err) {
                    console.error('Error removing socketId:', err.message);
                    return;
                }
                db.get('SELECT socketIds FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, row) => {
                    if (err) {
                        console.error('Error checking socketIds:', err.message);
                        return;
                    }
                    const socketIds = row && row.socketIds ? JSON.parse(row.socketIds) : [];
                    if (socketIds.length === 0) {
                        db.run(
                            'UPDATE players SET isDisconnected = 1, lastDisconnectedAt = ? WHERE roomId = ? AND playerId = ?',
                            [Date.now(), roomId, playerId],
                            err => {
                                if (err) {
                                    console.error('Error marking player as disconnected:', err.message);
                                    return;
                                }
                                console.log(`Player ${name} marked as disconnected in room ${roomId}`);
                                db.get('SELECT trump FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
                                    if (err) {
                                        console.error('Error checking game state:', err.message);
                                        return;
                                    }
                                    if (row && row.trump) {
                                        updateGameState(roomId);
                                        handleSinglePlayerGame(roomId);
                                    } else {
                                        updateRoomState(roomId);
                                    }
                                });
                                db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], err => {
                                    if (err) console.error('Error updating lastActivity:', err.message);
                                });
                            }
                        );
                    } else {
                        updateRoomState(roomId);
                    }
                });
            });
        });
    });
});

// Periodic cleanup of old rooms
async function cleanOldRooms() {
    const oneHourAgo = Date.now() - 3600000; // 1 hour ago
    try {
        const rooms = await new Promise((resolve, reject) => {
            db.all('SELECT roomId FROM rooms WHERE lastActivity < ? AND gameEnded = FALSE', [oneHourAgo], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        for (const room of rooms) {
            console.log(`Cleaning old room: ${room.roomId}`);
            await deleteRoom(room.roomId);
        }
        console.log(`Old rooms cleanup completed, removed: ${rooms.length} rooms`);
    } catch (err) {
        console.error('Error cleaning old rooms:', err.message);
    }
}
setInterval(cleanOldRooms, 10 * 60 * 1000); // Run every 10 minutes

// Handle server shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down');
    db.close(err => {
        if (err) console.error('Error closing database:', err.message);
        else console.log('Database connection closed');
        server.close(() => {
            console.log('Server stopped');
            process.exit(0);
        });
    });
});

// Handle server errors
server.on('error', (err) => {
    console.error('Server error:', err.message);
});

// Start server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`APP_URL: ${APP_URL}`);
    console.log(`Database path: ${dbPath}`);
});
