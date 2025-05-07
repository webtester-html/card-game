const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cron = require('node-cron');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true
    }
});

const PORT = process.env.PORT || 3000;
const dbPath = path.join('/tmp', 'durak_game.db');
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// Проверка прав доступа к файлу базы данных
function checkDatabasePermissions() {
    try {
        if (fs.existsSync(dbPath)) {
            fs.accessSync(dbPath, fs.constants.F_OK | fs.constants.W_OK);
            console.log('Database file is accessible and writable');
            fs.stat(dbPath, (err, stats) => {
                if (err) {
                    console.error('Error getting database file stats:', err.message);
                } else {
                    console.log('Database file stats:', stats);
                }
            });
        } else {
            console.log('Database file does not exist, will be created');
        }
    } catch (err) {
        console.error('Error checking database file permissions:', err.message);
        process.exit(1);
    }
}
checkDatabasePermissions();

// Инициализация базы данных SQLite с обработкой ошибок
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Failed to connect to SQLite database:', err.message);
        process.exit(1);
    }
    console.log('Successfully connected to SQLite database at', dbPath);
});

// Инициализация структуры базы данных
function initDatabase() {
    db.serialize(() => {
        // Удаление старых таблиц, если они существуют
        db.run('DROP TABLE IF EXISTS rooms', (err) => {
            if (err) {
                console.error('Error dropping rooms table:', err.message);
            } else {
                console.log('Old rooms table dropped successfully');
            }
        });

        db.run('DROP TABLE IF EXISTS players', (err) => {
            if (err) {
                console.error('Error dropping players table:', err.message);
            } else {
                console.log('Old players table dropped successfully');
            }
        });

        db.run('DROP TABLE IF EXISTS game_history', (err) => {
            if (err) {
                console.error('Error dropping game_history table:', err.message);
            } else {
                console.log('Old game_history table dropped successfully');
            }
        });

        // Создание таблицы rooms
        db.run(`
            CREATE TABLE IF NOT EXISTS rooms (
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
            if (err) {
                console.error('Error creating rooms table:', err.message);
            } else {
                console.log('Rooms table created successfully');
            }
        });

        // Создание таблицы players
        db.run(`
            CREATE TABLE IF NOT EXISTS players (
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
                wins INTEGER DEFAULT 0,
                losses INTEGER DEFAULT 0,
                FOREIGN KEY (roomId) REFERENCES rooms (roomId)
            )
        `, (err) => {
            if (err) {
                console.error('Error creating players table:', err.message);
            } else {
                console.log('Players table created successfully');
            }
        });

        // Создание таблицы game_history
        db.run(`
            CREATE TABLE IF NOT EXISTS game_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                roomId TEXT,
                playerId TEXT,
                action TEXT,
                card TEXT,
                timestamp INTEGER,
                FOREIGN KEY (roomId) REFERENCES rooms (roomId),
                FOREIGN KEY (playerId) REFERENCES players (playerId)
            )
        `, (err) => {
            if (err) {
                console.error('Error creating game_history table:', err.message);
            } else {
                console.log('Game_history table created successfully');
            }
        });

        // Очистка старых данных
        db.run('DELETE FROM rooms', (err) => {
            if (err) {
                console.error('Error clearing rooms table:', err.message);
            } else {
                console.log('Rooms table cleared successfully');
            }
        });

        db.run('DELETE FROM players', (err) => {
            if (err) {
                console.error('Error clearing players table:', err.message);
            } else {
                console.log('Players table cleared successfully');
            }
        });
    });
}
initDatabase();

// Настройка пингера для поддержания активности сервера
function setupPinger() {
    cron.schedule('*/5 * * * *', async () => {
        try {
            const response = await axios.get(APP_URL);
            console.log(`Pinged ${APP_URL} to keep server awake, status: ${response.status}`);
        } catch (err) {
            console.error('Error pinging server:', err.message);
        }
    });
    console.log('Pinger scheduled to run every 5 minutes');
}
setupPinger();

// Очистка устаревших комнат (старше 1 часа)
function cleanupOldRooms() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    db.run('DELETE FROM rooms WHERE lastActivity < ? AND gameEnded = 1', [oneHourAgo], (err) => {
        if (err) {
            console.error('Error cleaning up old rooms:', err.message);
        } else {
            console.log('Old rooms cleaned up successfully');
        }
    });
    db.run('DELETE FROM players WHERE roomId NOT IN (SELECT roomId FROM rooms)', (err) => {
        if (err) {
            console.error('Error cleaning up orphaned players:', err.message);
        } else {
            console.log('Orphaned players cleaned up successfully');
        }
    });
}
cron.schedule('0 * * * *', cleanupOldRooms);

// Функции санитизации ввода
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 50);
}

function sanitizeLanguage(lang) {
    const validLanguages = ['en', 'ru', 'uk'];
    return validLanguages.includes(lang) ? lang : 'en';
}

// Генерация уникального кода комнаты
function generateRoomCode(callback) {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    db.get('SELECT roomId FROM rooms WHERE roomId = ?', [code], (err, row) => {
        if (err) {
            console.error('Error checking room code:', err.message);
            callback(null);
            return;
        }
        if (row) {
            console.log(`Room code ${code} already exists, generating new one`);
            generateRoomCode(callback);
        } else {
            console.log(`Generated unique room code: ${code}`);
            callback(code);
        }
    });
}

// Управление socketIds для игроков
function addSocketId(playerId, socketId, callback) {
    db.get('SELECT socketIds FROM players WHERE playerId = ?', [playerId], (err, row) => {
        if (err) {
            console.error('Error fetching socketIds for player:', err.message);
            callback(err);
            return;
        }
        let socketIds = row && row.socketIds ? JSON.parse(row.socketIds) : [];
        socketIds.forEach(id => {
            if (id !== socketId && io.sockets.sockets.get(id)) {
                console.log(`Disconnecting old socket ${id} for playerId ${playerId}`);
                io.to(id).emit('errorMessage', 'Another session has taken over');
                io.sockets.sockets.get(id)?.disconnect(true);
            }
        });
        socketIds = socketIds.filter(id => id === socketId || io.sockets.sockets.get(id));
        if (!socketIds.includes(socketId)) {
            socketIds.push(socketId);
        }
        db.run('UPDATE players SET socketIds = ? WHERE playerId = ?', [JSON.stringify(socketIds), playerId], (err) => {
            if (err) {
                console.error('Error updating socketIds:', err.message);
            } else {
                console.log(`Socket ${socketId} added for player ${playerId}`);
            }
            callback(err);
        });
    });
}

function removeSocketId(playerId, socketId, callback) {
    db.get('SELECT socketIds FROM players WHERE playerId = ?', [playerId], (err, row) => {
        if (err) {
            console.error('Error fetching socketIds for player:', err.message);
            callback(err);
            return;
        }
        let socketIds = row && row.socketIds ? JSON.parse(row.socketIds) : [];
        socketIds = socketIds.filter(id => id !== socketId);
        db.run('UPDATE players SET socketIds = ? WHERE playerId = ?', [JSON.stringify(socketIds), playerId], (err) => {
            if (err) {
                console.error('Error removing socketId:', err.message);
            } else {
                console.log(`Socket ${socketId} removed for player ${playerId}`);
            }
            callback(err);
        });
    });
}

// Очистка дублирующихся игроков
function cleanDuplicatePlayers(roomId, playerName, socketId, playerId, callback) {
    db.all('SELECT playerId, id, socketIds FROM players WHERE roomId = ? AND name = ? AND playerId != ?', [roomId, playerName, playerId], (err, rows) => {
        if (err) {
            console.error('Error fetching duplicate players:', err.message);
            callback(err);
            return;
        }
        if (rows.length === 0) {
            console.log(`No duplicate players found for ${playerName} in room ${roomId}`);
            callback(null);
            return;
        }
        let deleted = 0;
        rows.forEach(row => {
            db.run('DELETE FROM players WHERE roomId = ? AND playerId = ?', [roomId, row.playerId], err => {
                if (err) {
                    console.error('Error deleting duplicate player:', err.message);
                } else {
                    console.log(`Deleted duplicate player ${row.playerId} in room ${roomId}`);
                }
                deleted++;
                if (deleted === rows.length) {
                    callback(null);
                }
            });
        });
    });
}

// Ограничение подключения игроков
function restrictPlayerJoin(roomId, playerName, playerId, socketId, callback) {
    db.get('SELECT playerId, isDisconnected, socketIds FROM players WHERE roomId = ? AND name = ? AND playerId != ?', [roomId, playerName, playerId], (err, row) => {
        if (err) {
            console.error('Error checking player join restriction:', err.message);
            callback(false);
            return;
        }
        if (row && !row.isDisconnected) {
            const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
            if (socketIds.some(id => io.sockets.sockets.get(id))) {
                console.log(`Player ${playerName} is already active in room ${roomId}`);
                callback(false);
                return;
            }
        }
        console.log(`Player ${playerName} can join room ${roomId}`);
        callback(true);
    });
}

// Обработка случая с одним игроком
function handleSinglePlayerGame(roomId) {
    db.get('SELECT trump, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, room) => {
        if (err) {
            console.error('Error checking room for single player:', err.message);
            return;
        }
        if (!room || !room.trump || room.gameEnded) return;
        db.all('SELECT DISTINCT playerId, name FROM players WHERE roomId = ? AND isDisconnected = 0', [roomId], (err, players) => {
            if (err) {
                console.error('Error fetching players for single player check:', err.message);
                return;
            }
            if (players.length <= 1) {
                const winner = players[0];
                console.log(`Declaring ${winner ? winner.name : 'no one'} as winner in room ${roomId}`);
                db.run('UPDATE rooms SET gameEnded = 1 WHERE roomId = ?', [roomId], err => {
                    if (err) {
                        console.error('Error marking game as ended:', err.message);
                    }
                    io.to(roomId).emit('gameOver', { winners: winner ? [winner.name] : [] });
                    if (winner) {
                        db.run('UPDATE players SET wins = wins + 1 WHERE playerId = ?', [winner.playerId]);
                    }
                    deleteRoom(roomId);
                });
            }
        });
    });
}

// Настройка статических файлов
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.css')) {
            res.setHeader('Content-Type', 'text/css');
        }
        if (filePath.endsWith('.js')) {
            res.setHeader('Content-Type', 'application/javascript');
        }
    }
}));

// Маршруты для обслуживания страниц
app.get('/style.css', (req, res) => {
    res.setHeader('Content-Type', 'text/css');
    res.sendFile(path.join(__dirname, 'public', 'style.css'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/room', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/game', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// Эндпоинт для получения состояния комнаты
app.get('/room/:roomId', (req, res) => {
    const roomId = sanitizeInput(req.params.roomId);
    db.all('SELECT name, ready, hand, language, playerId FROM players WHERE roomId = ?', [roomId], (err, players) => {
        if (err) {
            console.error('Error fetching players for room state:', err.message);
            res.status(500).json({ error: 'Server error' });
            return;
        }
        db.get('SELECT roomId, trump, deck, gameTable, currentAttacker, currentDefender FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
            if (err || !row) {
                console.error('Error fetching room state:', err?.message);
                res.status(404).json({ error: 'Room not found' });
                return;
            }
            console.log(`Returning room state for room ${roomId}`);
            res.json({
                players: players.map(p => ({
                    name: p.name,
                    ready: !!p.ready,
                    hand: p.hand ? JSON.parse(p.hand) : [],
                    language: p.language,
                    playerId: p.playerId
                })),
                readyCount: players.filter(p => p.ready).length,
                totalCount: players.length,
                trump: row.trump ? JSON.parse(row.trump) : null,
                deckCount: row.deck ? JSON.parse(row.deck).length : 0,
                table: row.gameTable ? JSON.parse(row.gameTable) : [],
                currentAttacker: row.currentAttacker,
                currentDefender: row.currentDefender
            });
        });
    });
});

// Логика игры
function createDeck() {
    const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
    const ranks = ['6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
    const deck = [];
    for (let suit of suits) {
        for (let rank of ranks) {
            deck.push({ rank, suit });
        }
    }
    console.log('Created new deck with 36 cards');
    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    console.log('Deck shuffled');
}

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

    console.log(`Lowest trump card: ${lowestTrumpCard ? JSON.stringify(lowestTrumpCard) : 'none'}, first attacker: ${firstAttacker}`);
    return { lowestTrumpCard, firstAttacker };
}

function startTurnTimer(roomId) {
    clearTurnTimer(roomId);
    const timer = setTimeout(() => {
        db.get('SELECT currentDefender, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
            if (err || !row) {
                console.error('Error fetching defender for timer:', err?.message);
                return;
            }
            if (row.gameEnded) return;
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
                const currentDefenderIndex = playerIds.indexOf(row.currentDefender);
                const nextAttackerIndex = (currentDefenderIndex + 1) % playerIds.length;
                const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                const newAttacker = playerIds[nextAttackerIndex];
                const newDefender = playerIds[nextDefenderIndex] || playerIds[0];
                db.run(
                    'UPDATE rooms SET gameTable = ?, currentAttacker = ?, currentDefender = ?, lastActivity = ? WHERE roomId = ?',
                    [JSON.stringify([]), newAttacker, newDefender, Date.now(), roomId],
                    err => {
                        if (err) {
                            console.error('Error updating turn after timeout:', err.message);
                        }
                        io.to(roomId).emit('errorMessage', 'Turn timed out');
                        updateGameState(roomId);
                        console.log(`Turn timed out in room ${roomId}, new attacker: ${newAttacker}, new defender: ${newDefender}`);
                    }
                );
            });
        });
    }, 30000);
    io.to(roomId).emit('startTimer', { duration: 30000 });
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room) {
        room.timer = timer;
        console.log(`Started 30-second timer for room ${roomId}`);
    }
}

function clearTurnTimer(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.timer) {
        clearTimeout(room.timer);
        delete room.timer;
        console.log(`Cleared timer for room ${roomId}`);
    }
}

function updateRoomState(roomId) {
    db.all('SELECT name, ready, isDisconnected, language, playerId, id, socketIds FROM players WHERE roomId = ?', [roomId], (err, players) => {
        if (err) {
            console.error('Error fetching players for room state update:', err.message);
            io.to(roomId).emit('errorMessage', 'Server error');
            return;
        }
        const readyCount = players.filter(p => p.ready).length;
        const activeCount = players.filter(p => !p.isDisconnected).length;
        db.run('UPDATE rooms SET activePlayers = ? WHERE roomId = ?', [activeCount, roomId], err => {
            if (err) {
                console.error('Error updating active players count:', err.message);
            }
        });
        io.to(roomId).emit('updateRoom', {
            players: players.map(p => ({
                name: p.name,
                ready: !!p.ready,
                playerId: p.playerId
            })),
            readyCount,
            totalCount: players.length,
            playerLanguages: players.map(p => ({ name: p.name, language: p.language }))
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
        console.log(`Updated room state for ${roomId}: ${activeCount} active players, ${readyCount} ready`);
    });
}

function updateGameState(roomId) {
    db.get('SELECT trump, deck, gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
        if (err || !row) {
            console.error('Error fetching room for game state:', err?.message);
            io.to(roomId).emit('errorMessage', 'Game room does not exist');
            return;
        }
        if (row.gameEnded) return;
        db.all('SELECT id, name, hand, playerId, isDisconnected, language, socketIds FROM players WHERE roomId = ?', [roomId], (err, players) => {
            if (err) {
                console.error('Error fetching players for game state:', err.message);
                io.to(roomId).emit('errorMessage', 'Server error');
                return;
            }
            const activePlayers = players.filter(p => !p.isDisconnected);
            db.run('UPDATE rooms SET activePlayers = ? WHERE roomId = ?', [activePlayers.length, roomId]);
            if (activePlayers.length < 2) {
                handleSinglePlayerGame(roomId);
                return;
            }
            const playerOrder = activePlayers.map(p => ({
                playerId: p.playerId,
                name: p.name,
                isCurrentAttacker: p.playerId === row.currentAttacker,
                isCurrentDefender: p.playerId === row.currentDefender
            }));
            const gameState = {
                players: players.map(p => ({
                    id: p.playerId,
                    name: p.name,
                    hand: p.hand ? JSON.parse(p.hand) : [],
                    isDisconnected: !!p.isDisconnected,
                    language: p.language
                })),
                trump: row.trump ? JSON.parse(row.trump) : null,
                deckCount: row.deck ? JSON.parse(row.deck).length : 0,
                table: row.gameTable ? JSON.parse(row.gameTable) : [],
                currentAttacker: row.currentAttacker,
                currentDefender: row.currentDefender,
                playerOrder
            };
            const tableHasCards = gameState.table.some(pair => pair.attack && !pair.defense);
            const buttonState = {
                showEndTurn: tableHasCards && !gameState.table.some(pair => !pair.defense),
                showTakeCards: tableHasCards
            };
            players.forEach(player => {
                const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
                socketIds.forEach(socketId => {
                    io.to(socketId).emit('updateGame', gameState);
                    io.to(socketId).emit('buttonState', buttonState);
                });
            });
            checkGameEnd(roomId);
            db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId]);
            console.log(`Updated game state for room ${roomId}`);
        });
    });
}

function startGame(roomId) {
    db.get('SELECT trump FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
        if (err) {
            console.error('Error checking game start:', err.message);
            io.to(roomId).emit('errorMessage', 'Server error');
            return;
        }
        if (row && row.trump) {
            updateGameState(roomId);
            return;
        }
        db.all('SELECT id, playerId, name, ready, isDisconnected, socketIds, hand FROM players WHERE roomId = ?', [roomId], (err, players) => {
            if (err) {
                console.error('Error fetching players for game start:', err.message);
                io.to(roomId).emit('errorMessage', 'Server error');
                return;
            }
            const activePlayers = players.filter(p => !p.isDisconnected);
            if (activePlayers.length < 2) {
                io.to(roomId).emit('errorMessage', 'Minimum 2 players required to start');
                return;
            }
            if (activePlayers.length > 4) {
                io.to(roomId).emit('errorMessage', 'Maximum 4 players allowed');
                return;
            }
            const readyCount = activePlayers.filter(p => p.ready).length;
            if (readyCount !== activePlayers.length) {
                io.to(roomId).emit('errorMessage', 'All players must be ready to start');
                return;
            }

            const deck = createDeck();
            shuffleDeck(deck);
            const trumpCard = deck[Math.floor(Math.random() * deck.length)];
            const trump = { card: trumpCard, suit: trumpCard.suit };
            deck.splice(deck.indexOf(trumpCard), 1);
            deck.push(trumpCard);

            activePlayers.forEach(player => {
                const hand = deck.splice(0, 6);
                db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(hand), player.playerId], err => {
                    if (err) {
                        console.error(`Error updating hand for player ${player.playerId}:`, err.message);
                    }
                });
            });

            const { lowestTrumpCard, firstAttacker } = findLowestTrumpCard(activePlayers, trump.suit);
            let currentAttacker, currentDefender;
            const activePlayerIds = activePlayers.map(p => p.playerId);

            if (firstAttacker) {
                currentAttacker = firstAttacker;
                const attackerIndex = activePlayerIds.indexOf(firstAttacker);
                currentDefender = activePlayerIds[(attackerIndex + 1) % activePlayerIds.length];
            } else {
                currentAttacker = activePlayerIds[0];
                currentDefender = activePlayerIds[1];
            }

            db.run(
                'UPDATE rooms SET trump = ?, deck = ?, gameTable = ?, currentAttacker = ?, currentDefender = ?, lastActivity = ?, activePlayers = ?, gameEnded = 0 WHERE roomId = ?',
                [JSON.stringify(trump), JSON.stringify(deck), JSON.stringify([]), currentAttacker, currentDefender, Date.now(), activePlayers.length, roomId],
                (err) => {
                    if (err) {
                        console.error('Error starting game:', err.message);
                        io.to(roomId).emit('errorMessage', 'Server error');
                        return;
                    }
                    io.to(roomId).emit('startGame', { trump, currentAttacker, currentDefender });
                    updateGameState(roomId);
                    startTurnTimer(roomId);
                    console.log(`Game started in room ${roomId} with trump ${trump.suit}`);
                }
            );
        });
    });
}

function isValidAttackCard(card, table, trump) {
    if (!table.length) return true;
    const valid = table.some(pair => pair.attack.rank === card.rank);
    console.log(`Checking attack card ${JSON.stringify(card)}: ${valid ? 'valid' : 'invalid'}`);
    return valid;
}

function isValidDefenseCard(defenseCard, attackCard, trump) {
    const rankOrder = ['6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
    if (defenseCard.suit === attackCard.suit) {
        const valid = rankOrder.indexOf(defenseCard.rank) > rankOrder.indexOf(attackCard.rank);
        console.log(`Checking defense card ${JSON.stringify(defenseCard)} against ${JSON.stringify(attackCard)}: ${valid ? 'valid' : 'invalid'}`);
        return valid;
    }
    const valid = defenseCard.suit === trump;
    console.log(`Checking defense card ${JSON.stringify(defenseCard)} against ${JSON.stringify(attackCard)} with trump ${trump}: ${valid ? 'valid' : 'invalid'}`);
    return valid;
}

function drawCards(roomId, playerIds, callback) {
    db.get('SELECT deck, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
        if (err || !row) return;
        if (row.gameEnded) return;
        let deck = row.deck ? JSON.parse(row.deck) : [];
        let updates = [];
        let completed = 0;
        playerIds.forEach(playerId => {
            db.get('SELECT hand, isDisconnected FROM players WHERE playerId = ?', [playerId], (err, player) => {
                if (err || !player || player.isDisconnected) {
                    completed++;
                    if (completed === playerIds.length) callback();
                    return;
                }
                let hand = player.hand ? JSON.parse(player.hand) : [];
                while (hand.length < 6 && deck.length > 0) {
                    hand.push(deck.shift());
                }
                updates.push({ id: playerId, hand });
                completed++;
                if (completed === playerIds.length) {
                    updates.forEach(update => {
                        db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(update.hand), update.id], err => {
                            if (err) {
                                console.error(`Error updating hand for player ${update.id}:`, err.message);
                            }
                        });
                    });
                    db.run('UPDATE rooms SET deck = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(deck), Date.now(), roomId], err => {
                        if (err) {
                            console.error('Error updating deck:', err.message);
                        }
                    });
                    callback();
                    console.log(`Cards drawn for players ${playerIds.join(', ')} in room ${roomId}`);
                }
            });
        });
    });
}

function checkGameEnd(roomId) {
    db.get('SELECT deck, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
        if (err || !row || row.gameEnded) return;
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
                db.run('UPDATE rooms SET gameEnded = 1 WHERE roomId = ?', [roomId], err => {
                    if (err) {
                        console.error('Error marking game as ended:', err.message);
                    }
                });
                winners.forEach(winner => {
                    db.run('UPDATE players SET wins = wins + 1 WHERE playerId = ?', [winner.playerId]);
                });
                activePlayers.forEach(player => {
                    if (!winners.some(w => w.playerId === player.playerId)) {
                        db.run('UPDATE players SET losses = losses + 1 WHERE playerId = ?', [player.playerId]);
                    }
                });
                io.to(roomId).emit('gameOver', { winners: winners.map(p => p.name) });
                deleteRoom(roomId);
                console.log(`Game ended in room ${roomId}, winners: ${winners.map(p => p.name).join(', ')}`);
            }
        });
    });
}

function deleteRoom(roomId) {
    clearTurnTimer(roomId);
    db.run('UPDATE rooms SET gameEnded = 1 WHERE roomId = ?', [roomId], err => {
        if (err) {
            console.error('Error marking room as ended:', err.message);
        }
    });
    db.run('DELETE FROM players WHERE roomId = ?', [roomId], err => {
        if (err) {
            console.error('Error deleting players for room:', err.message);
        }
    });
    db.run('DELETE FROM rooms WHERE roomId = ?', [roomId], err => {
        if (err) {
            console.error('Error deleting room:', err.message);
        }
    });
    io.to(roomId).emit('roomDeleted', 'Game ended and room deleted');
    console.log(`Room ${roomId} deleted`);
}

// Логирование действий игрока
function logPlayerAction(roomId, playerId, action, card = null) {
    db.run(
        'INSERT INTO game_history (roomId, playerId, action, card, timestamp) VALUES (?, ?, ?, ?, ?)',
        [roomId, playerId, action, card ? JSON.stringify(card) : null, Date.now()],
        err => {
            if (err) {
                console.error('Error logging player action:', err.message);
            } else {
                console.log(`Logged action ${action} for player ${playerId} in room ${roomId}`);
            }
        }
    );
}

// Обработка Socket.IO событий
io.on('connection', (socket) => {
    console.log(`New socket connected: ${socket.id}`);

    socket.on('createRoom', (data) => {
        let playerName, playerId, language;
        if (typeof data === 'string') {
            playerName = data;
            playerId = uuidv4();
            language = 'en';
        } else {
            playerName = data.playerName;
            playerId = data.playerId || uuidv4();
            language = sanitizeLanguage(data.language || 'en');
        }
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        if (!playerName) {
            socket.emit('errorMessage', 'Invalid name');
            socket.emit('setPlayerId', playerId);
            console.log(`Invalid name provided for room creation: ${playerName}`);
            return;
        }
        db.get('SELECT playerId FROM players WHERE playerId = ?', [playerId], (err, row) => {
            if (row) {
                playerId = uuidv4();
                console.log(`PlayerId ${playerId} already exists, generated new one`);
            }
            generateRoomCode((roomId) => {
                if (!roomId) {
                    socket.emit('errorMessage', 'Failed to generate room code');
                    console.log('Failed to generate room code');
                    return;
                }
                db.run(
                    'INSERT INTO rooms (roomId, createdAt, lastActivity, gameEnded) VALUES (?, ?, ?, ?)',
                    [roomId, Date.now(), Date.now(), 0],
                    (err) => {
                        if (err) {
                            socket.emit('errorMessage', 'Server error');
                            console.error('Error creating room:', err.message);
                            return;
                        }
                        db.run('DELETE FROM players WHERE id = ?', [socket.id]);
                        cleanDuplicatePlayers(roomId, playerName, socket.id, playerId, (err) => {
                            if (err) {
                                socket.emit('errorMessage', 'Server error');
                                console.error('Error cleaning duplicates:', err.message);
                                return;
                            }
                            db.run(
                                'INSERT INTO players (id, roomId, playerId, name, ready, joinedAt, isDisconnected, language, socketIds) VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)',
                                [socket.id, roomId, playerId, playerName, Date.now(), language, JSON.stringify([socket.id])],
                                (err) => {
                                    if (err) {
                                        socket.emit('errorMessage', 'Server error');
                                        console.error('Error inserting player:', err.message);
                                        return;
                                    }
                                    socket.join(roomId);
                                    socket.emit('roomCreated', { roomId, playerId, language, playerName });
                                    socket.emit('roomJoined', { roomId, playerId, language, playerName });
                                    socket.emit('playerStatus', { playerId, ready: false, isDisconnected: false });
                                    updateRoomState(roomId);
                                    console.log(`Player ${playerName} created and joined room ${roomId}`);
                                }
                            );
                        });
                    }
                );
            });
        });
    });

    socket.on('joinRoom', (data) => {
        const { roomId, playerName, playerId, language } = data;
        const sanitizedRoomId = sanitizeInput(roomId);
        const sanitizedPlayerName = sanitizeInput(playerName);
        const sanitizedPlayerId = sanitizeInput(playerId || uuidv4());
        const sanitizedLanguage = sanitizeLanguage(language || 'en');
        if (!sanitizedRoomId || !sanitizedPlayerName) {
            socket.emit('errorMessage', 'Invalid room ID or name');
            socket.emit('setPlayerId', sanitizedPlayerId);
            console.log(`Invalid room ID or name for join: ${sanitizedRoomId}, ${sanitizedPlayerName}`);
            return;
        }
        db.get('SELECT roomId FROM rooms WHERE roomId = ?', [sanitizedRoomId], (err, row) => {
            if (!row) {
                socket.emit('errorMessage', 'Room does not exist');
                socket.emit('setPlayerId', sanitizedPlayerId);
                console.log(`Room ${sanitizedRoomId} does not exist`);
                return;
            }
            db.get('SELECT name, playerId, isDisconnected, hand, language, ready, socketIds FROM players WHERE roomId = ? AND playerId = ?', [sanitizedRoomId, sanitizedPlayerId], (err, row) => {
                if (row) {
                    if (row.name !== sanitizedPlayerName) {
                        socket.emit('errorMessage', 'Name mismatch');
                        console.log(`Name mismatch for playerId ${sanitizedPlayerId}: ${row.name} vs ${sanitizedPlayerName}`);
                        return;
                    }
                    if (!row.isDisconnected) {
                        addSocketId(sanitizedPlayerId, socket.id, (err) => {
                            if (err) {
                                socket.emit('errorMessage', 'Server error');
                                console.error('Error adding socketId:', err.message);
                                return;
                            }
                            socket.join(sanitizedRoomId);
                            socket.emit('roomJoined', { roomId: sanitizedRoomId, playerId: sanitizedPlayerId, language: row.language, playerName: sanitizedPlayerName });
                            socket.emit('playerStatus', { playerId: sanitizedPlayerId, ready: !!row.ready, isDisconnected: false });
                            updateRoomState(sanitizedRoomId);
                            db.get('SELECT trump FROM rooms WHERE roomId = ?', [sanitizedRoomId], (err, room) => {
                                if (room && room.trump) updateGameState(sanitizedRoomId);
                            });
                            console.log(`Player ${sanitizedPlayerName} rejoined room ${sanitizedRoomId}`);
                        });
                        return;
                    }
                    db.run(
                        'UPDATE players SET id = ?, isDisconnected = 0, lastDisconnectedAt = NULL, language = ?, socketIds = ? WHERE roomId = ? AND playerId = ?',
                        [socket.id, sanitizedLanguage, JSON.stringify([socket.id]), sanitizedRoomId, sanitizedPlayerId],
                        (err) => {
                            if (err) {
                                socket.emit('errorMessage', 'Server error');
                                console.error('Error updating player:', err.message);
                                return;
                            }
                            socket.join(sanitizedRoomId);
                            socket.emit('roomJoined', { roomId: sanitizedRoomId, playerId: sanitizedPlayerId, language: row.language, playerName: sanitizedPlayerName });
                            socket.emit('playerStatus', { playerId: sanitizedPlayerId, ready: !!row.ready, isDisconnected: false });
                            io.to(sanitizedRoomId).emit('playerReconnected', { playerName: sanitizedPlayerName });
                            updateRoomState(sanitizedRoomId);
                            db.get('SELECT trump FROM rooms WHERE roomId = ?', [sanitizedRoomId], (err, room) => {
                                if (room && room.trump) updateGameState(sanitizedRoomId);
                            });
                            console.log(`Player ${sanitizedPlayerName} reconnected to room ${sanitizedRoomId}`);
                        }
                    );
                    return;
                }
                restrictPlayerJoin(sanitizedRoomId, sanitizedPlayerName, sanitizedPlayerId, socket.id, (canJoin) => {
                    if (!canJoin) {
                        socket.emit('errorMessage', 'Player already active');
                        console.log(`Player ${sanitizedPlayerName} already active in room ${sanitizedRoomId}`);
                        return;
                    }
                    cleanDuplicatePlayers(sanitizedRoomId, sanitizedPlayerName, socket.id, sanitizedPlayerId, (err) => {
                        if (err) {
                            socket.emit('errorMessage', 'Server error');
                            console.error('Error cleaning duplicates:', err.message);
                            return;
                        }
                        db.run('DELETE FROM players WHERE id = ?', [socket.id]);
                        db.get('SELECT COUNT(*) as count FROM players WHERE roomId = ?', [sanitizedRoomId], (err, row) => {
                            if (err || row.count >= 4) {
                                socket.emit('errorMessage', 'Room is full');
                                socket.emit('setPlayerId', sanitizedPlayerId);
                                console.log(`Room ${sanitizedRoomId} is full`);
                                return;
                            }
                            socket.join(sanitizedRoomId);
                            db.run(
                                'INSERT INTO players (id, roomId, playerId, name, ready, joinedAt, isDisconnected, language, socketIds) VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)',
                                [socket.id, sanitizedRoomId, sanitizedPlayerId, sanitizedPlayerName, Date.now(), sanitizedLanguage, JSON.stringify([socket.id])],
                                (err) => {
                                    if (err) {
                                        socket.emit('errorMessage', 'Server error');
                                        console.error('Error inserting player:', err.message);
                                        return;
                                    }
                                    socket.emit('roomJoined', { roomId: sanitizedRoomId, playerId: sanitizedPlayerId, language: sanitizedLanguage, playerName: sanitizedPlayerName });
                                    socket.emit('playerStatus', { playerId: sanitizedPlayerId, ready: false, isDisconnected: false });
                                    updateRoomState(sanitizedRoomId);
                                    db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), sanitizedRoomId]);
                                    console.log(`Player ${sanitizedPlayerName} joined room ${sanitizedRoomId}`);
                                }
                            );
                        });
                    });
                });
            });
        });
    });

    socket.on('takeCards', ({ roomId, playerId, playerName }) => {
        const sanitizedRoomId = sanitizeInput(roomId);
        const sanitizedPlayerName = sanitizeInput(playerName);
        const sanitizedPlayerId = sanitizeInput(playerId);
        db.get('SELECT gameTable, currentDefender, deck, gameEnded FROM rooms WHERE roomId = ?', [sanitizedRoomId], (err, row) => {
            if (err || !row) {
                socket.emit('errorMessage', 'Game room does not exist');
                console.log(`Room ${sanitizedRoomId} not found for takeCards`);
                return;
            }
            if (row.gameEnded) {
                socket.emit('errorMessage', 'Game has ended');
                console.log(`Game in room ${sanitizedRoomId} has ended`);
                return;
            }
            if (sanitizedPlayerId !== row.currentDefender) {
                socket.emit('errorMessage', 'Only defender can take cards');
                console.log(`Player ${sanitizedPlayerId} is not defender in room ${sanitizedRoomId}`);
                return;
            }
            let table = row.gameTable ? JSON.parse(row.gameTable) : [];
            if (!table.some(pair => pair.attack && !pair.defense)) {
                socket.emit('errorMessage', 'No cards to take');
                console.log(`No cards to take in room ${sanitizedRoomId}`);
                return;
            }
            db.get('SELECT hand, isDisconnected FROM players WHERE playerId = ?', [sanitizedPlayerId], (err, player) => {
                if (err || !player) {
                    socket.emit('errorMessage', 'Player not found');
                    console.log(`Player ${sanitizedPlayerId} not found`);
                    return;
                }
                if (player.isDisconnected) {
                    socket.emit('errorMessage', 'Cannot take cards while disconnected');
                    console.log(`Player ${sanitizedPlayerId} is disconnected`);
                    return;
                }
                let defenderHand = player.hand ? JSON.parse(player.hand) : [];
                table.forEach(pair => {
                    if (pair.attack) defenderHand.push(pair.attack);
                    if (pair.defense) defenderHand.push(pair.defense);
                });
                db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(defenderHand), sanitizedPlayerId], err => {
                    if (err) {
                        console.error('Error updating defender hand:', err.message);
                    }
                });
                table = [];
                db.run('UPDATE rooms SET gameTable = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(table), Date.now(), sanitizedRoomId], err => {
                    if (err) {
                        console.error('Error updating game table:', err.message);
                    }
                });
                logPlayerAction(sanitizedRoomId, sanitizedPlayerId, 'takeCards');
                db.all('SELECT playerId, isDisconnected FROM players WHERE roomId = ?', [sanitizedRoomId], (err, players) => {
                    if (err) {
                        socket.emit('errorMessage', 'Server error');
                        console.error('Error fetching players:', err.message);
                        return;
                    }
                    const activePlayers = players.filter(p => !p.isDisconnected);
                    if (activePlayers.length < 2) {
                        handleSinglePlayerGame(sanitizedRoomId);
                        return;
                    }
                    const playerIds = activePlayers.map(p => p.playerId);
                    const currentDefenderIndex = playerIds.indexOf(row.currentDefender);
                    const nextAttackerIndex = (currentDefenderIndex + 1) % playerIds.length;
                    const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                    const newAttacker = playerIds[nextAttackerIndex];
                    const newDefender = playerIds[nextDefenderIndex] || playerIds[0];
                    drawCards(sanitizedRoomId, [newAttacker, newDefender], () => {
                        db.run(
                            'UPDATE rooms SET currentAttacker = ?, currentDefender = ?, lastActivity = ? WHERE roomId = ?',
                            [newAttacker, newDefender, Date.now(), sanitizedRoomId],
                            err => {
                                if (err) {
                                    socket.emit('errorMessage', 'Server error');
                                    console.error('Error updating turn:', err.message);
                                }
                                updateGameState(sanitizedRoomId);
                                checkGameEnd(sanitizedRoomId);
                                startTurnTimer(sanitizedRoomId);
                                console.log(`Player ${sanitizedPlayerName} took cards in room ${sanitizedRoomId}`);
                            }
                        );
                    });
                });
            });
        });
    });

    socket.on('changeLanguage', ({ playerId, language }) => {
        const sanitizedPlayerId = sanitizeInput(playerId);
        const sanitizedLanguage = sanitizeLanguage(language);
        db.run('UPDATE players SET language = ? WHERE playerId = ?', [sanitizedLanguage, sanitizedPlayerId], (err) => {
            if (err) {
                socket.emit('errorMessage', 'Server error');
                console.error('Error updating language:', err.message);
                return;
            }
            db.get('SELECT roomId, socketIds FROM players WHERE playerId = ?', [sanitizedPlayerId], (err, row) => {
                if (err || !row) {
                    socket.emit('errorMessage', 'Player not found');
                    console.log(`Player ${sanitizedPlayerId} not found for language change`);
                    return;
                }
                const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
                socketIds.forEach(socketId => {
                    io.to(socketId).emit('languageChanged', { language: sanitizedLanguage });
                });
                updateRoomState(row.roomId);
                updateGameState(row.roomId);
                console.log(`Player ${sanitizedPlayerId} changed language to ${sanitizedLanguage}`);
            });
        });
    });

    socket.on('ready', ({ roomId, playerId }) => {
        const sanitizedRoomId = sanitizeInput(roomId);
        const sanitizedPlayerId = sanitizeInput(playerId);
        db.get('SELECT ready, isDisconnected, socketIds FROM players WHERE roomId = ? AND playerId = ?', [sanitizedRoomId, sanitizedPlayerId], (err, row) => {
            if (err || !row) {
                socket.emit('errorMessage', 'Player not found');
                console.log(`Player ${sanitizedPlayerId} not found for ready`);
                return;
            }
            if (row.ready) {
                const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
                socketIds.forEach(socketId => {
                    io.to(socketId).emit('playerStatus', { playerId: sanitizedPlayerId, ready: true, isDisconnected: false });
                });
                console.log(`Player ${sanitizedPlayerId} already ready in room ${sanitizedRoomId}`);
                return;
            }
            db.run(
                'UPDATE players SET isDisconnected = 0, lastDisconnectedAt = NULL, ready = 1 WHERE roomId = ? AND playerId = ?',
                [sanitizedRoomId, sanitizedPlayerId],
                function (err) {
                    if (err) {
                        socket.emit('errorMessage', 'Server error');
                        console.error('Error setting player ready:', err.message);
                        return;
                    }
                    const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
                    socketIds.forEach(socketId => {
                        io.to(socketId).emit('playerStatus', { playerId: sanitizedPlayerId, ready: true, isDisconnected: false });
                    });
                    db.get(
                        'SELECT COUNT(*) as total, SUM(ready) as ready FROM players WHERE roomId = ? AND isDisconnected = 0',
                        [sanitizedRoomId],
                        (err, row) => {
                            if (err) {
                                console.error('Error checking ready players:', err.message);
                                return;
                            }
                            updateRoomState(sanitizedRoomId);
                            db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), sanitizedRoomId]);
                            if (row.ready >= 2 && row.ready === row.total) {
                                startGame(sanitizedRoomId);
                            }
                            console.log(`Player ${sanitizedPlayerId} marked ready in room ${sanitizedRoomId}`);
                        }
                    );
                }
            );
        });
    });

    socket.on('requestPlayerUpdate', (roomId) => {
        const sanitizedRoomId = sanitizeInput(roomId);
        updateRoomState(sanitizedRoomId);
        db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), sanitizedRoomId]);
        console.log(`Player update requested for room ${sanitizedRoomId}`);
    });

    socket.on('leaveRoom', ({ roomId, playerId, playerName }) => {
        const sanitizedRoomId = sanitizeInput(roomId);
        const sanitizedPlayerName = sanitizeInput(playerName);
        const sanitizedPlayerId = sanitizeInput(playerId);
        removeSocketId(sanitizedPlayerId, socket.id, (err) => {
            if (err) {
                socket.emit('errorMessage', 'Server error');
                console.error('Error removing socketId:', err.message);
                return;
            }
            db.get('SELECT socketIds FROM players WHERE roomId = ? AND playerId = ?', [sanitizedRoomId, sanitizedPlayerId], (err, row) => {
                if (err) {
                    socket.emit('errorMessage', 'Server error');
                    console.error('Error fetching socketIds:', err.message);
                    return;
                }
                const socketIds = row && row.socketIds ? JSON.parse(row.socketIds) : [];
                if (socketIds.length === 0) {
                    db.run('DELETE FROM players WHERE roomId = ? AND playerId = ?', [sanitizedRoomId, sanitizedPlayerId], (err) => {
                        if (err) {
                            socket.emit('errorMessage', 'Server error');
                            console.error('Error deleting player:', err.message);
                            return;
                        }
                        socket.leave(sanitizedRoomId);
                        updateRoomState(sanitizedRoomId);
                        db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), sanitizedRoomId]);
                        console.log(`Player ${sanitizedPlayerName} left room ${sanitizedRoomId}`);
                    });
                } else {
                    socket.leave(sanitizedRoomId);
                    updateRoomState(sanitizedRoomId);
                    console.log(`Player ${sanitizedPlayerName} disconnected socket from room ${sanitizedRoomId}`);
                }
            });
        });
    });

    socket.on('leaveGame', ({ roomId, playerId, playerName }) => {
        const sanitizedRoomId = sanitizeInput(roomId);
        const sanitizedPlayerName = sanitizeInput(playerName);
        const sanitizedPlayerId = sanitizeInput(playerId);
        db.run('UPDATE players SET isDisconnected = 1, lastDisconnectedAt = ? WHERE roomId = ? AND playerId = ?', [Date.now(), sanitizedRoomId, sanitizedPlayerId], (err) => {
            if (err) {
                socket.emit('errorMessage', 'Server error');
                console.error('Error marking player disconnected:', err.message);
                return;
            }
            removeSocketId(sanitizedPlayerId, socket.id);
            socket.leave(sanitizedRoomId);
            updateGameState(sanitizedRoomId);
            handleSinglePlayerGame(sanitizedRoomId);
            db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), sanitizedRoomId]);
            console.log(`Player ${sanitizedPlayerName} left game in room ${sanitizedRoomId}`);
        });
    });

    socket.on('playCard', ({ roomId, playerName, playerId, card, role }) => {
        const sanitizedRoomId = sanitizeInput(roomId);
        const sanitizedPlayerName = sanitizeInput(playerName);
        const sanitizedPlayerId = sanitizeInput(playerId);
        db.get('SELECT trump, gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = ?', [sanitizedRoomId], (err, row) => {
            if (err || !row) {
                socket.emit('errorMessage', 'Game room does not exist');
                console.log(`Room ${sanitizedRoomId} not found for playCard`);
                return;
            }
            if (row.gameEnded) {
                socket.emit('errorMessage', 'Game has ended');
                console.log(`Game in room ${sanitizedRoomId} has ended`);
                return;
            }
            const trump = row.trump ? JSON.parse(row.trump).suit : null;
            let table = row.gameTable ? JSON.parse(row.gameTable) : [];
            db.get('SELECT isDisconnected, hand, socketIds FROM players WHERE roomId = ? AND playerId = ?', [sanitizedRoomId, sanitizedPlayerId], (err, player) => {
                if (err || !player) {
                    socket.emit('errorMessage', 'Player not found');
                    console.log(`Player ${sanitizedPlayerId} not found`);
                    return;
                }
                if (player.isDisconnected) {
                    socket.emit('errorMessage', 'Cannot play while disconnected');
                    console.log(`Player ${sanitizedPlayerId} is disconnected`);
                    return;
                }
                const isAttacker = sanitizedPlayerId === row.currentAttacker;
                const isDefender = sanitizedPlayerId === row.currentDefender;
                if (role === 'attack' && !isAttacker) {
                    socket.emit('errorMessage', 'Not your turn to attack');
                    console.log(`Player ${sanitizedPlayerId} is not attacker`);
                    return;
                }
                if (role === 'defend' && !isDefender) {
                    socket.emit('errorMessage', 'Not your turn to defend');
                    console.log(`Player ${sanitizedPlayerId} is not defender`);
                    return;
                }
                let hand = player.hand ? JSON.parse(player.hand) : [];
                const cardIndex = hand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
                if (cardIndex === -1) {
                    socket.emit('errorMessage', 'Invalid card');
                    console.log(`Invalid card ${JSON.stringify(card)} for player ${sanitizedPlayerId}`);
                    return;
                }
                if (role === 'attack') {
                    if (!isValidAttackCard(card, table, trump) || table.length >= 12) {
                        socket.emit('errorMessage', 'Invalid attack card');
                        console.log(`Invalid attack card ${JSON.stringify(card)}`);
                        return;
                    }
                    table.push({ attack: card, defense: null });
                } else {
                    const lastAttack = table.find(pair => !pair.defense);
                    if (!lastAttack) {
                        socket.emit('errorMessage', 'No attack card to defend');
                        console.log('No attack card to defend');
                        return;
                    }
                    if (!isValidDefenseCard(card, lastAttack.attack, trump)) {
                        socket.emit('errorMessage', 'Invalid defense card');
                        console.log(`Invalid defense card ${JSON.stringify(card)}`);
                        return;
                    }
                    lastAttack.defense = card;
                }
                hand.splice(cardIndex, 1);
                db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(hand), sanitizedPlayerId], err => {
                    if (err) {
                        console.error('Error updating player hand:', err.message);
                    }
                });
                db.run('UPDATE rooms SET gameTable = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(table), Date.now(), sanitizedRoomId], err => {
                    if (err) {
                        console.error('Error updating game table:', err.message);
                    }
                });
                logPlayerAction(sanitizedRoomId, sanitizedPlayerId, role, card);
                updateGameState(sanitizedRoomId);
                checkGameEnd(sanitizedRoomId);
                console.log(`Player ${sanitizedPlayerName} played card ${JSON.stringify(card)} as ${role} in room ${sanitizedRoomId}`);
            });
        });
    });

    socket.on('endTurn', ({ roomId, playerId, playerName }) => {
        const sanitizedRoomId = sanitizeInput(roomId);
        const sanitizedPlayerName = sanitizeInput(playerName);
        const sanitizedPlayerId = sanitizeInput(playerId);
        db.get('SELECT gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = ?', [sanitizedRoomId], (err, row) => {
            if (err || !row) {
                socket.emit('errorMessage', 'Game room does not exist');
                console.log(`Room ${sanitizedRoomId} not found for endTurn`);
                return;
            }
            if (row.gameEnded) {
                socket.emit('errorMessage', 'Game has ended');
                console.log(`Game in room ${sanitizedRoomId} has ended`);
                return;
            }
            let table = row.gameTable ? JSON.parse(row.gameTable) : [];
            db.get('SELECT isDisconnected, socketIds FROM players WHERE roomId = ? AND playerId = ?', [sanitizedRoomId, sanitizedPlayerId], (err, player) => {
                if (err || !player) {
                    socket.emit('errorMessage', 'Player not found');
                    console.log(`Player ${sanitizedPlayerId} not found`);
                    return;
                }
                if (player.isDisconnected) {
                    socket.emit('errorMessage', 'Cannot end turn while disconnected');
                    console.log(`Player ${sanitizedPlayerId} is disconnected`);
                    return;
                }
                if (sanitizedPlayerId !== row.currentDefender) {
                    socket.emit('errorMessage', 'Only defender can end turn');
                    console.log(`Player ${sanitizedPlayerId} is not defender`);
                    return;
                }
                const hasUndefended = table.some(pair => pair.attack && !pair.defense);
                if (hasUndefended) {
                    db.all('SELECT playerId, name, hand, isDisconnected, socketIds FROM players WHERE roomId = ?', [sanitizedRoomId], (err, players) => {
                        if (err) {
                            socket.emit('errorMessage', 'Server error');
                            console.error('Error fetching players:', err.message);
                            return;
                        }
                        const defender = players.find(p => p.playerId === row.currentDefender);
                        if (!defender) {
                            socket.emit('errorMessage', 'Defender not found');
                            console.log(`Defender not found in room ${sanitizedRoomId}`);
                            return;
                        }
                        let defenderHand = defender.hand ? JSON.parse(defender.hand) : [];
                        table.forEach(pair => {
                            if (pair.attack) defenderHand.push(pair.attack);
                            if (pair.defense) defenderHand.push(pair.defense);
                        });
                        db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(defenderHand), defender.playerId], err => {
                            if (err) {
                                console.error('Error updating defender hand:', err.message);
                            }
                        });
                        table = [];
                        db.run('UPDATE rooms SET gameTable = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(table), Date.now(), sanitizedRoomId], err => {
                            if (err) {
                                console.error('Error updating game table:', err.message);
                            }
                        });
                        logPlayerAction(sanitizedRoomId, sanitizedPlayerId, 'endTurnFailed');
                        const activePlayers = players.filter(p => !p.isDisconnected);
                        if (activePlayers.length < 2) {
                            handleSinglePlayerGame(sanitizedRoomId);
                            return;
                        }
                        const playerIds = activePlayers.map(p => p.playerId);
                        const currentDefenderIndex = playerIds.indexOf(row.currentDefender);
                        const nextAttackerIndex = (currentDefenderIndex + 1) % playerIds.length;
                        const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                        const newAttacker = playerIds[nextAttackerIndex];
                        const newDefender = playerIds[nextDefenderIndex] || playerIds[0];
                        drawCards(sanitizedRoomId, [newAttacker, newDefender], () => {
                            db.run(
                                'UPDATE rooms SET currentAttacker = ?, currentDefender = ?, lastActivity = ? WHERE roomId = ?',
                                [newAttacker, newDefender, Date.now(), sanitizedRoomId],
                                err => {
                                    if (err) {
                                        socket.emit('errorMessage', 'Server error');
                                        console.error('Error updating turn:', err.message);
                                    }
                                    updateGameState(sanitizedRoomId);
                                    checkGameEnd(sanitizedRoomId);
                                    startTurnTimer(sanitizedRoomId);
                                    console.log(`Player ${sanitizedPlayerName} ended turn (failed defense) in room ${sanitizedRoomId}`);
                                }
                            );
                        });
                    });
                } else {
                    table = [];
                    db.run('UPDATE rooms SET gameTable = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(table), Date.now(), sanitizedRoomId], err => {
                        if (err) {
                            console.error('Error updating game table:', err.message);
                        }
                    });
                    logPlayerAction(sanitizedRoomId, sanitizedPlayerId, 'endTurnSuccess');
                    db.all('SELECT playerId, name, isDisconnected FROM players WHERE roomId = ?', [sanitizedRoomId], (err, players) => {
                        if (err) {
                            socket.emit('errorMessage', 'Server error');
                            console.error('Error fetching players:', err.message);
                            return;
                        }
                        const activePlayers = players.filter(p => !p.isDisconnected);
                        if (activePlayers.length < 2) {
                            handleSinglePlayerGame(sanitizedRoomId);
                            return;
                        }
                        const playerIds = activePlayers.map(p => p.playerId);
                        const currentDefenderIndex = playerIds.indexOf(row.currentDefender);
                        const nextAttackerIndex = (currentDefenderIndex + 1) % playerIds.length;
                        const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                        const newAttacker = playerIds[nextAttackerIndex];
                        const newDefender = playerIds[nextDefenderIndex] || playerIds[0];
                        drawCards(sanitizedRoomId, [newAttacker, newDefender], () => {
                            db.run(
                                'UPDATE rooms SET currentAttacker = ?, currentDefender = ?, lastActivity = ? WHERE roomId = ?',
                                [newAttacker, newDefender, Date.now(), sanitizedRoomId],
                                err => {
                                    if (err) {
                                        socket.emit('errorMessage', 'Server error');
                                        console.error('Error updating turn:', err.message);
                                    }
                                    updateGameState(sanitizedRoomId);
                                    checkGameEnd(sanitizedRoomId);
                                    startTurnTimer(sanitizedRoomId);
                                    console.log(`Player ${sanitizedPlayerName} ended turn (successful defense) in room ${sanitizedRoomId}`);
                                }
                            );
                        });
                    });
                }
            });
        });
    });

    socket.on('chatMessage', ({ roomId, playerName, message }) => {
        const sanitizedRoomId = sanitizeInput(roomId);
        const sanitizedPlayerName = sanitizeInput(playerName);
        const sanitizedMessage = sanitizeInput(message ? message.trim().slice(0, 200) : '');
        io.to(sanitizedRoomId).emit('chatMessage', { playerName: sanitizedPlayerName, message: sanitizedMessage });
        console.log(`Chat message from ${sanitizedPlayerName} in room ${sanitizedRoomId}: ${sanitizedMessage}`);
    });

    socket.on('tempDisconnect', ({ roomId, playerId, playerName }) => {
        const sanitizedRoomId = sanitizeInput(roomId);
        const sanitizedPlayerName = sanitizeInput(playerName);
        const sanitizedPlayerId = sanitizeInput(playerId);
        db.run(
            'UPDATE players SET isDisconnected = 1, lastDisconnectedAt = ? WHERE roomId = ? AND playerId = ?',
            [Date.now(), sanitizedRoomId, sanitizedPlayerId],
            err => {
                if (err) {
                    console.error('Error marking player as temporarily disconnected:', err.message);
                    return;
                }
                removeSocketId(sanitizedPlayerId, socket.id);
                updateGameState(sanitizedRoomId);
                handleSinglePlayerGame(sanitizedRoomId);
                console.log(`Player ${sanitizedPlayerName} temporarily disconnected from room ${sanitizedRoomId}`);
            }
        );
    });

    socket.on('reconnectPlayer', ({ roomId, playerId, playerName }) => {
        const sanitizedRoomId = sanitizeInput(roomId);
        const sanitizedPlayerName = sanitizeInput(playerName);
        const sanitizedPlayerId = sanitizeInput(playerId);
        db.get('SELECT isDisconnected, language, ready, socketIds, name FROM players WHERE roomId = ? AND playerId = ?', [sanitizedRoomId, sanitizedPlayerId], (err, row) => {
            if (err || !row) {
                socket.emit('errorMessage', 'Player not found');
                console.log(`Player ${sanitizedPlayerId} not found for reconnect`);
                return;
            }
            if (row.name !== sanitizedPlayerName) {
                socket.emit('errorMessage', 'Name mismatch');
                console.log(`Name mismatch for reconnect: ${row.name} vs ${sanitizedPlayerName}`);
                return;
            }
            db.run(
                'UPDATE players SET isDisconnected = 0, lastDisconnectedAt = NULL WHERE roomId = ? AND playerId = ?',
                [sanitizedRoomId, sanitizedPlayerId],
                err => {
                    if (err) {
                        socket.emit('errorMessage', 'Server error');
                        console.error('Error reconnecting player:', err.message);
                        return;
                    }
                    addSocketId(sanitizedPlayerId, socket.id, (err) => {
                        if (err) {
                            socket.emit('errorMessage', 'Server error');
                            console.error('Error adding socketId for reconnect:', err.message);
                            return;
                        }
                        socket.join(sanitizedRoomId);
                        socket.emit('roomJoined', { roomId: sanitizedRoomId, playerId: sanitizedPlayerId, language: row.language, playerName: sanitizedPlayerName });
                        socket.emit('playerStatus', { playerId: sanitizedPlayerId, ready: !!row.ready, isDisconnected: false });
                        io.to(sanitizedRoomId).emit('playerReconnected', { playerName: sanitizedPlayerName });
                        updateRoomState(sanitizedRoomId);
                        db.get('SELECT trump FROM rooms WHERE roomId = ?', [sanitizedRoomId], (err, room) => {
                            if (room && room.trump) {
                                updateGameState(sanitizedRoomId);
                                handleSinglePlayerGame(sanitizedRoomId);
                            }
                        });
                        console.log(`Player ${sanitizedPlayerName} reconnected to room ${sanitizedRoomId}`);
                    });
                }
            );
        });
    });

    socket.on('disconnect', () => {
        db.get('SELECT roomId, playerId, name FROM players WHERE id = ?', [socket.id], (err, player) => {
            if (err || !player) {
                console.log(`No player found for disconnected socket ${socket.id}`);
                return;
            }
            const { roomId, playerId, name } = player;
            removeSocketId(playerId, socket.id, (err) => {
                if (err) {
                    console.error('Error removing socketId on disconnect:', err.message);
                    return;
                }
                db.get('SELECT socketIds FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, row) => {
                    if (err) {
                        console.error('Error fetching socketIds on disconnect:', err.message);
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
                                        console.error('Error checking game state on disconnect:', err?.message);
                                        return;
                                    }
                                    if (row && row.trump) {
                                        updateGameState(roomId);
                                        handleSinglePlayerGame(roomId);
                                    } else {
                                        updateRoomState(roomId);
                                    }
                                    db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId]);
                                });
                            }
                        );
                    }
                });
            });
        });
    });
});

// Запуск сервера
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Application URL: ${APP_URL}`);
});
