// server.js
// Онлайн-игра Durak, адаптированная для SQLite на Render
// Исправлена кнопка "Take Cards", файлы обслуживаются из папки public

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Конфигурация порта, URL и пути к базе данных
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const dbPath = path.join('/tmp', 'durak_game.db');

// Инициализация Express и HTTP-сервера
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type'],
        credentials: true
    }
});

// Инициализация SQLite базы данных
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Ошибка подключения к SQLite:', err.message);
        process.exit(1);
    }
    console.log(`Подключено к базе данных SQLite: ${dbPath}`);
});

// Инициализация схемы базы данных
function initDatabase() {
    return new Promise((resolve, reject) => {
        console.log('Инициализация базы данных SQLite...');
        db.serialize(() => {
            // Удаление существующих таблиц
            db.run('DROP TABLE IF EXISTS players', (err) => {
                if (err) reject(err);
            });
            db.run('DROP TABLE IF EXISTS rooms', (err) => {
                if (err) reject(err);
            });

            // Создание таблицы rooms
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
                    gameEnded BOOLEAN DEFAULT FALSE
                )
            `, (err) => {
                if (err) reject(err);
                else console.log('Таблица rooms создана');
            });

            // Создание таблицы players
            db.run(`
                CREATE TABLE players (
                    id TEXT PRIMARY KEY,
                    roomId TEXT,
                    playerId TEXT UNIQUE,
                    name TEXT,
                    ready BOOLEAN DEFAULT FALSE,
                    hand TEXT,
                    joinedAt INTEGER,
                    isDisconnected BOOLEAN DEFAULT FALSE,
                    lastDisconnectedAt INTEGER,
                    language TEXT DEFAULT 'en',
                    socketIds TEXT DEFAULT '[]',
                    FOREIGN KEY (roomId) REFERENCES rooms (roomId) ON DELETE CASCADE
                )
            `, (err) => {
                if (err) reject(err);
                else console.log('Таблица players создана');
            });

            // Очистка таблиц
            db.run('DELETE FROM rooms', (err) => {
                if (err) reject(err);
            });
            db.run('DELETE FROM players', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    });
}

// Запуск инициализации базы данных
initDatabase().catch(err => {
    console.error('Ошибка инициализации базы данных:', err.message);
    process.exit(1);
});

// Настройка Express для обслуживания статических файлов из папки public
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

// Маршруты для HTML страниц
app.get('/', (req, res) => {
    console.log('Запрос главной страницы');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/room', (req, res) => {
    console.log('Запрос страницы комнаты');
    res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

app.get('/game', (req, res) => {
    console.log('Запрос страницы игры');
    res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

// API для получения состояния комнаты
app.get('/room/:roomId', (req, res) => {
    const roomId = sanitizeInput(req.params.roomId);
    console.log(`HTTP запрос состояния комнаты: roomId=${roomId}`);
    db.all('SELECT name, ready, hand, language, playerId FROM players WHERE roomId = ?', [roomId], (err, players) => {
        if (err) {
            console.error('Ошибка получения игроков:', err.message);
            return res.status(500).json({ error: 'Ошибка сервера' });
        }
        db.get('SELECT roomId, trump, deck, gameTable, currentAttacker, currentDefender FROM rooms WHERE roomId = ?', [roomId], (err, room) => {
            if (err || !room) {
                console.log(`Комната ${roomId} не найдена для HTTP запроса`);
                return res.status(404).json({ error: 'Комната не найдена' });
            }
            const playerNames = players.map(p => p.name);
            const readyCount = players.filter(p => p.ready).length;
            const totalCount = players.length;
            console.log(`HTTP ответ для комнаты ${roomId}: игроки=${playerNames.join(',') || 'нет'}, готовы=${readyCount}/${totalCount}`);
            res.json({
                players: players.map(player => ({
                    name: player.name,
                    ready: !!player.ready,
                    hand: player.hand ? JSON.parse(player.hand) : [],
                    language: player.language,
                    playerId: player.playerId
                })),
                readyCount,
                totalCount,
                trump: room.trump ? JSON.parse(room.trump) : null,
                deckCount: room.deck ? JSON.parse(room.deck).length : 0,
                table: room.gameTable ? JSON.parse(room.gameTable) : [],
                currentAttacker: room.currentAttacker,
                currentDefender: room.currentDefender
            });
        });
    });
});

// Функция очистки ввода
function sanitizeInput(input) {
    if (typeof input !== 'string') return '';
    return input.replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 50);
}

// Очистка языкового ввода
function sanitizeLanguage(lang) {
    const validLanguages = ['en', 'ru', 'uk'];
    return validLanguages.includes(lang) ? lang : 'en';
}

// Генерация 4-значного кода комнаты
async function generateRoomCode() {
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    return new Promise((resolve, reject) => {
        db.get('SELECT roomId FROM rooms WHERE roomId = ?', [code], (err, row) => {
            if (err) reject(err);
            if (row) resolve(generateRoomCode());
            else {
                console.log(`Сгенерирован код комнаты: ${code}`);
                resolve(code);
            }
        });
    });
}

// Управление socketIds для игроков
async function addSocketId(playerId, socketId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT socketIds FROM players WHERE playerId = ?', [playerId], (err, row) => {
            if (err) return reject(err);
            let socketIds = row?.socketIds ? JSON.parse(row.socketIds) : [];
            
            socketIds.forEach(id => {
                if (id !== socketId && io.sockets.sockets.get(id)) {
                    console.log(`Отключение старого сокета ${id} для playerId ${playerId}`);
                    io.to(id).emit('errorMessage', 'Другая сессия взяла управление этим игроком');
                    io.sockets.sockets.get(id)?.disconnect(true);
                }
            });

            socketIds = socketIds.filter(id => id === socketId || io.sockets.sockets.get(id));
            if (!socketIds.includes(socketId)) {
                socketIds.push(socketId);
            }

            db.run('UPDATE players SET socketIds = ? WHERE playerId = ?', [JSON.stringify(socketIds), playerId], (err) => {
                if (err) reject(err);
                else {
                    console.log(`Добавлен socketId ${socketId} для playerId ${playerId}`);
                    resolve();
                }
            });
        });
    });
}

async function removeSocketId(playerId, socketId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT socketIds FROM players WHERE playerId = ?', [playerId], (err, row) => {
            if (err) return reject(err);
            let socketIds = row?.socketIds ? JSON.parse(row.socketIds) : [];
            socketIds = socketIds.filter(id => id !== socketId);
            db.run('UPDATE players SET socketIds = ? WHERE playerId = ?', [JSON.stringify(socketIds), playerId], (err) => {
                if (err) reject(err);
                else {
                    console.log(`Удален socketId ${socketId} для playerId ${playerId}`);
                    resolve();
                }
            });
        });
    });
}

// Очистка дубликатов игроков
async function cleanDuplicatePlayers(roomId, playerName, socketId, playerId) {
    return new Promise((resolve, reject) => {
        db.all('SELECT playerId, id, socketIds FROM players WHERE roomId = ? AND name = ? AND playerId != ?', [roomId, playerName, playerId], (err, rows) => {
            if (err) return reject(err);
            console.log(`Очистка дубликатов для ${playerName} в комнате ${roomId}, socket=${socketId}, playerId=${playerId}, найдено дубликатов: ${rows.length}`);
            if (rows.length === 0) return resolve();
            const deletions = rows.map(row => {
                return new Promise((delResolve, delReject) => {
                    db.run('DELETE FROM players WHERE roomId = ? AND playerId = ?', [roomId, row.playerId], (err) => {
                        if (err) delReject(err);
                        else {
                            console.log(`Удален дубликат игрока ${playerName} с playerId ${row.playerId} из комнаты ${roomId}`);
                            delResolve();
                        }
                    });
                });
            });
            Promise.all(deletions).then(resolve).catch(reject);
        });
    });
}

// Ограничение присоединения игрока
async function restrictPlayerJoin(roomId, playerName, playerId, socketId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT playerId, isDisconnected, socketIds FROM players WHERE roomId = ? AND name = ? AND playerId != ?', [roomId, playerName, playerId], (err, row) => {
            if (err) return reject(err);
            if (row && !row.isDisconnected) {
                const socketIds = row.socketIds ? JSON.parse(row.socketIds) : [];
                if (socketIds.some(id => io.sockets.sockets.get(id))) {
                    console.log(`Игрок ${playerName} уже активен в комнате ${roomId} с другим playerId ${row.playerId}, блокировка присоединения`);
                    resolve(false);
                } else {
                    resolve(true);
                }
            } else {
                resolve(true);
            }
        });
    });
}

// Обработка игры с одним игроком
async function handleSinglePlayerGame(roomId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT trump, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, room) => {
            if (err) return reject(err);
            if (!room || !room.trump || room.gameEnded) {
                console.log(`Комната ${roomId} неактивна или игра завершена`);
                return resolve();
            }
            db.all('SELECT DISTINCT playerId, name FROM players WHERE roomId = ? AND isDisconnected = FALSE', [roomId], (err, players) => {
                if (err) return reject(err);
                if (players.length === 1) {
                    const winner = players[0];
                    console.log(`Объявление ${winner.name} победителем в комнате ${roomId} из-за единственного активного игрока`);
                    db.run('UPDATE rooms SET gameEnded = TRUE WHERE roomId = ?', [roomId], (err) => {
                        if (err) return reject(err);
                        io.to(roomId).emit('gameOver', { winners: [winner.name] });
                        deleteRoom(roomId).then(resolve).catch(reject);
                    });
                } else {
                    resolve();
                }
            });
        });
    });
}

// Создание колоды карт
function createDeck() {
    const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
    const ranks = ['6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
    const deck = [];
    for (const suit of suits) {
        for (const rank of ranks) {
            deck.push({ rank, suit });
        }
    }
    console.log(`Создана колода: ${deck.length} карт`);
    return deck;
}

// Перемешивание колоды
function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    console.log('Колода перемешана');
}

// Поиск наименьшей козырной карты
function findLowestTrumpCard(players, trumpSuit) {
    const rankOrder = ['6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
    let lowestTrumpCard = null;
    let firstAttacker = null;

    for (const player of players) {
        const hand = player.hand ? JSON.parse(player.hand) : [];
        const trumpCards = hand.filter(card => card.suit === trumpSuit);
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
    }

    console.log(`Найдена наименьшая козырная карта: ${lowestTrumpCard ? `${lowestTrumpCard.rank} of ${lowestTrumpCard.suit}` : 'нет'}, атакующий: ${firstAttacker || 'не определен'}`);
    return { lowestTrumpCard, firstAttacker };
}

// Запуск таймера хода
function startTurnTimer(roomId) {
    clearTurnTimer(roomId);
    const timer = setTimeout(async () => {
        try {
            db.get('SELECT currentDefender, gameEnded FROM rooms WHERE roomId = ?', [roomId], async (err, room) => {
                if (err || !room) {
                    console.error(`Комната ${roomId} не найдена для таймера`);
                    return;
                }
                if (room.gameEnded) {
                    console.log(`Комната ${roomId} завершена, пропуск действия таймера`);
                    return;
                }
                db.all('SELECT DISTINCT playerId FROM players WHERE roomId = ? AND isDisconnected = FALSE', [roomId], async (err, players) => {
                    if (err) {
                        console.error('Ошибка получения игроков:', err.message);
                        return;
                    }
                    if (players.length < 2) {
                        await handleSinglePlayerGame(roomId);
                        return;
                    }
                    const playerIds = players.map(p => p.playerId);
                    const currentIndex = playerIds.indexOf(room.currentDefender);
                    const nextAttackerIndex = (currentIndex + 1) % playerIds.length;
                    const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                    const newAttacker = playerIds[nextAttackerIndex];
                    const newDefender = playerIds[nextDefenderIndex] || playerIds[0];

                    db.run('UPDATE rooms SET gameTable = ?, currentAttacker = ?, currentDefender = ?, lastActivity = ? WHERE roomId = ?', 
                        [JSON.stringify([]), newAttacker, newDefender, Date.now(), roomId], (err) => {
                            if (err) {
                                console.error('Ошибка обновления хода:', err.message);
                                return;
                            }
                            console.log(`Время хода истекло в комнате ${roomId}, новый атакующий: ${newAttacker}, новый защитник: ${newDefender}`);
                            io.to(roomId).emit('errorMessage', 'Время хода истекло');
                            updateGameState(roomId);
                            startTurnTimer(roomId);
                        });
                });
            });
        } catch (err) {
            console.error('Ошибка обновления хода по таймеру:', err.message);
        }
    }, 30000);

    io.to(roomId).emit('startTimer', { duration: 30000 });
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room) {
        room.timer = timer;
        console.log(`Таймер установлен для комнаты ${roomId}`);
    }
}

// Очистка таймера хода
function clearTurnTimer(roomId) {
    const room = io.sockets.adapter.rooms.get(roomId);
    if (room && room.timer) {
        clearTimeout(room.timer);
        delete room.timer;
        console.log(`Таймер очищен для комнаты ${roomId}`);
    }
}

// Обновление состояния комнаты
async function updateRoomState(roomId) {
    return new Promise((resolve, reject) => {
        db.all('SELECT name, ready, isDisconnected, language, playerId, id, socketIds FROM players WHERE roomId = ?', [roomId], (err, players) => {
            if (err) return reject(err);
            const readyCount = players.filter(p => p.ready).length;
            const totalCount = players.length;
            const activeCount = players.filter(p => !p.isDisconnected).length;

            db.run('UPDATE rooms SET activePlayers = ? WHERE roomId = ?', [activeCount, roomId], (err) => {
                if (err) return reject(err);
                console.log(`Обновление комнаты ${roomId}: игроки=${players.map(p => p.name).join(',') || 'нет'}, готовы=${readyCount}/${totalCount}, активны=${activeCount}`);
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
                resolve();
            });
        });
    });
}

// Обновление состояния игры
async function updateGameState(roomId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT trump, deck, gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, room) => {
            if (err || !room) {
                console.log(`Комната ${roomId} не найдена для состояния игры`);
                io.to(roomId).emit('errorMessage', 'Комната игры не существует');
                return reject(err || new Error('Комната не найдена'));
            }
            if (room.gameEnded) {
                console.log(`Комната ${roomId} завершена, пропуск обновления состояния игры`);
                return resolve();
            }

            db.all('SELECT id, name, hand, playerId, isDisconnected, language, socketIds FROM players WHERE roomId = ?', [roomId], (err, players) => {
                if (err) return reject(err);
                const activePlayers = players.filter(p => !p.isDisconnected);

                db.run('UPDATE rooms SET activePlayers = ? WHERE roomId = ?', [activePlayers.length, roomId], async (err) => {
                    if (err) return reject(err);

                    if (activePlayers.length < 2 && room.trump) {
                        await handleSinglePlayerGame(roomId);
                        return resolve();
                    }

                    const table = room.gameTable ? JSON.parse(room.gameTable) : [];
                    const canTakeCards = table.some(pair => pair.attack && !pair.defense);

                    const gameState = {
                        players: players.map(player => ({
                            id: player.playerId,
                            name: player.name,
                            hand: player.hand ? JSON.parse(player.hand) : [],
                            isDisconnected: !!player.isDisconnected,
                            language: player.language
                        })),
                        trump: room.trump ? JSON.parse(room.trump) : null,
                        deckCount: room.deck ? JSON.parse(room.deck).length : 0,
                        table,
                        currentAttacker: room.currentAttacker,
                        currentDefender: room.currentDefender,
                        canTakeCards
                    };

                    console.log(`Обновление игры ${roomId}: игроки=${players.map(p => p.name).join(',') || 'нет'}, козырь=${JSON.stringify(gameState.trump)}, колода=${gameState.deckCount}, стол=${JSON.stringify(gameState.table)}, атакующий=${room.currentAttacker}, защитник=${room.currentDefender}, canTakeCards=${canTakeCards}`);

                    players.forEach(player => {
                        const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
                        socketIds.forEach(socketId => {
                            io.to(socketId).emit('updateGame', gameState);
                        });
                    });

                    await checkGameEnd(roomId);
                    db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            });
        });
    });
}

// Запуск игры
async function startGame(roomId) {
    console.log(`Попытка запустить игру в комнате ${roomId}`);
    return new Promise((resolve, reject) => {
        db.get('SELECT trump, gameEnded FROM rooms WHERE roomId = ?', [roomId], async (err, room) => {
            if (err) return reject(err);
            if (room?.trump) {
                console.log(`Игра уже начата в комнате ${roomId}, обновление состояния`);
                await updateGameState(roomId);
                return resolve();
            }
            if (room?.gameEnded) {
                console.log(`Игра в комнате ${roomId} завершена, запуск невозможен`);
                io.to(roomId).emit('errorMessage', 'Игра завершена');
                return resolve();
            }

            db.all('SELECT id, playerId, name, ready, isDisconnected, socketIds, hand FROM players WHERE roomId = ?', [roomId], async (err, players) => {
                if (err) return reject(err);
                const activePlayers = players.filter(p => !p.isDisconnected);

                if (activePlayers.length < 2) {
                    console.log(`Недостаточно активных игроков для старта игры в комнате ${roomId}: ${activePlayers.length}`);
                    io.to(roomId).emit('errorMessage', 'Для начала игры требуется минимум 2 игрока');
                    return resolve();
                }

                const readyCount = activePlayers.filter(p => p.ready).length;
                if (readyCount !== activePlayers.length) {
                    console.log(`Не все активные игроки готовы в комнате ${roomId}: ${readyCount}/${activePlayers.length}`);
                    io.to(roomId).emit('errorMessage', 'Все активные игроки должны быть готовы для начала игры');
                    return resolve();
                }

                const deck = createDeck();
                shuffleDeck(deck);

                const trumpCard = deck[Math.floor(Math.random() * deck.length)];
                const trump = { card: trumpCard, suit: trumpCard.suit };
                deck.splice(deck.indexOf(trumpCard), 1);
                deck.push(trumpCard);

                for (const player of activePlayers) {
                    const hand = deck.splice(0, 6);
                    db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(hand), player.playerId], (err) => {
                        if (err) reject(err);
                        else console.log(`Карты розданы игроку ${player.name} в комнате ${roomId}: ${hand.length} карт`);
                    });
                }

                const { lowestTrumpCard, firstAttacker } = findLowestTrumpCard(activePlayers, trump.suit);
                let currentAttacker, currentDefender;

                if (firstAttacker) {
                    console.log(`Первый атакующий в комнате ${roomId}: playerId=${firstAttacker}, наименьшая козырная карта=${lowestTrumpCard.rank} of ${lowestTrumpCard.suit}`);
                    currentAttacker = firstAttacker;
                    const activePlayerIds = activePlayers.map(p => p.playerId);
                    const attackerIndex = activePlayerIds.indexOf(firstAttacker);
                    const defenderIndex = (attackerIndex + 1) % activePlayerIds.length;
                    currentDefender = activePlayerIds[defenderIndex];
                } else {
                    console.log(`Козырные карты не найдены в комнате ${roomId}, выбор случайного атакующего`);
                    const activePlayerIds = activePlayers.map(p => p.playerId);
                    currentAttacker = activePlayerIds[0];
                    currentDefender = activePlayerIds[1];
                }

                db.run(
                    'UPDATE rooms SET trump = ?, deck = ?, gameTable = ?, currentAttacker = ?, currentDefender = ?, lastActivity = ?, activePlayers = ?, gameEnded = FALSE WHERE roomId = ?',
                    [JSON.stringify(trump), JSON.stringify(deck), JSON.stringify([]), currentAttacker, currentDefender, Date.now(), activePlayers.length, roomId],
                    (err) => {
                        if (err) return reject(err);
                        console.log(`Игра начата в комнате ${roomId}, козырь: ${JSON.stringify(trump)}, атакующий: ${currentAttacker}, защитник: ${currentDefender}, колода: ${deck.length} карт`);
                        io.to(roomId).emit('startGame', { trump, currentAttacker, currentDefender });
                        updateGameState(roomId);
                        startTurnTimer(roomId);
                        resolve();
                    }
                );
            });
        });
    });
}

// Валидация карты для атаки
function isValidAttackCard(card, table, trump) {
    if (!table.length) return true;
    const valid = table.some(pair => pair.attack.rank === card.rank);
    console.log(`Валидация карты атаки ${card.rank} of ${card.suit}: ${valid}`);
    return valid;
}

// Валидация карты для защиты
function isValidDefenseCard(defenseCard, attackCard, trump) {
    const rankOrder = ['6', '7', '8', '9', '10', 'Jack', 'Queen', 'King', 'Ace'];
    if (defenseCard.suit === attackCard.suit) {
        const result = rankOrder.indexOf(defenseCard.rank) > rankOrder.indexOf(attackCard.rank);
        console.log(`Валидация карты защиты ${defenseCard.rank} of ${defenseCard.suit} против ${attackCard.rank} of ${attackCard.suit}: ${result}`);
        return result;
    }
    const result = defenseCard.suit === trump;
    console.log(`Валидация карты защиты ${defenseCard.rank} of ${defenseCard.suit} как козырь против ${attackCard.rank} of ${attackCard.suit}: ${result}`);
    return result;
}

// Раздача карт игрокам
async function drawCards(roomId, playerIds) {
    return new Promise((resolve, reject) => {
        db.get('SELECT deck, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, room) => {
            if (err || !room) {
                console.log(`Комната ${roomId} не существует для раздачи карт`);
                return reject(err || new Error('Комната не найдена'));
            }
            if (room.gameEnded) {
                console.log(`Комната ${roomId} завершена, пропуск раздачи карт`);
                return resolve();
            }

            let deck = room.deck ? JSON.parse(room.deck) : [];
            const updates = playerIds.map(playerId => {
                return new Promise((res, rej) => {
                    db.get('SELECT hand, isDisconnected FROM players WHERE playerId = ?', [playerId], (err, player) => {
                        if (err) return rej(err);
                        if (player.isDisconnected) {
                            console.log(`Игрок ${playerId} отключен, пропуск раздачи карт`);
                            return res();
                        }
                        let hand = player.hand ? JSON.parse(player.hand) : [];
                        while (hand.length < 6 && deck.length > 0) {
                            hand.push(deck.shift());
                        }
                        db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(hand), playerId], (err) => {
                            if (err) rej(err);
                            else {
                                console.log(`Игроку ${playerId} роздано карт: ${hand.length}`);
                                res();
                            }
                        });
                    });
                });
            });

            Promise.all(updates).then(() => {
                db.run('UPDATE rooms SET deck = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(deck), Date.now(), roomId], (err) => {
                    if (err) reject(err);
                    else {
                        console.log(`Колода обновлена в комнате ${roomId}: ${deck.length} карт`);
                        resolve();
                    }
                });
            }).catch(reject);
        });
    });
}

// Проверка окончания игры
async function checkGameEnd(roomId) {
    return new Promise((resolve, reject) => {
        db.get('SELECT deck, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, room) => {
            if (err || !room) {
                console.log(`Комната ${roomId} не найдена для проверки окончания игры`);
                return reject(err || new Error('Комната не найдена'));
            }
            if (room.gameEnded) {
                console.log(`Комната ${roomId} уже завершена, пропуск проверки окончания игры`);
                return resolve();
            }

            const deck = room.deck ? JSON.parse(room.deck) : [];
            db.all('SELECT playerId, name, hand, isDisconnected FROM players WHERE roomId = ?', [roomId], (err, players) => {
                if (err) return reject(err);
                const activePlayers = players.filter(p => !p.isDisconnected);

                if (activePlayers.length < 2) {
                    handleSinglePlayerGame(roomId).then(resolve).catch(reject);
                    return;
                }

                const winners = activePlayers.filter(p => (JSON.parse(p.hand || '[]')).length === 0);
                if (deck.length === 0 && winners.length > 0) {
                    const winnerNames = winners.map(p => p.name).join(', ');
                    console.log(`Игра завершена в комнате ${roomId}: Победители: ${winnerNames}`);
                    db.run('UPDATE rooms SET gameEnded = TRUE WHERE roomId = ?', [roomId], (err) => {
                        if (err) return reject(err);
                        io.to(roomId).emit('gameOver', { winners: winners.map(p => p.name) });
                        deleteRoom(roomId).then(resolve).catch(reject);
                    });
                } else {
                    resolve();
                }
            });
        });
    });
}

// Удаление комнаты
async function deleteRoom(roomId) {
    clearTurnTimer(roomId);
    return new Promise((resolve, reject) => {
        db.run('UPDATE rooms SET gameEnded = TRUE WHERE roomId = ?', [roomId], (err) => {
            if (err) return reject(err);
            db.run('DELETE FROM players WHERE roomId = ?', [roomId], (err) => {
                if (err) return reject(err);
                db.run('DELETE FROM rooms WHERE roomId = ?', [roomId], (err) => {
                    if (err) return reject(err);
                    console.log(`Комната ${roomId} удалена после окончания игры`);
                    io.to(roomId).emit('roomDeleted', 'Игра завершена, комната удалена');
                    resolve();
                });
            });
        });
    });
}

// Обработчики Socket.io
io.on('connection', (socket) => {
    console.log(`Новое подключение: socketId=${socket.id}`);

    socket.on('createRoom', async (data) => {
        let playerName, playerId, language;
        if (typeof data === 'string') {
            playerName = data;
            playerId = uuidv4();
            language = 'en';
            console.log(`Получен старый формат createRoom: playerName=${playerName}`);
        } else if (typeof data === 'object' && data.playerName && data.playerName.trim()) {
            playerName = data.playerName;
            playerId = data.playerId || uuidv4();
            language = sanitizeLanguage(data.language || 'en');
        } else {
            console.error('Неверные данные createRoom:', data);
            socket.emit('errorMessage', 'Неверные данные');
            return;
        }

        playerName = sanitizeInput(playerName ? playerName.trim() : '');
        playerId = sanitizeInput(playerId);
        console.log(`Запрос на создание комнаты: player=${playerName}, playerId=${playerId}, language=${language}, socket=${socket.id}`);

        if (!playerName || playerName === 'undefined') {
            socket.emit('errorMessage', 'Введите корректное имя');
            socket.emit('setPlayerId', playerId);
            return;
        }

        try {
            const existingPlayer = await new Promise((resolve, reject) => {
                db.get('SELECT playerId FROM players WHERE playerId = ?', [playerId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            if (existingPlayer) {
                playerId = uuidv4();
                socket.emit('setPlayerId', playerId);
                console.log(`Обнаружен дубликат playerId, назначен новый: ${playerId}`);
            }

            const roomId = await generateRoomCode();
            await new Promise((resolve, reject) => {
                db.run('INSERT INTO rooms (roomId, createdAt, lastActivity, gameEnded) VALUES (?, ?, ?, ?)', 
                    [roomId, Date.now(), Date.now(), false], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
            });

            await new Promise((resolve, reject) => {
                db.run('DELETE FROM players WHERE id = ?', [socket.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            await cleanDuplicatePlayers(roomId, playerName, socket.id, playerId);

            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO players (id, roomId, playerId, name, ready, joinedAt, isDisconnected, language, socketIds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [socket.id, roomId, playerId, playerName, false, Date.now(), false, language, JSON.stringify([socket.id])],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            console.log(`Комната ${roomId} создана, игрок ${playerName} добавлен с playerId ${playerId}, language=${language}, socket=${socket.id}`);
            socket.join(roomId);
            socket.emit('roomCreated', { roomId, playerId, language, playerName });
            socket.emit('roomJoined', { roomId, playerId, language, playerName });
            socket.emit('playerStatus', { playerId, ready: false, isDisconnected: false });
            await updateRoomState(roomId);
        } catch (err) {
            console.error('Ошибка создания комнаты:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
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
            console.error('Неверные данные joinRoom:', data);
            socket.emit('errorMessage', 'Неверные данные');
            return;
        }

        roomId = sanitizeInput(roomId ? roomId.trim().toLowerCase() : '');
        playerName = sanitizeInput(playerName ? playerName.trim() : '');
        playerId = sanitizeInput(playerId);
        console.log(`Запрос на присоединение к комнате: roomId=${roomId}, player=${playerName}, playerId=${playerId}, language=${language}, socket=${socket.id}`);

        if (!roomId || !playerName || playerName === 'undefined') {
            socket.emit('errorMessage', 'Неверный ID комнаты или имя');
            socket.emit('setPlayerId', playerId);
            return;
        }

        try {
            const room = await new Promise((resolve, reject) => {
                db.get('SELECT roomId FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            if (!room) {
                socket.emit('errorMessage', 'Комната не существует');
                socket.emit('setPlayerId', playerId);
                return;
            }

            const player = await new Promise((resolve, reject) => {
                db.get('SELECT name, playerId, id, isDisconnected, hand, lastDisconnectedAt, language, ready, socketIds FROM players WHERE roomId = ? AND playerId = ?', 
                    [roomId, playerId], (err, row) => {
                        if (err) reject(err);
                        resolve(row);
                    });
            });

            if (player) {
                if (player.name !== playerName) {
                    socket.emit('errorMessage', 'Несоответствие имени игрока для данного ID');
                    return;
                }
                if (!player.isDisconnected) {
                    await addSocketId(playerId, socket.id);
                    console.log(`Игрок ${playerName} добавил сокет ${socket.id} к существующему playerId ${playerId} в комнате ${roomId}`);
                    socket.join(roomId);
                    socket.emit('roomJoined', { roomId, playerId, language: player.language, playerName });
                    socket.emit('playerStatus', { playerId, ready: !!player.ready, isDisconnected: false });
                    await updateRoomState(roomId);
                    const gameRoom = await new Promise((resolve, reject) => {
                        db.get('SELECT trump FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
                            if (err) reject(err);
                            resolve(row);
                        });
                    });
                    if (gameRoom?.trump) {
                        await updateGameState(roomId);
                    }
                    return;
                } else {
                    await new Promise((resolve, reject) => {
                        db.run(
                            'UPDATE players SET id = ?, isDisconnected = FALSE, lastDisconnectedAt = NULL, language = ?, socketIds = ? WHERE roomId = ? AND playerId = ?',
                            [socket.id, language, JSON.stringify([socket.id]), roomId, playerId],
                            (err) => {
                                if (err) reject(err);
                                else resolve();
                            }
                        );
                    });
                    console.log(`Игрок ${playerName} переподключился к комнате ${roomId}, playerId: ${playerId}, socket: ${socket.id}`);
                    socket.join(roomId);
                    socket.emit('roomJoined', { roomId, playerId, language: player.language, playerName });
                    socket.emit('playerStatus', { playerId, ready: !!player.ready, isDisconnected: false });
                    io.to(roomId).emit('playerReconnected', { playerName });
                    await updateRoomState(roomId);
                    const gameRoom = await new Promise((resolve, reject) => {
                        db.get('SELECT trump FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
                            if (err) reject(err);
                            resolve(row);
                        });
                    });
                    if (gameRoom?.trump) {
                        await updateGameState(roomId);
                    }
                    return;
                }
            }

            const canJoin = await restrictPlayerJoin(roomId, playerName, playerId, socket.id);
            if (!canJoin) {
                socket.emit('errorMessage', 'Игрок с таким именем уже активен с другим ID');
                return;
            }

            await cleanDuplicatePlayers(roomId, playerName, socket.id, playerId);
            await new Promise((resolve, reject) => {
                db.run('DELETE FROM players WHERE id = ?', [socket.id], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            const playerCount = await new Promise((resolve, reject) => {
                db.get('SELECT COUNT(*) as count FROM players WHERE roomId = ?', [roomId], (err, row) => {
                    if (err) reject(err);
                    resolve(row.count);
                });
            });
            if (playerCount >= 6) {
                socket.emit('errorMessage', 'Комната заполнена');
                socket.emit('setPlayerId', playerId);
                return;
            }

            socket.join(roomId);
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO players (id, roomId, playerId, name, ready, joinedAt, isDisconnected, language, socketIds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [socket.id, roomId, playerId, playerName, false, Date.now(), false, language, JSON.stringify([socket.id])],
                    (err) => {
                        if (err) reject(err);
                        else resolve();
                    }
                );
            });

            console.log(`Игрок ${playerName} присоединился к комнате ${roomId} с playerId ${playerId}, language=${language}, socket=${socket.id}`);
            socket.emit('roomJoined', { roomId, playerId, language, playerName });
            socket.emit('playerStatus', { playerId, ready: false, isDisconnected: false });
            await updateRoomState(roomId);
            await new Promise((resolve, reject) => {
                db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        } catch (err) {
            console.error('Ошибка присоединения к комнате:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('takeCards', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок ${playerName} запросил взять карты в комнате ${roomId}, playerId: ${playerId}`);

        try {
            const room = await new Promise((resolve, reject) => {
                db.get('SELECT gameTable, currentDefender, deck, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            if (!room) {
                console.log(`Комната ${roomId} не существует или была удалена`);
                socket.emit('errorMessage', 'Комната игры не существует');
                return;
            }
            if (room.gameEnded) {
                console.log(`Комната ${roomId} завершена, отклонение действия takeCards`);
                socket.emit('errorMessage', 'Игра завершена');
                return;
            }
            if (playerId !== room.currentDefender) {
                socket.emit('errorMessage', 'Только защитник может взять карты');
                return;
            }

            let table = room.gameTable ? JSON.parse(room.gameTable) : [];
            let deck = room.deck ? JSON.parse(room.deck) : [];

            if (!table.some(pair => pair.attack && !pair.defense)) {
                socket.emit('errorMessage', 'Нет непобитых карт для взятия');
                return;
            }

            const player = await new Promise((resolve, reject) => {
                db.get('SELECT hand, isDisconnected FROM players WHERE playerId = ?', [playerId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            if (!player) {
                console.error(`Игрок ${playerId} не найден`);
                socket.emit('errorMessage', 'Игрок не найден');
                return;
            }
            if (player.isDisconnected) {
                socket.emit('errorMessage', 'Нельзя взять карты, будучи отключенным');
                return;
            }

            let defenderHand = player.hand ? JSON.parse(player.hand) : [];
            table.forEach(pair => {
                if (pair.attack) defenderHand.push(pair.attack);
                if (pair.defense) defenderHand.push(pair.defense);
            });

            await new Promise((resolve, reject) => {
                db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(defenderHand), playerId], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            console.log(`Игрок ${playerName} взял ${table.length} пар карт в комнате ${roomId}`);

            table = [];
            await new Promise((resolve, reject) => {
                db.run('UPDATE rooms SET gameTable = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(table), Date.now(), roomId], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            const players = await new Promise((resolve, reject) => {
                db.all('SELECT playerId, isDisconnected FROM players WHERE roomId = ?', [roomId], (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                });
            });
            const activePlayers = players.filter(p => !p.isDisconnected);

            if (activePlayers.length < 2) {
                await handleSinglePlayerGame(roomId);
                return;
            }

            const playerIds = activePlayers.map(p => p.playerId);
            const currentDefenderIndex = playerIds.indexOf(room.currentDefender);
            const nextAttackerIndex = (currentDefenderIndex + 1) % playerIds.length;
            const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
            const newAttacker = playerIds[nextAttackerIndex];
            const newDefender = playerIds[nextDefenderIndex] || playerIds[0];

            await drawCards(roomId, [newAttacker, newDefender]);
            await new Promise((resolve, reject) => {
                db.run('UPDATE rooms SET currentAttacker = ?, currentDefender = ?, lastActivity = ? WHERE roomId = ?', 
                    [newAttacker, newDefender, Date.now(), roomId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
            });
            console.log(`Ход обновлен в комнате ${roomId}: новый атакующий=${newAttacker}, новый защитник=${newDefender}`);

            await updateGameState(roomId);
            await checkGameEnd(roomId);
            startTurnTimer(roomId);
        } catch (err) {
            console.error('Ошибка взятия карт:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('changeLanguage', async ({ playerId, language }) => {
        language = sanitizeLanguage(language);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок ${playerId} меняет язык на ${language}`);
        try {
            await new Promise((resolve, reject) => {
                db.run('UPDATE players SET language = ? WHERE playerId = ?', [language, playerId], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            const player = await new Promise((resolve, reject) => {
                db.get('SELECT roomId, socketIds FROM players WHERE playerId = ?', [playerId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            if (!player) {
                socket.emit('errorMessage', 'Игрок не найден');
                return;
            }
            console.log(`Язык обновлен для игрока ${playerId} на ${language} в комнате ${player.roomId}`);
            const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
            socketIds.forEach(socketId => {
                io.to(socketId).emit('languageChanged', { language });
            });
            await updateRoomState(player.roomId);
            await updateGameState(player.roomId);
        } catch (err) {
            console.error('Ошибка обновления языка:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера при обновлении языка');
        }
    });

    socket.on('ready', async ({ roomId, playerId }) => {
        roomId = sanitizeInput(roomId);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок готов в комнате ${roomId}, socket: ${socket.id}, playerId: ${playerId}`);
        try {
            const player = await new Promise((resolve, reject) => {
                db.get('SELECT ready, isDisconnected, socketIds FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            if (!player) {
                console.warn(`Игрок ${playerId} не найден в комнате ${roomId}`);
                socket.emit('errorMessage', 'Игрок не найден');
                return;
            }
            if (player.ready) {
                console.log(`Игрок ${playerId} уже готов в комнате ${roomId}, отправка статуса`);
                const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
                socketIds.forEach(socketId => {
                    io.to(socketId).emit('playerStatus', { playerId, ready: true, isDisconnected: false });
                });
                return;
            }

            await new Promise((resolve, reject) => {
                db.run('UPDATE players SET isDisconnected = FALSE, lastDisconnectedAt = NULL, ready = TRUE WHERE roomId = ? AND playerId = ?', 
                    [roomId, playerId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
            });
            const socketIds = player.socketIds ? JSON.parse(player.socketIds) : [];
            socketIds.forEach(socketId => {
                io.to(socketId).emit('playerStatus', { playerId, ready: true, isDisconnected: false });
            });

            const counts = await new Promise((resolve, reject) => {
                db.get('SELECT COUNT(*) as total, SUM(ready) as ready FROM players WHERE roomId = ? AND isDisconnected = FALSE', [roomId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            console.log(`Статус комнаты ${roomId}: ${counts.ready}/${counts.total} готовы`);

            await updateRoomState(roomId);
            await new Promise((resolve, reject) => {
                db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            if (counts.ready >= 2 && counts.ready === counts.total) {
                console.log(`Все игроки готовы в комнате ${roomId}, запуск игры`);
                await startGame(roomId);
            }
        } catch (err) {
            console.error('Ошибка установки статуса готовности:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('requestPlayerUpdate', async (roomId) => {
        roomId = sanitizeInput(roomId);
        console.log(`Запрос обновления игроков для комнаты ${roomId}`);
        try {
            await updateRoomState(roomId);
            await new Promise((resolve, reject) => {
                db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        } catch (err) {
            console.error('Ошибка обновления игроков:', err.message);
        }
    });

    socket.on('leaveRoom', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок ${playerName} запросил выход из комнаты ${roomId}, playerId: ${playerId}`);
        try {
            await removeSocketId(playerId, socket.id);
            const socketIds = await new Promise((resolve, reject) => {
                db.get('SELECT socketIds FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, row) => {
                    if (err) reject(err);
                    resolve(row?.socketIds ? JSON.parse(row.socketIds) : []);
                });
            });
            if (socketIds.length === 0) {
                await new Promise((resolve, reject) => {
                    db.run('DELETE FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                console.log(`Игрок ${playerName} удален из комнаты ${roomId}`);
                socket.leave(roomId);
                await updateRoomState(roomId);
                await new Promise((resolve, reject) => {
                    db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            } else {
                socket.leave(roomId);
                await updateRoomState(roomId);
            }
        } catch (err) {
            console.error('Ошибка выхода из комнаты:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера при выходе из комнаты');
        }
    });

    socket.on('leaveGame', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок ${playerName} запросил выход из игры ${roomId}, playerId: ${playerId}`);
        try {
            await new Promise((resolve, reject) => {
                db.run('UPDATE players SET isDisconnected = TRUE, lastDisconnectedAt = ? WHERE roomId = ? AND playerId = ?', 
                    [Date.now(), roomId, playerId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
            });
            console.log(`Игрок ${playerName} помечен как отключенный в игре ${roomId}`);
            await removeSocketId(playerId, socket.id);
            socket.leave(roomId);
            await updateGameState(roomId);
            await handleSinglePlayerGame(roomId);
            await new Promise((resolve, reject) => {
                db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        } catch (err) {
            console.error('Ошибка выхода из игры:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера при выходе из игры');
        }
    });

    socket.on('playCard', async ({ roomId, playerName, playerId, card, role }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок ${playerName} (${role}) сыграл карту ${card.rank} of ${card.suit} в комнате ${roomId}, socket=${socket.id}`);
        try {
            const room = await new Promise((resolve, reject) => {
                db.get('SELECT trump, gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            if (!room) {
                socket.emit('errorMessage', 'Комната игры не существует');
                return;
            }
            if (room.gameEnded) {
                console.log(`Комната ${roomId} завершена, отклонение действия playCard`);
                socket.emit('errorMessage', 'Игра завершена');
                return;
            }

            const trump = room.trump ? JSON.parse(room.trump).suit : null;
            let table = room.gameTable ? JSON.parse(room.gameTable) : [];

            const player = await new Promise((resolve, reject) => {
                db.get('SELECT id, isDisconnected, hand, socketIds FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            if (!player) {
                console.error(`Игрок ${playerId} не найден`);
                socket.emit('errorMessage', 'Игрок не найден');
                return;
            }
            if (player.isDisconnected) {
                socket.emit('errorMessage', 'Нельзя играть карты, будучи отключенным');
                return;
            }

            const isAttacker = playerId === room.currentAttacker;
            const isDefender = playerId === room.currentDefender;

            if (role === 'attack' && !isAttacker) {
                socket.emit('errorMessage', 'Не ваш ход для атаки');
                return;
            }
            if (role === 'defend' && !isDefender) {
                socket.emit('errorMessage', 'Не ваш ход для защиты');
                return;
            }

            let hand = player.hand ? JSON.parse(player.hand) : [];
            const cardIndex = hand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
            if (cardIndex === -1) {
                socket.emit('errorMessage', 'Неверная карта');
                return;
            }

            if (role === 'attack') {
                if (!isValidAttackCard(card, table, trump) || table.length >= 12) {
                    socket.emit('errorMessage', 'Неверная карта для атаки');
                    return;
                }
                table.push({ attack: card, defense: null });
            } else if (role === 'defend') {
                const lastAttack = table.find(pair => !pair.defense);
                if (!lastAttack) {
                    socket.emit('errorMessage', 'Нет карты атаки для защиты');
                    return;
                }
                if (!isValidDefenseCard(card, lastAttack.attack, trump)) {
                    socket.emit('errorMessage', 'Неверная карта для защиты');
                    return;
                }
                lastAttack.defense = card;
            }

            hand.splice(cardIndex, 1);
            await new Promise((resolve, reject) => {
                db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(hand), playerId], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
            await new Promise((resolve, reject) => {
                db.run('UPDATE rooms SET gameTable = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(table), Date.now(), roomId], (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });

            console.log(`Карта сыграна в комнате ${roomId}: игрок=${playerName}, роль=${role}, карта=${card.rank} of ${card.suit}`);
            await updateGameState(roomId);
            await checkGameEnd(roomId);
            startTurnTimer(roomId);
        } catch (err) {
            console.error('Ошибка игры карты:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('endTurn', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Игрок ${playerName} завершил ход в комнате ${roomId}`);
        try {
            const room = await new Promise((resolve, reject) => {
                db.get('SELECT gameTable, currentAttacker, currentDefender, gameEnded FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            if (!room) {
                socket.emit('errorMessage', 'Комната игры не существует');
                return;
            }
            if (room.gameEnded) {
                console.log(`Комната ${roomId} завершена, отклонение действия endTurn`);
                socket.emit('errorMessage', 'Игра завершена');
                return;
            }

            let table = room.gameTable ? JSON.parse(room.gameTable) : [];
            const player = await new Promise((resolve, reject) => {
                db.get('SELECT id, isDisconnected, socketIds FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            if (!player) {
                socket.emit('errorMessage', 'Игрок не найден');
                return;
            }
            if (player.isDisconnected) {
                socket.emit('errorMessage', 'Нельзя завершить ход, будучи отключенным');
                return;
            }

            const isDefender = playerId === room.currentDefender;
            if (!isDefender) {
                socket.emit('errorMessage', 'Только защитник может завершить ход');
                return;
            }

            const hasUndefended = table.some(pair => !pair.defense);
            if (hasUndefended) {
                const players = await new Promise((resolve, reject) => {
                    db.all('SELECT playerId, name, hand, isDisconnected, socketIds FROM players WHERE roomId = ?', [roomId], (err, rows) => {
                        if (err) reject(err);
                        resolve(rows);
                    });
                });
                const defender = players.find(p => p.playerId === room.currentDefender);
                if (!defender) {
                    socket.emit('errorMessage', 'Защитник не найден');
                    return;
                }

                let defenderHand = defender.hand ? JSON.parse(defender.hand) : [];
                table.forEach(pair => {
                    if (pair.attack) defenderHand.push(pair.attack);
                    if (pair.defense) defenderHand.push(pair.defense);
                });

                await new Promise((resolve, reject) => {
                    db.run('UPDATE players SET hand = ? WHERE playerId = ?', [JSON.stringify(defenderHand), defender.playerId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                console.log(`Защитник ${defender.name} взял карты в комнате ${roomId}`);

                table = [];
                await new Promise((resolve, reject) => {
                    db.run('UPDATE rooms SET gameTable = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(table), Date.now(), roomId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });

                const activePlayers = players.filter(p => !p.isDisconnected);
                if (activePlayers.length < 2) {
                    await handleSinglePlayerGame(roomId);
                    return;
                }

                const playerIds = activePlayers.map(p => p.playerId);
                const currentIndex = playerIds.indexOf(room.currentAttacker);
                const nextAttackerIndex = (currentIndex + 1) % playerIds.length;
                const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                const newAttacker = playerIds[nextAttackerIndex];
                const newDefender = playerIds[nextDefenderIndex] || playerIds[0];

                await drawCards(roomId, [newAttacker, newDefender]);
                await new Promise((resolve, reject) => {
                    db.run('UPDATE rooms SET currentAttacker = ?, currentDefender = ?, lastActivity = ? WHERE roomId = ?', 
                        [newAttacker, newDefender, Date.now(), roomId], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                });

                await updateGameState(roomId);
                await checkGameEnd(roomId);
                startTurnTimer(roomId);
            } else {
                console.log(`Защитник ${playerName} успешно отбился в комнате ${roomId}`);
                table = [];
                await new Promise((resolve, reject) => {
                    db.run('UPDATE rooms SET gameTable = ?, lastActivity = ? WHERE roomId = ?', [JSON.stringify(table), Date.now(), roomId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });

                const players = await new Promise((resolve, reject) => {
                    db.all('SELECT playerId, name, isDisconnected FROM players WHERE roomId = ?', [roomId], (err, rows) => {
                        if (err) reject(err);
                        resolve(rows);
                    });
                });
                const activePlayers = players.filter(p => !p.isDisconnected);

                if (activePlayers.length < 2) {
                    await handleSinglePlayerGame(roomId);
                    return;
                }

                const playerIds = activePlayers.map(p => p.playerId);
                const currentIndex = playerIds.indexOf(room.currentAttacker);
                const nextAttackerIndex = (currentIndex + 1) % playerIds.length;
                const nextDefenderIndex = (nextAttackerIndex + 1) % playerIds.length;
                const newAttacker = playerIds[nextAttackerIndex];
                const newDefender = playerIds[nextDefenderIndex] || playerIds[0];

                await drawCards(roomId, [newAttacker, newDefender]);
                await new Promise((resolve, reject) => {
                    db.run('UPDATE rooms SET currentAttacker = ?, currentDefender = ?, lastActivity = ? WHERE roomId = ?', 
                        [newAttacker, newDefender, Date.now(), roomId], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                });

                await updateGameState(roomId);
                await checkGameEnd(roomId);
                startTurnTimer(roomId);
            }
        } catch (err) {
            console.error('Ошибка завершения хода:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('chatMessage', ({ roomId, playerName, message }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        message = sanitizeInput(message ? message.trim().slice(0, 200) : '');
        console.log(`Сообщение чата в комнате ${roomId} от ${playerName}: ${message}`);
        io.to(roomId).emit('chatMessage', { playerName, message });
    });

    socket.on('tempDisconnect', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Временное отключение: игрок=${playerName}, playerId=${playerId}, комната=${roomId}, socket=${socket.id}`);
        try {
            await new Promise((resolve, reject) => {
                db.run('UPDATE players SET isDisconnected = TRUE, lastDisconnectedAt = ? WHERE roomId = ? AND playerId = ?', 
                    [Date.now(), roomId, playerId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
            });
            console.log(`Игрок ${playerName} помечен как временно отключенный в комнате ${roomId}`);
            await removeSocketId(playerId, socket.id);
            await updateGameState(roomId);
            await handleSinglePlayerGame(roomId);
        } catch (err) {
            console.error('Ошибка временного отключения:', err.message);
        }
    });

    socket.on('reconnectPlayer', async ({ roomId, playerId, playerName }) => {
        roomId = sanitizeInput(roomId);
        playerName = sanitizeInput(playerName);
        playerId = sanitizeInput(playerId);
        console.log(`Запрос переподключения: игрок=${playerName}, playerId=${playerId}, комната=${roomId}, socket=${socket.id}`);
        try {
            const player = await new Promise((resolve, reject) => {
                db.get('SELECT isDisconnected, language, ready, socketIds, name FROM players WHERE roomId = ? AND playerId = ?', 
                    [roomId, playerId], (err, row) => {
                        if (err) reject(err);
                        resolve(row);
                    });
            });
            if (!player) {
                console.warn(`Игрок ${playerName} не найден в комнате ${roomId} для переподключения`);
                socket.emit('errorMessage', 'Игрок не найден');
                return;
            }
            if (player.name !== playerName) {
                socket.emit('errorMessage', 'Несоответствие имени игрока');
                return;
            }

            await new Promise((resolve, reject) => {
                db.run('UPDATE players SET isDisconnected = FALSE, lastDisconnectedAt = NULL WHERE roomId = ? AND playerId = ?', 
                    [roomId, playerId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
            });
            await addSocketId(playerId, socket.id);

            console.log(`Игрок ${playerName} переподключился к комнате ${roomId}, playerId: ${playerId}, socket: ${socket.id}`);
            socket.join(roomId);
            socket.emit('roomJoined', { roomId, playerId, language: player.language, playerName });
            socket.emit('playerStatus', { playerId, ready: !!player.ready, isDisconnected: false });
            io.to(roomId).emit('playerReconnected', { playerName });
            await updateRoomState(roomId);

            const gameRoom = await new Promise((resolve, reject) => {
                db.get('SELECT trump FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            if (gameRoom?.trump) {
                await updateGameState(roomId);
                await handleSinglePlayerGame(roomId);
            }
        } catch (err) {
            console.error('Ошибка переподключения игрока:', err.message);
            socket.emit('errorMessage', 'Ошибка сервера');
        }
    });

    socket.on('disconnect', async () => {
        console.log(`Пользователь отключился: socketId=${socket.id}`);
        try {
            const player = await new Promise((resolve, reject) => {
                db.get('SELECT roomId, playerId, name FROM players WHERE id = ?', [socket.id], (err, row) => {
                    if (err) reject(err);
                    resolve(row);
                });
            });
            if (!player) {
                console.log(`Игрок с socketId ${socket.id} не найден в базе данных`);
                return;
            }

            const { roomId, playerId, name } = player;
            console.log(`Игрок ${name} отключился от комнаты ${roomId}, playerId: ${playerId}, socket=${socket.id}`);

            await removeSocketId(playerId, socket.id);
            const socketIds = await new Promise((resolve, reject) => {
                db.get('SELECT socketIds FROM players WHERE roomId = ? AND playerId = ?', [roomId, playerId], (err, row) => {
                    if (err) reject(err);
                    resolve(row?.socketIds ? JSON.parse(row.socketIds) : []);
                });
            });

            if (socketIds.length === 0) {
                await new Promise((resolve, reject) => {
                    db.run('UPDATE players SET isDisconnected = TRUE, lastDisconnectedAt = ? WHERE roomId = ? AND playerId = ?', 
                        [Date.now(), roomId, playerId], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                });
                console.log(`Игрок ${name} помечен как отключенный в комнате ${roomId}`);

                const gameRoom = await new Promise((resolve, reject) => {
                    db.get('SELECT trump FROM rooms WHERE roomId = ?', [roomId], (err, row) => {
                        if (err) reject(err);
                        resolve(row);
                    });
                });
                if (gameRoom?.trump) {
                    await updateGameState(roomId);
                    await handleSinglePlayerGame(roomId);
                } else {
                    await updateRoomState(roomId);
                }
                await new Promise((resolve, reject) => {
                    db.run('UPDATE rooms SET lastActivity = ? WHERE roomId = ?', [Date.now(), roomId], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            } else {
                await updateRoomState(roomId);
            }
        } catch (err) {
            console.error('Ошибка обработки отключения:', err.message);
        }
    });
});

// Периодическая очистка старых комнат
async function cleanOldRooms() {
    const oneHourAgo = Date.now() - 3600000; // 1 час назад
    try {
        const rooms = await new Promise((resolve, reject) => {
            db.all('SELECT roomId FROM rooms WHERE lastActivity < ? AND gameEnded = FALSE', [oneHourAgo], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        for (const room of rooms) {
            console.log(`Очистка старой комнаты: ${room.roomId}`);
            await deleteRoom(room.roomId);
        }
        console.log(`Очистка старых комнат завершена, удалено: ${rooms.length} комнат`);
    } catch (err) {
        console.error('Ошибка очистки старых комнат:', err.message);
    }
}

// Запуск периодической очистки каждые 10 минут
setInterval(cleanOldRooms, 10 * 60 * 1000);

// Обработка ошибок сервера
server.on('error', (err) => {
    console.error('Ошибка сервера:', err.message);
});

// Запуск сервера
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
    console.log(`APP_URL: ${APP_URL}`);
    console.log(`База данных SQLite: ${dbPath}`);
});
