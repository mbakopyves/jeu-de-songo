/**
 * ============================================================
 *  SONGO REMOTE — Client (HTML + CSS + JavaScript + AJAX)
 *  Communication serveur via XMLHttpRequest (sans rechargement de page).
 *  La logique métier du jeu est sur le serveur Node.js (engine/).
 *  Règles : https://www.clubawale.com/post/comment-jouer-le-songo
 * ============================================================
 */

'use strict';

/* ============================================================
   1. CONSTANTES & ÉTAT CLIENT
   ============================================================ */

const CASES = 7;
const INITIAL_SEEDS = 5;
const WIN_SCORE = 40;
const STATS_STORAGE_KEY = 'songo-match-stats';
const MAX_HISTORY_ENTRIES = 20;
const REFUSAL_DISPLAY_MS = 10000;
const SESSION_STORAGE_KEY = 'songo-remote-session';
const POLL_INTERVAL_MS = 2000;
const ANIM_STEP_MS_MIN = 200;   // Ralenti (était 70)
const ANIM_STEP_MS_MAX = 400;   // Ralenti (était 160)
const ANIM_TOTAL_MAX_MS = 8000; // Ralenti (était 3500)

/** État du plateau reçu du serveur */
let state = null;
/** Identifiant de la partie en ligne */
let gameId = null;
/** Jeton secret du joueur connecté */
let playerToken = null;
/** 1 = Sud (bas), 2 = Nord (haut) */
let playerSlot = null;
/** Cases jouables renvoyées par le serveur */
let remoteLegalMoves = [];
/** Timer de synchronisation (sans WebSocket) */
let pollTimer = null;
/** Évite les clics multiples pendant l'attente serveur */
let clickInFlight = false;
/** Dernier coup déjà animé (évite de rejouer au polling) */
let lastAnimatedMoveId = 0;
/** true pendant l'animation de distribution */
let isAnimating = false;
/** évite les requêtes de synchronisation concurrentes */
let syncInFlight = false;

/* ============================================================
   2. AJAX — communication asynchrone avec le serveur
   ============================================================ */

function playerSide(player) {
    return player === 2 ? 'nord' : 'sud';
}

function opponentSide(player) {
    return player === 2 ? 'sud' : 'nord';
}

function caseNumber(side, index) {
    return side === 'nord' ? index + 1 : CASES - index;
}

function opponentSeeds(player) {
    if (!state) return 0;
    const side = opponentSide(player);
    return state[side].reduce((a, b) => a + b, 0);
}

/**
 * Requête AJAX (XMLHttpRequest) vers l'API REST.
 * Échange JSON avec le serveur sans recharger la page.
 *
 * @param {string} method  GET | POST | DELETE
 * @param {string} path    ex. /api/games/ABC123/moves
 * @param {object} [body]  corps JSON pour POST
 * @returns {Promise<object>}
 */
function ajaxRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, path, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (playerToken) {
            xhr.setRequestHeader('X-Player-Token', playerToken);
        }

        xhr.onload = function onAjaxLoad() {
            let data = {};
            try {
                data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
            } catch {
                data = {};
            }

            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(data);
                return;
            }
            const err = new Error(data.error || 'Erreur de communication avec le serveur.');
            err.status = xhr.status;
            reject(err);
        };

        xhr.onerror = function onAjaxError() {
            reject(new Error('Erreur réseau — impossible de joindre le serveur.'));
        };

        xhr.send(body !== undefined ? JSON.stringify(body) : null);
    });
}

function applyServerGame(data) {
    if (data.state) {
        state = {
            ...data.state,
            statsRecorded: state?.statsRecorded || false,
            endChoiceMade: state?.endChoiceMade || false,
        };
    }
    if (data.id) gameId = data.id;
    if (data.token) playerToken = data.token;
    if (data.playerSlot) playerSlot = data.playerSlot;
    remoteLegalMoves = data.legalMoves || [];

    if (state?.gameOver && !state.statsRecorded) {
        recordMatchResult();
    }

    saveSession();
    updateLobbyStatus(data.status);
}

function saveSession() {
    if (!gameId || !playerToken) return;
    try {
        sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({
            gameId,
            playerToken,
            playerSlot,
        }));
    } catch {
        /* mode privé */
    }
}

function clearSession() {
    gameId = null;
    playerToken = null;
    playerSlot = null;
    remoteLegalMoves = [];
    try {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch {
        /* ignore */
    }
}

function updateLobbyStatus(status) {
    const lobby = document.getElementById('game-lobby-status');
    if (!lobby) return;

    if (status === 'waiting' && gameId) {
        lobby.hidden = false;
        lobby.textContent = `Code partie : ${gameId} — en attente du Joueur 2…`;
        return;
    }

    lobby.hidden = true;
    lobby.textContent = '';
}

function startPolling() {
    stopPolling();
    pollTimer = window.setInterval(syncFromServer, POLL_INTERVAL_MS);
}

function stopPolling() {
    if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function snapshotBoard() {
    if (!state) return null;
    return {
        nord: [...state.nord],
        sud: [...state.sud],
        scores: [...state.scores],
    };
}

function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function findPit(side, index) {
    return document.querySelector(
        `#game-board .pit[data-side="${side}"][data-index="${index}"]`
    );
}

function clearPitHighlights() {
    document.querySelectorAll('#game-board .pit').forEach((pit) => {
        pit.classList.remove('pit--picked', 'pit--sowing', 'pit--harvested', 'pit--last-sown');
    });
}

/** Affiche le plateau à partir d'un instantané (pendant l'animation) */
function renderBoardFromSnapshot(snapshot) {
    if (!snapshot) return;

    document.querySelectorAll('#game-board .pit').forEach((pit) => {
        const side = pit.dataset.side;
        const index = parseInt(pit.dataset.index, 10);
        const count = snapshot[side][index];

        let seedsEl = pit.querySelector('.seeds');
        if (!seedsEl) {
            seedsEl = document.createElement('div');
            seedsEl.className = 'seeds';
            pit.appendChild(seedsEl);
        }

        // Optimisation : ne redessiner que si le nombre de graines a changé
        if (seedsEl.getAttribute('data-count') !== count.toString()) {
            seedsEl.setAttribute('data-count', count);
            renderSeedsInContainer(seedsEl, count);

            let countEl = pit.querySelector('.pit__count');
            if (count > 12) {
                if (!countEl) {
                    countEl = document.createElement('span');
                    countEl.className = 'pit__count';
                    pit.appendChild(countEl);
                }
                countEl.textContent = count;
            } else if (countEl) {
                countEl.remove();
            }
        }
    });

    if (snapshot.scores) {
        document.querySelectorAll('.score-value').forEach((el) => {
            const p = parseInt(el.dataset.player, 10);
            if (el.textContent !== snapshot.scores[p - 1].toString()) {
                el.textContent = snapshot.scores[p - 1];
            }
        });
    }
}

/** Son de déplacement des graines prechargé */
const sowSound = new Audio('audio/clicDeplacement.wav');
sowSound.preload = 'auto';

let lastSowSoundTime = 0;
function playSowSound() {
    if (!sowSound) return;
    const now = Date.now();
    // Anti-rebond : évite les doubles clics accidentels en < 50ms
    if (now - lastSowSoundTime < 50) return;
    lastSowSoundTime = now;

    try {
        const sound = sowSound.cloneNode(true);
        sound.volume = 0.6;
        sound.play().catch(() => {});
    } catch (e) {
        /* ignore */
    }
}

/**
 * Anime la distribution des graines pour que les 2 joueurs voient le coup.
 */
async function animateMove(lastMove, boardBefore) {
    const statusEl = document.getElementById('game-status');
    const anim = {
        nord: [...boardBefore.nord],
        sud: [...boardBefore.sud],
        scores: [...boardBefore.scores],
    };

    const stepCount = lastMove.sowSteps.length;
    const stepMs = Math.max(
        ANIM_STEP_MS_MIN,
        Math.min(ANIM_STEP_MS_MAX, Math.floor(ANIM_TOTAL_MAX_MS / Math.max(stepCount, 1)))
    );

    if (statusEl) {
        statusEl.textContent =
            `Joueur ${lastMove.player} joue la case ${lastMove.caseNumber} (${lastMove.seedsPicked} graines)`;
    }

    clearPitHighlights();
    const sourcePit = findPit(lastMove.pickSide, lastMove.pickIndex);
    if (sourcePit) sourcePit.classList.add('pit--picked');

    anim[lastMove.pickSide][lastMove.pickIndex] = 0;
    renderBoardFromSnapshot(anim);
    await delay(400);

    for (let i = 0; i < lastMove.sowSteps.length; i++) {
        const step = lastMove.sowSteps[i];
        clearPitHighlights();
        if (sourcePit) sourcePit.classList.add('pit--picked');

        const targetPit = findPit(step.side, step.index);
        if (targetPit) targetPit.classList.add('pit--sowing');

        anim[step.side][step.index]++;
        renderBoardFromSnapshot(anim);
        playSowSound();

        if (i === lastMove.sowSteps.length - 1 && targetPit) {
            targetPit.classList.add('pit--last-sown');
        }

        await delay(stepMs);
    }

    if (lastMove.harvested > 0) {
        clearPitHighlights();
        for (const h of lastMove.harvestedPits) {
            const pit = findPit(h.side, h.index);
            if (pit) pit.classList.add('pit--harvested');
            anim[h.side][h.index] -= h.count;
            if (anim[h.side][h.index] < 0) anim[h.side][h.index] = 0;
        }
        anim.scores[lastMove.player - 1] += lastMove.harvested;
        renderBoardFromSnapshot(anim);

        if (statusEl) {
            statusEl.textContent =
                `Prise : Joueur ${lastMove.player} récolte ${lastMove.harvested} graine(s)`;
        }
        await delay(700);
    }

    clearPitHighlights();
}

async function processServerResponse(data, boardBefore) {
    if (!data.lastMove) {
        applyServerGame(data);
        renderGame();
        return;
    }

    const isNewMove = data.lastMove.id !== lastAnimatedMoveId;
    if (!isNewMove) {
        applyServerGame(data);
        renderGame();
        return;
    }

    // Nouveau coup détecté : on marque immédiatement l'ID pour bloquer les appels concurrents
    lastAnimatedMoveId = data.lastMove.id;

    const moveBefore = data.lastMove.boardBefore || boardBefore;
    const shouldAnimate = Boolean(
        moveBefore &&
        data.lastMove.sowSteps &&
        data.lastMove.sowSteps.length > 0
    );

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (shouldAnimate && !reduceMotion) {
        isAnimating = true;
        try {
            await animateMove(data.lastMove, moveBefore);
        } finally {
            isAnimating = false;
        }
    } else if (shouldAnimate && reduceMotion) {
        const statusEl = document.getElementById('game-status');
        if (statusEl) {
            statusEl.textContent =
                `Joueur ${data.lastMove.player} — case ${data.lastMove.caseNumber} (${data.lastMove.seedsPicked} graines)`;
        }
    }

    applyServerGame(data);
    renderGame();
}

async function syncFromServer() {
    if (!gameId || !playerToken || isAnimating || syncInFlight) return;
    syncInFlight = true;
    try {
        const boardBefore = snapshotBoard();
        const data = await ajaxRequest('GET', `/api/games/${gameId}`);
        await processServerResponse(data, boardBefore);
    } catch (err) {
        /* Partie supprimée ou serveur redémarré → arrêter le polling */
        if (err.status === 404 || err.status === 403) {
            stopPolling();
            clearSession();
        }
    } finally {
        syncInFlight = false;
    }
}

async function createOnlineGame() {
    const data = await ajaxRequest('POST', '/api/games');
    applyServerGame(data);
    showScreen('game');
    buildBoard();
    renderGame();
    startPolling();
}

async function joinOnlineGame(id) {
    const code = (id || '').trim().toUpperCase();
    if (!code) throw new Error('Code de partie requis.');

    const data = await ajaxRequest('POST', `/api/games/${code}/join`);
    applyServerGame(data);
    lastAnimatedMoveId = data.lastMove ? data.lastMove.id : 0;
    showScreen('game');
    buildBoard();
    renderGame();
    startPolling();
}

async function playMoveRemote(pickIndex) {
    const boardBefore = snapshotBoard();
    const data = await ajaxRequest('POST', `/api/games/${gameId}/moves`, { pickIndex });
    await processServerResponse(data, boardBefore);
}

async function abandonOnlineGame() {
    if (gameId && playerToken) {
        try {
            await ajaxRequest('DELETE', `/api/games/${gameId}`);
        } catch {
            /* partie déjà supprimée */
        }
    }
    stopPolling();
    clearSession();
    state = null;
}

function getMatchWinner() {
    if (!state) return 0;
    if (state.scores[0] >= WIN_SCORE) return 1;
    if (state.scores[1] >= WIN_SCORE) return 2;
    return 0;
}

/** Charge les statistiques persistées (localStorage) */
function loadMatchStats() {
    try {
        const raw = localStorage.getItem(STATS_STORAGE_KEY);
        if (raw) {
            const data = JSON.parse(raw);
            return {
                player1Wins: data.player1Wins || 0,
                player2Wins: data.player2Wins || 0,
                draws: data.draws || 0,
                history: Array.isArray(data.history) ? data.history : [],
            };
        }
    } catch {
        /* stockage indisponible ou corrompu */
    }
    return { player1Wins: 0, player2Wins: 0, draws: 0, history: [] };
}

function saveMatchStats(stats) {
    try {
        localStorage.setItem(STATS_STORAGE_KEY, JSON.stringify(stats));
    } catch {
        /* quota dépassé ou mode privé */
    }
}

/** Enregistre le résultat d'une partie terminée (une seule fois par partie) */
function recordMatchResult() {
    if (!state || state.statsRecorded) return;

    const winner = getMatchWinner();
    const stats = loadMatchStats();

    if (winner === 1) stats.player1Wins++;
    else if (winner === 2) stats.player2Wins++;
    else stats.draws++;

    stats.history.unshift({
        date: Date.now(),
        scores: [state.scores[0], state.scores[1]],
        winner,
    });
    stats.history = stats.history.slice(0, MAX_HISTORY_ENTRIES);

    saveMatchStats(stats);
    state.statsRecorded = true;
}

/** Marque la partie comme terminée et enregistre le score */
function markGameOver(message) {
    if (state.gameOver) return;
    state.gameOver = true;
    state.message = message;
    recordMatchResult();
}


/* ============================================================
   3. RENDU VISUEL
   ============================================================ */

/** Positions pseudo-aléatoires pour empiler les graines visuellement */
const SEED_OFFSETS = [
    { top: '30%', left: '30%' },
    { top: '25%', left: '55%' },
    { top: '50%', left: '40%' },
    { top: '45%', left: '65%' },
    { top: '60%', left: '25%' },
    { top: '35%', left: '70%' },
    { top: '55%', left: '50%' },
    { top: '40%', left: '20%' },
];

/** Dessine les graines dans un conteneur .seeds */
function renderSeedsInContainer(container, count) {
    container.innerHTML = '';
    const displayCount = Math.min(count, 12);

    for (let s = 0; s < displayCount; s++) {
        const seed = document.createElement('span');
        seed.className = 'seed';
        const off = SEED_OFFSETS[s % SEED_OFFSETS.length];
        seed.style.top = off.top;
        seed.style.left = off.left;
        /* Décalage d'animation pour effet de vague sur l'accueil */
        seed.style.animationDelay = `${(s * 0.12).toFixed(2)}s`;
        container.appendChild(seed);
    }
}

/** Graines sur le plateau d'aperçu du menu */
function initMenuPreview() {
    document.querySelectorAll('#menu-board-preview .pit').forEach((pit) => {
        let seedsEl = pit.querySelector('.seeds');
        if (!seedsEl) {
            seedsEl = document.createElement('div');
            seedsEl.className = 'seeds';
            pit.appendChild(seedsEl);
        }
        renderSeedsInContainer(seedsEl, INITIAL_SEEDS);
    });
}

/** Construit le plateau interactif */
function buildBoard() {
    const row1 = document.getElementById('row-player-2');
    const row2 = document.getElementById('row-player-1');
    row1.innerHTML = '';
    row2.innerHTML = '';

    // Joueur 2 (Nord) : cases 1→7 gauche à droite = nord[0..6]
    for (let i = 0; i < CASES; i++) {
        row1.appendChild(createPitElement(2, i, 'nord'));
    }
    // Joueur 1 (Sud) : cases 7→1 gauche à droite = sud[0..6]
    for (let i = 0; i < CASES; i++) {
        row2.appendChild(createPitElement(1, i, 'sud'));
    }
}

function createPitElement(player, index, side) {
    const pit = document.createElement('button');
    pit.className = 'pit';
    pit.type = 'button';
    pit.dataset.player = player;
    pit.dataset.index = index;
    pit.dataset.side = side;
    pit.setAttribute('aria-label', `Case ${caseNumber(side, index)}, joueur ${player}`);

    pit.addEventListener('click', async () => {
        if (!state || state.gameOver || isAnimating || clickInFlight) return;

        if (player !== playerSlot) {
            showMoveRefusal('Vous ne pouvez jouer que sur votre propre camp.');
            return;
        }

        clickInFlight = true;
        try {
            await playMoveRemote(index);
        } catch (err) {
            showMoveRefusal(err.message);
        } finally {
            clickInFlight = false;
        }
    });

    return pit;
}

/** Met à jour l'affichage du plateau */
function renderGame() {
    if (!state) return;

    // Scores
    document.querySelectorAll('.score-value').forEach(el => {
        const p = parseInt(el.dataset.player, 10);
        el.textContent = state.scores[p - 1];
    });

    // Message de statut
    const statusEl = document.getElementById('game-status');
    if (!statusEl) return;
    statusEl.textContent = state.message;

    const legalIndices = new Set(remoteLegalMoves);

    // Uniquement les cases du plateau de jeu (pas celles du menu)
    document.querySelectorAll('#game-board .pit').forEach((pit) => {
        const player = parseInt(pit.dataset.player, 10);
        const index = parseInt(pit.dataset.index, 10);
        const side = pit.dataset.side;
        const count = state[side][index];

        pit.classList.toggle('pit--playable',
            !state.gameOver &&
            player === playerSlot &&
            state.currentPlayer === playerSlot &&
            legalIndices.has(index)
        );
        pit.classList.toggle('pit--active-turn', player === state.currentPlayer);

        // Graines
        let seedsEl = pit.querySelector('.seeds');
        if (!seedsEl) {
            seedsEl = document.createElement('div');
            seedsEl.className = 'seeds';
            pit.appendChild(seedsEl);
        }

        // Optimisation : éviter le rendu inutile si le nombre n'a pas changé
        if (seedsEl.getAttribute('data-count') !== count.toString()) {
            seedsEl.setAttribute('data-count', count);
            renderSeedsInContainer(seedsEl, count);

            // Compteur si trop de graines à afficher
            let countEl = pit.querySelector('.pit__count');
            if (count > 12) {
                if (!countEl) {
                    countEl = document.createElement('span');
                    countEl.className = 'pit__count';
                    pit.appendChild(countEl);
                }
                countEl.textContent = count;
            } else if (countEl) {
                countEl.remove();
            }
        }
    });

    // Message solidarité
    if (!state.gameOver && opponentSeeds(state.currentPlayer) === 0) {
        statusEl.textContent = `Solidarité : distribuez des graines à l'adversaire — ${state.message}`;
    }

    // Boutons fin de partie : uniquement si un vainqueur est déterminé
    updateGameEndActions();
}

/** true si la partie est terminée avec un vainqueur (≥ 40 graines) */
function hasGameWinner() {
    return Boolean(state && state.gameOver && getMatchWinner() !== 0);
}

/** Affiche ou masque QUITTER / CONTINUER selon la fin de partie */
function updateGameEndActions() {
    const endActions = document.getElementById('game-end-actions');
    if (!endActions) return;
    const show = hasGameWinner() && !state.endChoiceMade;
    endActions.hidden = !show;
    endActions.setAttribute('aria-hidden', show ? 'false' : 'true');
}

/** Affiche un message de refus à gauche (montée 10 s) */
let moveRefusalTimer = null;

function showMoveRefusal(message) {
    const container = document.getElementById('move-refusal');
    if (!container) return;

    if (moveRefusalTimer !== null) {
        clearTimeout(moveRefusalTimer);
        moveRefusalTimer = null;
    }

    container.hidden = false;
    container.innerHTML = '';

    const text = document.createElement('p');
    text.className = 'move-refusal__text';
    text.textContent = message;
    text.style.setProperty('--refusal-duration', `${REFUSAL_DISPLAY_MS}ms`);
    container.appendChild(text);

    moveRefusalTimer = window.setTimeout(() => {
        container.hidden = true;
        container.innerHTML = '';
        moveRefusalTimer = null;
    }, REFUSAL_DISPLAY_MS);
}

function hideGameEndActions() {
    const endActions = document.getElementById('game-end-actions');
    if (!endActions) return;
    endActions.hidden = true;
    endActions.setAttribute('aria-hidden', 'true');
}

async function quitAfterGame() {
    if (!state) return;
    state.endChoiceMade = true;
    hideGameEndActions();
    await abandonOnlineGame();
    state = null;
    goToMenu();
}

async function continueAfterGame() {
    if (!state) return;
    state.endChoiceMade = true;
    hideGameEndActions();
    await abandonOnlineGame();
    await startGame();
}


/* ============================================================
   4. AUDIO — Musique d'ambiance
   ============================================================ */

let musicPlaying = false;
/** true = synthèse Web Audio (pas de fichier mp3) */
let usingSynthMusic = false;
/** @type {AudioContext|null} */
let synthContext = null;
/** @type {GainNode|null} */
let synthGain = null;
/** @type {number|null} */
let synthLoopTimer = null;

/** Notes pentatoniques (ambiance douce type traditionnel) */
const AMBIENCE_MELODY = [261.63, 329.63, 392.0, 440.0, 392.0, 329.63, 293.66, 261.63];

function getBgMusicElement() {
    return document.getElementById('bg-music');
}

function updateMusicButton() {
    const btn = document.getElementById('btn-sound');
    if (!btn) return;
    btn.classList.toggle('icon-btn--active', musicPlaying);
    const label = musicPlaying ? 'Couper la musique' : 'Activer la musique';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.textContent = musicPlaying ? '♫' : '♪';
}

function getSynthContext() {
    if (!synthContext) {
        synthContext = new (window.AudioContext || window.webkitAudioContext)();
        synthGain = synthContext.createGain();
        synthGain.gain.value = 0.14;
        synthGain.connect(synthContext.destination);
    }
    return synthContext;
}

/** Joue une note (secours si pas de fichier mp3) */
function playSynthNote(freq, startTime, duration) {
    const ctx = getSynthContext();
    const osc = ctx.createOscillator();
    const noteGain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    noteGain.gain.setValueAtTime(0.001, startTime);
    noteGain.gain.exponentialRampToValueAtTime(0.35, startTime + 0.04);
    noteGain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.connect(noteGain);
    noteGain.connect(synthGain);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
}

function scheduleSynthLoop() {
    if (!musicPlaying || !usingSynthMusic) return;
    const ctx = getSynthContext();
    const now = ctx.currentTime;
    const beat = 0.5;
    AMBIENCE_MELODY.forEach((freq, i) => {
        playSynthNote(freq, now + i * beat, beat * 0.9);
    });
    synthLoopTimer = window.setTimeout(scheduleSynthLoop, AMBIENCE_MELODY.length * beat * 1000);
}

function stopSynthMusic() {
    if (synthLoopTimer !== null) {
        clearTimeout(synthLoopTimer);
        synthLoopTimer = null;
    }
}

/** Active la musique (fichier audio ou synthèse) */
async function startMusic() {
    const audio = getBgMusicElement();
    usingSynthMusic = false;

    if (audio) {
        try {
            audio.currentTime = 0;
            await audio.play();
            musicPlaying = true;
            updateMusicButton();
            return;
        } catch {
            // Fichier absent ou lecture bloquée par le navigateur → synthèse
            audio.pause();
        }
    }

    usingSynthMusic = true;
    const ctx = getSynthContext();
    if (ctx.state === 'suspended') await ctx.resume();
    musicPlaying = true;
    scheduleSynthLoop();
    updateMusicButton();
}

/** Coupe la musique */
function stopMusic() {
    const audio = getBgMusicElement();
    if (audio) {
        audio.pause();
        audio.currentTime = 0;
    }
    stopSynthMusic();
    usingSynthMusic = false;
    musicPlaying = false;
    updateMusicButton();
}

/** Bascule musique on/off */
async function toggleMusic() {
    if (musicPlaying) {
        stopMusic();
    } else {
        await startMusic();
    }
}


/* ============================================================
   5. NAVIGATION ENTRE ÉCRANS
   ============================================================ */

/** @type {Record<string, HTMLElement|null>} */
let screens = {};

function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
        if (!el) return;
        const active = key === name;
        el.classList.toggle('screen--active', active);
        el.hidden = !active;
        el.setAttribute('aria-hidden', active ? 'false' : 'true');
    });
}

function goToMenu() {
    stopPolling();
    updateLobbyStatus(null);
    const refusal = document.getElementById('move-refusal');
    if (refusal) {
        refusal.hidden = true;
        refusal.innerHTML = '';
    }
    if (moveRefusalTimer !== null) {
        clearTimeout(moveRefusalTimer);
        moveRefusalTimer = null;
    }
    showScreen('menu');
}

/**
 * Réinitialise l'application : retour menu, scores à zéro, plateau d'aperçu.
 */
async function resetApplication() {
    setOptionsMenuOpen(false);
    closeRules();
    closeAbout();
    closeScores();

    await abandonOnlineGame();
    state = null;

    document.querySelectorAll('.score-value').forEach((el) => {
        el.textContent = '0';
    });

    const statusEl = document.getElementById('game-status');
    if (statusEl) statusEl.textContent = 'Tour de Joueur 1';

    goToMenu();
    initMenuPreview();
}

/** Retour à l'écran d'ouverture (splash) */
function goToSplash() {
    setOptionsMenuOpen(false);
    showScreen('splash');
    const splash = screens.splash;
    if (!splash) return;
    const leaveSplash = () => {
        splash.removeEventListener('click', leaveSplash);
        goToMenu();
    };
    splash.addEventListener('click', leaveSplash);
}

async function startGame() {
    hideGameEndActions();
    const refusal = document.getElementById('move-refusal');
    if (refusal) {
        refusal.hidden = true;
        refusal.innerHTML = '';
    }
    state = null;
    lastAnimatedMoveId = 0;
    isAnimating = false;
    clearSession();
    await createOnlineGame();
}

async function abandonGame() {
    if (!confirm('Abandonner la partie et retourner au menu ?')) return;
    await abandonOnlineGame();
    state = null;
    document.querySelectorAll('.score-value').forEach((el) => {
        el.textContent = '0';
    });
    goToMenu();
}

async function restartGame() {
    if (!confirm('Créer une nouvelle partie en ligne ?')) return;
    await abandonOnlineGame();
    await startGame();
}


/* ============================================================
   6. INITIALISATION
   ============================================================ */

function initNavigation() {
    // Références DOM (après chargement complet de la page)
    screens = {
        splash: document.getElementById('splash-screen'),
        menu:   document.getElementById('menu-screen'),
        game:   document.getElementById('game-screen'),
    };

    // Splash → Menu (clic ou délai)
    const splash = screens.splash;
    if (splash) {
        let left = false;
        const leaveSplash = () => {
            if (left) return;
            left = true;
            splash.removeEventListener('click', leaveSplash);
            goToMenu();
        };
        splash.addEventListener('click', leaveSplash);
        setTimeout(leaveSplash, 3500);
    }

    // Menu — délégation d'événements
    document.body.addEventListener('click', (event) => {
        const target = /** @type {HTMLElement} */ (event.target);

        const menuItem = target.closest('.options-menu__item');
        if (menuItem) {
            handleOptionsMenuAction(menuItem.dataset.action);
            return;
        }

        if (!target.closest('.options-menu-wrap')) {
            setOptionsMenuOpen(false);
        }

        if (target.closest('#btn-play')) {
            event.preventDefault();
            startGame().catch((err) => alert(err.message));
            return;
        }
        if (target.closest('#btn-join')) {
            event.preventDefault();
            openJoinModal();
            return;
        }
        if (target.closest('#btn-cancel-join')) {
            closeJoinModal();
            return;
        }
        if (target.closest('#btn-help')) {
            openRules();
            return;
        }
        if (target.closest('#btn-about')) {
            openAbout();
            return;
        }
        if (target.closest('#btn-scores')) {
            openScores();
            return;
        }
        if (target.closest('#btn-close-scores')) {
            closeScores();
            return;
        }
        if (target.closest('#btn-reset-scores')) {
            resetMatchStats();
            return;
        }
        if (target.closest('#btn-abandon')) {
            abandonGame();
            return;
        }
        if (target.closest('#btn-restart')) {
            restartGame();
            return;
        }
        if (target.closest('#btn-game-quit')) {
            quitAfterGame();
            return;
        }
        if (target.closest('#btn-game-continue')) {
            continueAfterGame();
            return;
        }
        if (target.closest('#btn-close-rules')) {
            closeRules();
            return;
        }
        if (target.closest('#btn-close-about')) {
            closeAbout();
        }
    });

    // Écouteurs directs (évitent les conflits de délégation)
    document.getElementById('btn-menu-info')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleOptionsMenu();
    });

    document.getElementById('btn-sound')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleMusic();
    });

    document.getElementById('btn-menu-reset')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        resetApplication();
    });

    document.getElementById('btn-join')?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openJoinModal();
    });

    document.getElementById('join-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        submitJoinModal().catch((err) => alert(err.message));
    });
}

function openJoinModal() {
    const modal = document.getElementById('join-modal');
    const input = document.getElementById('join-code-input');
    if (!modal) return;
    if (input) input.value = '';
    modal.showModal();
    window.setTimeout(() => input?.focus(), 50);
}

function closeJoinModal() {
    document.getElementById('join-modal')?.close();
}

async function submitJoinModal() {
    const input = document.getElementById('join-code-input');
    const code = (input?.value || '').trim().toUpperCase();
    if (!code) {
        input?.focus();
        return;
    }
    closeJoinModal();
    await joinOnlineGame(code);
}

function openRules() {
    const modal = document.getElementById('rules-modal');
    if (modal) modal.showModal();
}

function closeRules() {
    const modal = document.getElementById('rules-modal');
    if (modal) modal.close();
}

function openAbout() {
    const modal = document.getElementById('about-modal');
    if (modal) modal.showModal();
}

function closeAbout() {
    const modal = document.getElementById('about-modal');
    if (modal) modal.close();
}

function formatMatchDate(timestamp) {
    return new Date(timestamp).toLocaleString('fr-FR', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function winnerLabel(winner) {
    if (winner === 1) return 'Joueur 1';
    if (winner === 2) return 'Joueur 2';
    return 'Match nul';
}

/** Met à jour le contenu de la modale des scores */
function renderScoresModal() {
    const stats = loadMatchStats();
    const total = stats.player1Wins + stats.player2Wins + stats.draws;

    const summaryEl = document.getElementById('scores-summary');
    if (summaryEl) {
        summaryEl.innerHTML = `
            <div class="scores-summary__card">
                <span class="scores-summary__value">${stats.player1Wins}</span>
                <span class="scores-summary__label">Victoires J1</span>
            </div>
            <div class="scores-summary__card">
                <span class="scores-summary__value">${stats.player2Wins}</span>
                <span class="scores-summary__label">Victoires J2</span>
            </div>
            <div class="scores-summary__card">
                <span class="scores-summary__value">${stats.draws}</span>
                <span class="scores-summary__label">Nuls</span>
            </div>
            <div class="scores-summary__card scores-summary__card--total">
                <span class="scores-summary__value">${total}</span>
                <span class="scores-summary__label">Parties</span>
            </div>
        `;
    }

    const historyEl = document.getElementById('scores-history');
    if (!historyEl) return;

    if (stats.history.length === 0) {
        historyEl.innerHTML = '<li class="scores-history__empty">Aucune partie terminée pour le moment.</li>';
        return;
    }

    historyEl.innerHTML = stats.history.map((entry) => {
        const resultClass = entry.winner === 0
            ? 'scores-history__result--draw'
            : `scores-history__result--p${entry.winner}`;
        return `
            <li class="scores-history__item">
                <span class="scores-history__date">${formatMatchDate(entry.date)}</span>
                <span class="scores-history__score">
                    <span class="seed-icon seed-icon--inline"></span>
                    J1 : ${entry.scores[0]} — J2 : ${entry.scores[1]}
                </span>
                <span class="scores-history__result ${resultClass}">${winnerLabel(entry.winner)}</span>
            </li>
        `;
    }).join('');
}

function openScores() {
    renderScoresModal();
    const modal = document.getElementById('scores-modal');
    if (modal) modal.showModal();
}

function closeScores() {
    const modal = document.getElementById('scores-modal');
    if (modal) modal.close();
}

function resetMatchStats() {
    if (!confirm('Effacer tout l\'historique des scores ?')) return;
    saveMatchStats({ player1Wins: 0, player2Wins: 0, draws: 0, history: [] });
    renderScoresModal();
}

/** Ouvre / ferme le menu ☰ */
function setOptionsMenuOpen(open) {
    const menu = document.getElementById('options-menu');
    const btn = document.getElementById('btn-menu-info');
    if (!menu) return;
    menu.hidden = !open;
    menu.classList.toggle('options-menu--open', open);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function isOptionsMenuOpen() {
    const menu = document.getElementById('options-menu');
    return menu ? !menu.hidden : false;
}

function toggleOptionsMenu() {
    setOptionsMenuOpen(!isOptionsMenuOpen());
}

function handleOptionsMenuAction(action) {
    setOptionsMenuOpen(false);
    if (action === 'rules') openRules();
    else if (action === 'about') openAbout();
    else if (action === 'splash') goToSplash();
}

function boot() {
    initMenuPreview();
    initNavigation();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
