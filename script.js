/**
 * ============================================================
 *  SONGO — Jeu de semailles (version locale 2 joueurs)
 *  Règles : https://www.clubawale.com/post/comment-jouer-le-songo
 * ============================================================
 *
 *  Organisation du code :
 *  1. Constantes & état du jeu
 *  2. Moteur de règles (distribution, récoltes, solidarité)
 *  3. Rendu visuel (plateau, graines)
 *  4. Navigation entre écrans
 *  5. Initialisation
 */

'use strict';

/* ============================================================
   1. CONSTANTES & ÉTAT
   ============================================================ */

const CASES = 7;
const INITIAL_SEEDS = 5;
const WIN_SCORE = 40;
const MIN_BOARD_SEEDS = 10; // fin si moins de 10 graines sur le tablier
const STATS_STORAGE_KEY = 'songo-match-stats';
const MAX_HISTORY_ENTRIES = 20;
const REFUSAL_DISPLAY_MS = 10000;
const ANIM_STEP_MS_MIN = 70;
const ANIM_STEP_MS_MAX = 160;
const ANIM_TOTAL_MAX_MS = 3500;

/** @type {{ nord: number[], sud: number[], scores: [number, number], currentPlayer: 1|2, gameOver: boolean, message: string }} */
let state = null;
/** true pendant l'animation de distribution des graines */
let isAnimating = false;

/** Séquence de semis pour chaque joueur (boucle de 14 cases) */
const SOWING_LOOPS = {
    // Joueur 2 (Nord) : nord 7→1 puis sud 1→7
    2: [
        ...[6, 5, 4, 3, 2, 1, 0].map(i => ({ side: 'nord', index: i })),
        ...[6, 5, 4, 3, 2, 1, 0].map(i => ({ side: 'sud', index: i })),
    ],
    // Joueur 1 (Sud) : sud 1→7 puis nord 1→7
    1: [
        ...[6, 5, 4, 3, 2, 1, 0].map(i => ({ side: 'sud', index: i })),
        ...[0, 1, 2, 3, 4, 5, 6].map(i => ({ side: 'nord', index: i })),
    ],
};

/* ============================================================
   2. MOTEUR DE RÈGLES
   ============================================================ */

/** Crée l'état initial d'une partie */
function createInitialState() {
    return {
        nord: Array(CASES).fill(INITIAL_SEEDS),
        sud: Array(CASES).fill(INITIAL_SEEDS),
        scores: [0, 0],       // [joueur1, joueur2]
        currentPlayer: 1,
        gameOver: false,
        statsRecorded: false,
        endChoiceMade: false,
        message: 'Tour de Joueur 1',
    };
}

/** Retourne le camp d'un joueur */
function playerSide(player) {
    return player === 2 ? 'nord' : 'sud';
}

/** Camp adverse */
function opponentSide(player) {
    return player === 2 ? 'sud' : 'nord';
}

/** Numéro de case (1-7) depuis l'index interne */
function caseNumber(side, index) {
    return side === 'nord' ? index + 1 : CASES - index;
}

/** Index de la case n°1 du camp adverse (interdite pour prise simple) */
function opponentCase1Index(player) {
    return player === 2 ? 6 : 0; // sud case 1 = index 6, nord case 1 = index 0
}

/** Index de la case n°7 du joueur (règle d'interdit) */
function playerCase7Index(player) {
    return player === 2 ? 6 : 0;
}

/** Total de graines sur le tablier */
function boardTotal() {
    return state.nord.reduce((a, b) => a + b, 0) + state.sud.reduce((a, b) => a + b, 0);
}

/** Graines dans le camp adverse */
function opponentSeeds(player) {
    const side = opponentSide(player);
    return state[side].reduce((a, b) => a + b, 0);
}

/** Simule la distribution et retourne le résultat sans modifier l'état */
function simulateMove(player, pickIndex) {
    const side = playerSide(player);
    const seeds = state[side][pickIndex];
    if (seeds === 0) return null;

    const board = {
        nord: [...state.nord],
        sud: [...state.sud],
    };
    board[side][pickIndex] = 0;

    const loop = SOWING_LOOPS[player];
    let loopStart = loop.findIndex(c => c.side === side && c.index === pickIndex);
    let pos = (loopStart + 1) % loop.length;
    let remaining = seeds;
    let lastCell = null;
    let distributed = 0;
    const skipSourceOnLap = seeds > 13;
    let completedLaps = 0;
    let seedsAtStart = seeds;
    const sowSteps = [];

    while (remaining > 0) {
        const cell = loop[pos];

        // Règle >13 : après un tour complet, ne semer que chez l'adversaire
        if (seedsAtStart > 13 && completedLaps >= 1 && cell.side === side) {
            pos = (pos + 1) % loop.length;
            if (pos === (loopStart + 1) % loop.length) completedLaps++;
            continue;
        }

        // Règle >13 : ne pas remplir la case source pendant le 1er tour
        if (skipSourceOnLap && completedLaps === 0 && cell.side === side && cell.index === pickIndex) {
            pos = (pos + 1) % loop.length;
            if (pos === (loopStart + 1) % loop.length) completedLaps++;
            continue;
        }

        board[cell.side][cell.index]++;
        sowSteps.push({ side: cell.side, index: cell.index });
        remaining--;
        distributed++;
        lastCell = { ...cell, count: board[cell.side][cell.index] };
        pos = (pos + 1) % loop.length;
        if (pos === (loopStart + 1) % loop.length) completedLaps++;
    }

    return { board, lastCell, distributed, pickIndex, pickSide: side, seedsPicked: seeds, sowSteps };
}

/** Calcule les graines récoltées après une distribution */
function calculateHarvest(player, simResult) {
    const oppSide = opponentSide(player);
    const { board, lastCell, distributed, seedsPicked } = simResult;

    if (!lastCell || lastCell.side !== oppSide) {
        return { harvested: 0, board, harvestedPits: [] };
    }

    const case1Idx = opponentCase1Index(player);
    let harvested = 0;
    const harvestedPits = [];
    const resultBoard = { nord: [...board.nord], sud: [...board.sud] };

    // Interdit : vider complètement le camp adverse → aucune prise
    if (resultBoard[oppSide].every(v => v === 0)) {
        return { harvested: 0, board: resultBoard, harvestedPits: [] };
    }

    const lastIdx = lastCell.index;
    const countAfter = lastCell.count;

    // Cas spécial : terminer en case 1 après tour(s) complet(s)
    const fullLaps = Math.floor(distributed / 14);
    if (lastIdx === case1Idx && fullLaps >= 1 && distributed >= 14) {
        if (countAfter >= 1) {
            harvested = 1;
            harvestedPits.push({ side: oppSide, index: lastIdx, count: 1 });
            resultBoard[oppSide][lastIdx] -= 1;
        }
        return { harvested, board: resultBoard, harvestedPits };
    }

    // Pas de prise 2-3-4 en case 1 si distribution s'y termine (hors chaîne)
    if (lastIdx === case1Idx) return { harvested: 0, board: resultBoard, harvestedPits: [] };

    // Prise standard : dernière case avec 2-4 graines (avant = 1-3)
    if (countAfter >= 2 && countAfter <= 4) {
        harvested += countAfter;
        harvestedPits.push({ side: oppSide, index: lastIdx, count: countAfter });
        resultBoard[oppSide][lastIdx] = 0;

        // Prise à la chaîne : cases précédentes vers la case n°1 adverse
        const chainStep = player === 2 ? 1 : -1;
        let chainIdx = lastIdx + chainStep;
        while (chainIdx >= 0 && chainIdx < CASES) {
            const c = resultBoard[oppSide][chainIdx];
            if (c >= 2 && c <= 4) {
                harvested += c;
                harvestedPits.push({ side: oppSide, index: chainIdx, count: c });
                resultBoard[oppSide][chainIdx] = 0;
                chainIdx += chainStep;
            } else break;
        }
    }

    return { harvested, board: resultBoard, harvestedPits };
}

/**
 * Interdit case 7 : semer 1 ou 2 graines chez l'adversaire
 * en jouant depuis sa case n°7 (peu importe le nombre ramassé).
 */
function violatesCase7Rule(player, simResult) {
    if (simResult.pickIndex !== playerCase7Index(player)) return false;
    const sown = seedsSownToOpponent(player, simResult);
    return sown > 0 && sown <= 2;
}

/**
 * Si contraint par la solidarité, les 1-2 graines semées chez l'adversaire
 * depuis la case 7 reviennent à l'adversaire (score), pas sur le tablier.
 */
function applyCase7SolidarityReturn(player, simResult) {
    if (!violatesCase7Rule(player, simResult)) return;

    const oppSide = opponentSide(player);
    const oppPlayer = player === 1 ? 2 : 1;
    const sown = seedsSownToOpponent(player, simResult);

    state.scores[oppPlayer - 1] += sown;

    let remaining = sown;
    for (let i = 0; i < CASES && remaining > 0; i++) {
        const gained = simResult.board[oppSide][i] - state[oppSide][i];
        if (gained <= 0) continue;
        const remove = Math.min(gained, remaining);
        simResult.board[oppSide][i] -= remove;
        remaining -= remove;
    }
}

/** Compte les graines semées chez l'adversaire */
function seedsSownToOpponent(player, simResult) {
    const oppSide = opponentSide(player);
    const before = state[oppSide].reduce((a, b) => a + b, 0);
    const after = simResult.board[oppSide].reduce((a, b) => a + b, 0);
    return after - before;
}

/** Coups légaux pour le joueur actuel */
function getLegalMoves() {
    if (state.gameOver) return [];

    const player = state.currentPlayer;
    const side = playerSide(player);
    const moves = [];

    for (let i = 0; i < CASES; i++) {
        if (state[side][i] === 0) continue;

        const sim = simulateMove(player, i);
        if (!sim) continue;

        moves.push({
            index: i,
            sim,
            case7Violation: violatesCase7Rule(player, sim),
        });
    }

    // Hors solidarité : interdit case 7 (1-2 graines chez l'adversaire)
    const pool = opponentSeeds(player) === 0
        ? moves
        : moves.filter(m => !m.case7Violation);

    // Règle de solidarité (adversaire sans aucune graine sur son camp)
    if (opponentSeeds(player) === 0) {
        if (pool.length === 0) return [];

        // Coups qui atteignent réellement le camp adverse
        const reachingOpponent = pool.filter(
            m => seedsSownToOpponent(player, m.sim) > 0
        );

        // Règle 3 : aucun coup n'atteint le camp adverse → fin de partie
        if (reachingOpponent.length === 0) return [];

        // Règle 1 : priorité aux coups distribuant au moins 7 graines chez l'adversaire
        const solidarityMoves = reachingOpponent.filter(
            m => seedsSownToOpponent(player, m.sim) >= 7
        );
        if (solidarityMoves.length > 0) return solidarityMoves;

        // Règle 2 : sinon, maximum de graines transmises à l'adversaire
        const maxSown = Math.max(
            ...reachingOpponent.map(m => seedsSownToOpponent(player, m.sim))
        );
        return reachingOpponent.filter(
            m => seedsSownToOpponent(player, m.sim) === maxSown
        );
    }

    return pool;
}

/**
 * Explique pourquoi un clic sur une case est refusé.
 * Retourne null si le coup est autorisé.
 */
function explainRefusedMove(clickPlayer, pickIndex) {
    if (!state || state.gameOver) return null;

    if (clickPlayer !== state.currentPlayer) {
        return `Ce n'est pas votre tour — c'est au tour du Joueur ${state.currentPlayer}.`;
    }

    const player = state.currentPlayer;
    const side = playerSide(player);

    if (state[side][pickIndex] === 0) {
        return 'Cette case est vide : choisissez une case contenant des graines.';
    }

    const legal = getLegalMoves();
    if (legal.some((m) => m.index === pickIndex)) return null;

    const sim = simulateMove(player, pickIndex);
    if (!sim) return 'Ce coup n\'est pas autorisé.';

    const sown = seedsSownToOpponent(player, sim);
    const oppEmpty = opponentSeeds(player) === 0;

    if (!oppEmpty && violatesCase7Rule(player, sim)) {
        return 'Interdit depuis la case 7 : vous ne pouvez semer que 3 graines ou plus chez l\'adversaire (1 ou 2 graines interdites).';
    }

    if (oppEmpty) {
        if (sown === 0) {
            return 'Solidarité : ce coup n\'atteint pas le camp adverse. Distribuez des graines chez l\'adversaire.';
        }

        const sideMoves = [];
        for (let i = 0; i < CASES; i++) {
            if (state[side][i] === 0) continue;
            const moveSim = simulateMove(player, i);
            if (!moveSim) continue;
            sideMoves.push({ index: i, sim: moveSim });
        }

        const reaching = sideMoves.filter((m) => seedsSownToOpponent(player, m.sim) > 0);
        const solidarityMoves = reaching.filter((m) => seedsSownToOpponent(player, m.sim) >= 7);

        if (solidarityMoves.length > 0 && sown < 7) {
            return 'Solidarité : vous devez distribuer au moins 7 graines à l\'adversaire.';
        }

        if (reaching.length > 0) {
            const maxSown = Math.max(...reaching.map((m) => seedsSownToOpponent(player, m.sim)));
            if (sown < maxSown) {
                return `Solidarité : choisissez le coup qui transmet le plus de graines à l'adversaire (${maxSown} graines).`;
            }
        }
    }

    return 'Ce coup n\'est pas autorisé selon les règles du Songo.';
}

/** Solidarité impossible : adversaire vide, on a des graines, mais aucun coup ne l'atteint */
function isSolidarityImpossible(player) {
    if (opponentSeeds(player) !== 0) return false;
    const side = playerSide(player);
    if (state[side].every(v => v === 0)) return false;
    return getLegalMoves().length === 0;
}

/** Applique un coup (avec animation de distribution) */
async function playMove(pickIndex) {
    const player = state.currentPlayer;
    const legal = getLegalMoves();
    const move = legal.find(m => m.index === pickIndex);
    if (!move) return false;

    const sim = move.sim;
    const boardBefore = {
        nord: [...state.nord],
        sud: [...state.sud],
        scores: [...state.scores],
    };

    // Solidarité forcée + case 7 : graines rendues à l'adversaire avant récolte
    if (move.case7Violation) {
        applyCase7SolidarityReturn(player, sim);
    }

    const { harvested, board, harvestedPits } = calculateHarvest(player, sim);
    const pickSide = playerSide(player);
    const lastMove = {
        player,
        pickIndex,
        pickSide,
        caseNumber: caseNumber(pickSide, pickIndex),
        seedsPicked: sim.seedsPicked,
        sowSteps: sim.sowSteps || [],
        harvested,
        harvestedPits: harvestedPits || [],
    };

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion && lastMove.sowSteps.length > 0) {
        isAnimating = true;
        try {
            await animateMove(lastMove, boardBefore);
        } finally {
            isAnimating = false;
        }
    }

    state.nord = board.nord;
    state.sud = board.sud;
    state.scores[player - 1] += harvested;

    checkEndConditions();

    if (!state.gameOver) {
        state.currentPlayer = player === 1 ? 2 : 1;
        state.message = `Tour de Joueur ${state.currentPlayer}`;
        if (isSolidarityImpossible(state.currentPlayer)) {
            endGameBySolidarity();
        }
    }

    return true;
}

/** Vérifie les conditions de fin */
function checkEndConditions() {
    if (state.scores[0] >= WIN_SCORE) {
        markGameOver('Joueur 1 gagne avec 40 graines ou plus !');
        return;
    }
    if (state.scores[1] >= WIN_SCORE) {
        markGameOver('Joueur 2 gagne avec 40 graines ou plus !');
        return;
    }
    if (boardTotal() < MIN_BOARD_SEEDS) {
        // Graines restantes au propriétaire
        state.scores[0] += state.sud.reduce((a, b) => a + b, 0);
        state.scores[1] += state.nord.reduce((a, b) => a + b, 0);
        state.nord = Array(CASES).fill(0);
        state.sud = Array(CASES).fill(0);
        markGameOver(resolveWinner());
    }
}

/** Fin par solidarité impossible */
function endGameBySolidarity() {
    state.scores[0] += state.sud.reduce((a, b) => a + b, 0);
    state.scores[1] += state.nord.reduce((a, b) => a + b, 0);
    state.nord = Array(CASES).fill(0);
    state.sud = Array(CASES).fill(0);
    markGameOver('Solidarité impossible. ' + resolveWinner());
}

function resolveWinner() {
    if (state.scores[0] >= WIN_SCORE) return 'Joueur 1 gagne !';
    if (state.scores[1] >= WIN_SCORE) return 'Joueur 2 gagne !';
    // Règle officielle : nul si aucun joueur n'atteint 40 graines
    return 'Match nul — aucun joueur n\'a atteint 40 graines.';
}

/** Détermine le vainqueur d'une partie terminée (1, 2 ou nul) */
function getMatchWinner() {
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
    });

    if (snapshot.scores) {
        document.querySelectorAll('.score-value').forEach((el) => {
            const p = parseInt(el.dataset.player, 10);
            el.textContent = snapshot.scores[p - 1];
        });
    }
}

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

    pit.addEventListener('click', () => {
        if (state.gameOver || isAnimating) return;

        const refusal = explainRefusedMove(player, index);
        if (refusal) {
            showMoveRefusal(refusal);
            return;
        }

        playMove(index).then((ok) => {
            if (ok) renderGame();
        });
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

    const legalMoves = getLegalMoves();
    const legalIndices = new Set(legalMoves.map(m => m.index));
    const currentSide = playerSide(state.currentPlayer);

    // Uniquement les cases du plateau de jeu (pas celles du menu)
    document.querySelectorAll('#game-board .pit').forEach((pit) => {
        const player = parseInt(pit.dataset.player, 10);
        const index = parseInt(pit.dataset.index, 10);
        const side = pit.dataset.side;
        const count = state[side][index];

        pit.classList.toggle('pit--playable',
            !state.gameOver &&
            player === state.currentPlayer &&
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

function quitAfterGame() {
    if (!state) return;
    state.endChoiceMade = true;
    hideGameEndActions();
    goToMenu();
}

function continueAfterGame() {
    if (!state) return;
    state.endChoiceMade = true;
    hideGameEndActions();
    startGame();
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
function resetApplication() {
    setOptionsMenuOpen(false);
    closeRules();
    closeAbout();

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

function startGame() {
    hideGameEndActions();
    const refusal = document.getElementById('move-refusal');
    if (refusal) {
        refusal.hidden = true;
        refusal.innerHTML = '';
    }
    // Afficher l'écran de jeu en premier (retour visuel immédiat)
    showScreen('game');
    state = createInitialState();
    buildBoard();
    renderGame();
}

function abandonGame() {
    if (confirm('Abandonner la partie et retourner au menu ?')) {
        goToMenu();
    }
}

function restartGame() {
    if (confirm('Recommencer une nouvelle partie ?')) {
        startGame();
    }
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
            startGame();
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
