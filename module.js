function init(wsServer, path, vkToken) {
    const
        fs = require("fs"),
        randomColor = require('randomcolor'),
        app = wsServer.app,
        registry = wsServer.users,
        channel = "soobshniki",
        testMode = process.argv[2] === "debug",
        PLAYERS_MIN = testMode ? 1 : 2;

    app.use("/soobshniki", wsServer.static(`${__dirname}/public`));
    if (registry.config.appDir)
        app.use("/soobshniki", wsServer.static(`${registry.config.appDir}/public`));
    registry.handleAppPage(path, `${__dirname}/public/app.html`);

    const defaultWords = JSON.parse(fs.readFileSync(`${registry.config.appDir}/moderated-words.json`));
    const dotaWords = JSON.parse(fs.readFileSync(`${registry.config.appDir}/dota.json`));

    class GameState extends wsServer.users.RoomState {
        constructor(hostId, hostData, userRegistry) {
            super(hostId, hostData, userRegistry);
            const
                room = {
                    ...this.room,
                    inited: true,
                    hostId: hostId,
                    spectators: new JSONSet(),
                    playerNames: {},
                    playerColors: {},
                    inactivePlayers: new JSONSet(),
                    onlinePlayers: new JSONSet(),
                    master: null,
                    players: new JSONSet(),
                    readyPlayers: new JSONSet(),
                    playerScores: {},
                    playerScoreDiffs: {},
                    teamsLocked: false,
                    timed: true,
                    masterCard: null,
                    playerWin: null,
                    cards: [],
                    votes: {},
                    phase: 0,
                    masterTime: 20,
                    votingTime: 7,
                    goal: 15,
                    time: null,
                    paused: true,
                    playerAvatars: {},
                    playerLeader: null,
                    stopPlayer: null
                },
                state = {
                    masterCard: null,
                    votes: {}
                };
            this.room = room;
            this.state = state;
            this.lastInteraction = new Date();
            let interval;
            const
                send = (target, event, data) => userRegistry.send(target, event, data),
                update = () => send(room.onlinePlayers, "state", room),
                updatePlayerState = () => {
                    [...room.players].forEach(playerId => {
                        if (room.onlinePlayers.has(playerId))
                            send(playerId, "player-state", {
                                masterPicked: room.master === playerId ? state.masterCard : null,
                                picked: state.votes[playerId] == null ? null : state.votes[playerId]
                            });
                    });
                },
                getNextPlayer = () => {
                    const nextPlayerIndex = [...room.players].indexOf(room.master) + 1;
                    return [...room.players][(room.players.size === nextPlayerIndex) ? 0 : nextPlayerIndex];
                },
                processInactivity = (playerId) => {
                    if (room.inactivePlayers.has(playerId))
                        removePlayer(playerId);
                    else
                        room.inactivePlayers.add(playerId);
                },
                startTimer = () => {
                    if (room.timed) {
                        clearInterval(interval);
                        if (room.phase === 1)
                            room.time = room.masterTime * 1000;
                        else if (room.phase === 3)
                            room.time = room.votingTime * 1000;
                        else
                            return;
                        let time = new Date();
                        interval = setInterval(() => {
                            if (!room.paused) {
                                room.time -= new Date() - time;
                                time = new Date();
                                if (room.time <= 0) {
                                    clearInterval(interval);
                                    if (room.phase === 1) {
                                        processInactivity(room.master);
                                        room.master = getNextPlayer();
                                        startRound();
                                    } else if (room.phase === 3) {
                                        [...room.players].forEach(playerId => {
                                            if (room.phase === 3 && room.master !== playerId && !room.readyPlayers.has(playerId))
                                                processInactivity(playerId);
                                        });
                                        endRound();
                                    }
                                    update();
                                }
                            } else time = new Date();
                        }, 100);
                    }
                },
                dealWords = () => {
                    room.cards = shuffleArray(defaultWords[1]).slice(0, 9);
                   
                },
                startGame = () => {
                    
                    if (room.players.size >= PLAYERS_MIN) {
                        room.paused = false;
                        room.teamsLocked = true;
                        room.playerWin = null;
                        room.time = null;
                        room.playerScores = {};
                        room.cards = [];
                        room.masterCard = state.masterCard = null;
                        room.votes = {};
                        state.votes = {};
                        room.stopPlayer = null;
                        clearInterval(interval);
                        dealWords();
                        startRound();
                    } else {
                        room.paused = true;
                        room.teamsLocked = false;
                    }
                },
                endGame = () => {
                    room.paused = true;
                    room.teamsLocked = false;
                    room.time = null;
                    room.phase = 0;
                    clearInterval(interval);
                    update();
                    updatePlayerState();
                    room.nextWord = '';
                },
                endRound = () => {
                    room.votes = state.votes;
                    room.masterCard = state.masterCard;
                    state.masterCard = null;
                    countPoints();
                    room.readyPlayers.clear();
                    room.master = getNextPlayer();
                    if (!room.playerWin) {
                       do {
                            room.nextWord = shuffleArray(defaultWords[1])[1];
                        } while (room.cards.includes(room.nextWord))
                        setTimeout(startRound, 800);
                    } else
                        endGame();
                },
                stopGame = () => {
                    room.readyPlayers.clear();
                    room.paused = true;
                    room.teamsLocked = false;
                    room.phase = 0;
                    clearInterval(interval);
                    update();
                    updatePlayerState();
                },
                startRound = () => {
                    room.readyPlayers.clear();
                    if (room.players.size >= PLAYERS_MIN) {
                        room.phase = 1;
                        startTimer();
                        update();
                        updatePlayerState();
                    } else {
                        room.phase = 0;
                        room.teamsLocked = false;
                        update();
                    }
                },
                chooseWord = (user, word) => {
                    if (room.players.size >= PLAYERS_MIN) {
                        if (room.master === user && room.phase === 1) {
                            room.inactivePlayers.delete(user);
                            room.readyPlayers.add(user);
                            room.votes = {};
                            state.votes = {};
                            room.playerScoreDiffs = {};
                            room.stopPlayer = null;
                            if (room.nextWord)
                                room.cards[room.masterCard - 1] = room.nextWord;
                            room.masterCard = null;
                            state.masterCard = word;
                            room.phase = 2;
                            room.time = null;
                            startTimer();
                            update();
                            updatePlayerState();
                        } else if (room.master !== user && room.phase === 2) {
                            room.inactivePlayers.delete(user);
                            room.readyPlayers.add(user);
                            state.votes[user] = word;
                            room.stopPlayer = user;
                            room.phase = 3;
                            room.time = null;
                            startTimer();
                            update();
                            updatePlayerState();
                        } else if (room.master !== user && room.phase === 3 && !room.readyPlayers.has(user)) {
                            room.inactivePlayers.delete(user);
                            room.readyPlayers.add(user);
                            state.votes[user] = word;
                            if (room.players.size === room.readyPlayers.size)
                                endRound();
                            else {
                                update();
                                updatePlayerState();
                            }
                        }
                    } else stopGame();
                },
                countPoints = () => {
                    let guessedCount = 0;
                    const playersGuessed = new Set();
                    [...room.players].forEach((player) => {
                        if (room.votes[player] === room.masterCard) {
                            playersGuessed.add(player);
                            guessedCount++;
                        }
                    });
                    const
                        everybodyGuessed = guessedCount === room.readyPlayers.size - 1,
                        oneGuessed = guessedCount === 1,
                        somebodyGuessed = !oneGuessed && !everybodyGuessed && guessedCount > 0;

                    [...room.players].forEach((player) => {
                        let diff = 0;
                        if (room.master === player) {
                            if (somebodyGuessed)
                                diff = 1;
                            else if (oneGuessed)
                                diff = 3;
                        } else if (room.stopPlayer === player) {
                            if (!playersGuessed.has(player))
                                diff = -1;
                            else if ((somebodyGuessed || everybodyGuessed) && playersGuessed.has(player))
                                diff = 2;
                            else if (oneGuessed && playersGuessed.has(player))
                                diff = 3;
                        } else {
                            if (everybodyGuessed)
                                diff = 2;
                            else if (somebodyGuessed && playersGuessed.has(player))
                                diff = 1;
                            else if (oneGuessed && playersGuessed.has(player))
                                diff = 2;
                        }
                        room.playerScores[player] = room.playerScores[player] || 0;
                        room.playerScores[player] += diff;
                        room.playerScoreDiffs[player] = diff;
                        if (room.playerScores[player] < 0)
                            room.playerScores[player] = 0;
                    });
                    const scores = [...room.players].map(player => room.playerScores[player] || 0).sort((a, b) => a - b).reverse();
                    if (scores[0] > scores[1]) {
                        room.playerLeader = [...room.players].filter(player => room.playerScores[player] === scores[0])[0];
                        if (scores[0] >= room.goal)
                            room.playerWin = room.playerLeader;
                    }
                },
                removePlayer = (playerId) => {
                    if (room.master === playerId)
                        room.master = getNextPlayer();
                    room.players.delete(playerId);
                    room.readyPlayers.delete(playerId);
                    if (room.spectators.has(playerId) || !room.onlinePlayers.has(playerId)) {
                        room.spectators.delete(playerId);
                        delete room.playerNames[playerId];
                        this.emit("user-kicked", playerId);
                    } else
                        room.spectators.add(playerId);
                    if (room.phase !== 0 && room.players.size < PLAYERS_MIN)
                        stopGame();
                },
                userJoin = (data) => {
                    const user = data.userId;
                    if (!room.playerNames[user])
                        room.spectators.add(user);
                    room.playerColors[user] = room.playerColors[user] || randomColor();
                    room.onlinePlayers.add(user);
                    room.playerNames[user] = data.userName.substr && data.userName.substr(0, 60);
                    if (data.avatarId) {
                        fs.stat(`${registry.config.appDir || __dirname}/public/avatars/${user}/${data.avatarId}.png`, (err) => {
                            if (!err) {
                                room.playerAvatars[user] = data.avatarId;
                                update()
                            }
                        });
                    }
                    update();
                    updatePlayerState();
                },
                userLeft = (user) => {
                    room.onlinePlayers.delete(user);
                    if (room.spectators.has(user))
                        delete room.playerNames[user];
                    room.spectators.delete(user);
                    if (room.onlinePlayers.size === 0)
                        stopGame();
                    update();
                },
                userEvent = (user, event, data) => {
                    this.lastInteraction = new Date();
                    try {
                        if (this.eventHandlers[event])
                            this.eventHandlers[event](user, data[0], data[1], data[2]);
                    } catch (error) {
                        console.error(error);
                        registry.log(error.message);
                    }
                };
            this.userJoin = userJoin;
            this.userLeft = userLeft;
            this.userEvent = userEvent;
            this.eventHandlers = {
                ...this.eventHandlers,
                "update-avatar": (user, id) => {
                    room.playerAvatars[user] = id;
                    update()
                },
                "toggle-lock": (user) => {
                    if (user === room.hostId && room.paused)
                        room.teamsLocked = !room.teamsLocked;
                    update();
                },
                "choose-word": (user, word) => {
                    if (room.players.has(user) && word > 0 && word < 10)
                        chooseWord(user, word);
                },
                "toggle-pause": (user) => {
                    if (user === room.hostId) {
                        room.paused = !room.paused;
                        if (room.phase === 0)
                            startGame();
                    }
                    update();
                },
                "restart": (user) => {
                    if (user === room.hostId)
                        startGame();
                },
                "toggle-timed": (user) => {
                    if (user === room.hostId) {
                        room.timed = !room.timed;
                        if (!room.timed) {
                            room.time = null;
                            clearInterval(interval);
                        }
                    }
                    update();
                },
                "set-time": (user, type, value) => {
                    if (user === room.hostId && ~["masterTime", "votingTime"].indexOf(type) && !isNaN(parseInt(value)))
                        room[type] = parseFloat(value);
                    update();
                },
                "set-goal": (user, value) => {
                    if (user === room.hostId && !isNaN(parseInt(value)))
                        room.goal = parseInt(value);
                    update();
                },
                "change-name": (user, value) => {
                    if (value)
                        room.playerNames[user] = value.substr && value.substr(0, 60);
                    update();
                },
                "remove-player": (user, playerId) => {
                    if (playerId && user === room.hostId)
                        removePlayer(playerId);
                    update();
                },
                "give-host": (user, playerId) => {
                    if (playerId && user === room.hostId) {
                        room.hostId = playerId;
                        this.emit("host-changed", user, playerId);
                    }
                    update();
                },
                "players-join": (user) => {
                    if (!room.teamsLocked) {
                        room.spectators.delete(user);
                        room.players.add(user);
                        if (room.players.size === 1)
                            room.master = user;
                        update();
                    }
                },
                "spectators-join": (user) => {
                    if (!room.teamsLocked) {
                        if (room.master === user)
                            room.master = getNextPlayer();
                        room.players.delete(user);
                        room.spectators.add(user);
                        update();
                    }
                }
            };
        }

        getPlayerCount() {
            return Object.keys(this.room.playerNames).length;
        }

        getActivePlayerCount() {
            return this.room.onlinePlayers.size;
        }

        getLastInteraction() {
            return this.lastInteraction;
        }

        getSnapshot() {
            return {
                room: this.room,
                state: this.state,
                player: this.player
            };
        }

        setSnapshot(snapshot) {
            Object.assign(this.room, snapshot.room);
            Object.assign(this.state, snapshot.state);
            this.room.paused = true;
            this.room.inactivePlayers = new JSONSet(this.room.inactivePlayers);
            this.room.onlinePlayers = new JSONSet();
            this.room.spectators = new JSONSet();
            this.room.players = new JSONSet(this.room.players);
            this.room.readyPlayers = new JSONSet(this.room.readyPlayers);
            this.room.onlinePlayers.clear();
        }
    }

    function makeId() {
        let text = "";
        const possible = "abcdefghijklmnopqrstuvwxyz0123456789";

        for (let i = 0; i < 5; i++)
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        return text;
    }

    function shuffleArray(array) {
        let currentIndex = array.length, temporaryValue, randomIndex;
        while (0 !== currentIndex) {
            randomIndex = Math.floor(Math.random() * currentIndex);
            currentIndex -= 1;
            temporaryValue = array[currentIndex];
            array[currentIndex] = array[randomIndex];
            array[randomIndex] = temporaryValue;
        }
        return array;
    }

    function getRandomInt(min, max) {
        return Math.floor(Math.random() * (max - min + 1) + min);
    }

    class JSONSet extends Set {
        constructor(iterable) {
            super(iterable)
        }

        toJSON() {
            return [...this]
        }
    }

    registry.createRoomManager(path, channel, GameState);
}

module.exports = init;

