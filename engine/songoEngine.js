/**
 * Moteur de règles Songo — logique métier côté serveur.
 * Règles : https://www.clubawale.com/post/comment-jouer-le-songo
 */

'use strict';

const CASES = 7;
const INITIAL_SEEDS = 5;
const WIN_SCORE = 40;
const MIN_BOARD_SEEDS = 10;

const SOWING_LOOPS = {
    2: [
        ...[6, 5, 4, 3, 2, 1, 0].map((i) => ({ side: 'nord', index: i })),
        ...[6, 5, 4, 3, 2, 1, 0].map((i) => ({ side: 'sud', index: i })),
    ],
    1: [
        ...[6, 5, 4, 3, 2, 1, 0].map((i) => ({ side: 'sud', index: i })),
        ...[0, 1, 2, 3, 4, 5, 6].map((i) => ({ side: 'nord', index: i })),
    ],
};

function createInitialState() {
    return {
        nord: Array(CASES).fill(INITIAL_SEEDS),
        sud: Array(CASES).fill(INITIAL_SEEDS),
        scores: [0, 0],
        currentPlayer: 1,
        gameOver: false,
        message: 'Tour de Joueur 1',
    };
}

function playerSide(player) {
    return player === 2 ? 'nord' : 'sud';
}

function opponentSide(player) {
    return player === 2 ? 'sud' : 'nord';
}

function opponentCase1Index(player) {
    return player === 2 ? 6 : 0;
}

function playerCase7Index(player) {
    return player === 2 ? 6 : 0;
}

function boardTotal(state) {
    return state.nord.reduce((a, b) => a + b, 0) + state.sud.reduce((a, b) => a + b, 0);
}

function opponentSeeds(state, player) {
    const side = opponentSide(player);
    return state[side].reduce((a, b) => a + b, 0);
}

function simulateMove(state, player, pickIndex) {
    const side = playerSide(player);
    const seeds = state[side][pickIndex];
    if (seeds === 0) return null;

    const board = {
        nord: [...state.nord],
        sud: [...state.sud],
    };
    board[side][pickIndex] = 0;

    const loop = SOWING_LOOPS[player];
    let loopStart = loop.findIndex((c) => c.side === side && c.index === pickIndex);
    let pos = (loopStart + 1) % loop.length;
    let remaining = seeds;
    let lastCell = null;
    let distributed = 0;
    const skipSourceOnLap = seeds > 13;
    let completedLaps = 0;
    const seedsAtStart = seeds;
    /** Ordre de chaque graine semée (pour l'animation client) */
    const sowSteps = [];

    while (remaining > 0) {
        const cell = loop[pos];

        if (seedsAtStart > 13 && completedLaps >= 1 && cell.side === side) {
            pos = (pos + 1) % loop.length;
            if (pos === (loopStart + 1) % loop.length) completedLaps++;
            continue;
        }

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

    return {
        board, lastCell, distributed, pickIndex, pickSide: side, seedsPicked: seeds, sowSteps,
    };
}

function calculateHarvest(player, simResult) {
    const oppSide = opponentSide(player);
    const { board, lastCell, distributed } = simResult;

    if (!lastCell || lastCell.side !== oppSide) {
        return { harvested: 0, board, harvestedPits: [] };
    }

    const case1Idx = opponentCase1Index(player);
    let harvested = 0;
    const harvestedPits = [];
    const resultBoard = { nord: [...board.nord], sud: [...board.sud] };

    if (resultBoard[oppSide].every((v) => v === 0)) {
        return { harvested: 0, board: resultBoard, harvestedPits: [] };
    }

    const lastIdx = lastCell.index;
    const countAfter = lastCell.count;
    const fullLaps = Math.floor(distributed / 14);

    if (lastIdx === case1Idx && fullLaps >= 1 && distributed >= 14) {
        if (countAfter >= 1) {
            harvested = 1;
            harvestedPits.push({ side: oppSide, index: lastIdx, count: 1 });
            resultBoard[oppSide][lastIdx] -= 1;
        }
        return { harvested, board: resultBoard, harvestedPits };
    }

    if (lastIdx === case1Idx) return { harvested: 0, board: resultBoard, harvestedPits: [] };

    if (countAfter >= 2 && countAfter <= 4) {
        harvested += countAfter;
        harvestedPits.push({ side: oppSide, index: lastIdx, count: countAfter });
        resultBoard[oppSide][lastIdx] = 0;

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

function seedsSownToOpponent(state, player, simResult) {
    const oppSide = opponentSide(player);
    const before = state[oppSide].reduce((a, b) => a + b, 0);
    const after = simResult.board[oppSide].reduce((a, b) => a + b, 0);
    return after - before;
}

function violatesCase7Rule(state, player, simResult) {
    if (simResult.pickIndex !== playerCase7Index(player)) return false;
    const sown = seedsSownToOpponent(state, player, simResult);
    return sown > 0 && sown <= 2;
}

function applyCase7SolidarityReturn(state, player, simResult) {
    if (!violatesCase7Rule(state, player, simResult)) return;

    const oppSide = opponentSide(player);
    const oppPlayer = player === 1 ? 2 : 1;
    const sown = seedsSownToOpponent(state, player, simResult);

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

function getLegalMoves(state) {
    if (state.gameOver) return [];

    const player = state.currentPlayer;
    const side = playerSide(player);
    const moves = [];

    for (let i = 0; i < CASES; i++) {
        if (state[side][i] === 0) continue;

        const sim = simulateMove(state, player, i);
        if (!sim) continue;

        moves.push({
            index: i,
            sim,
            case7Violation: violatesCase7Rule(state, player, sim),
        });
    }

    const pool = opponentSeeds(state, player) === 0
        ? moves
        : moves.filter((m) => !m.case7Violation);

    if (opponentSeeds(state, player) === 0) {
        if (pool.length === 0) return [];

        const reachingOpponent = pool.filter(
            (m) => seedsSownToOpponent(state, player, m.sim) > 0
        );

        if (reachingOpponent.length === 0) return [];

        const solidarityMoves = reachingOpponent.filter(
            (m) => seedsSownToOpponent(state, player, m.sim) >= 7
        );
        if (solidarityMoves.length > 0) return solidarityMoves;

        const maxSown = Math.max(
            ...reachingOpponent.map((m) => seedsSownToOpponent(state, player, m.sim))
        );
        return reachingOpponent.filter(
            (m) => seedsSownToOpponent(state, player, m.sim) === maxSown
        );
    }

    return pool;
}

function getLegalMoveIndices(state) {
    return getLegalMoves(state).map((m) => m.index);
}

function explainRefusedMove(state, clickPlayer, pickIndex) {
    if (!state || state.gameOver) return null;

    if (clickPlayer !== state.currentPlayer) {
        return `Ce n'est pas votre tour — c'est au tour du Joueur ${state.currentPlayer}.`;
    }

    const player = state.currentPlayer;
    const side = playerSide(player);

    if (state[side][pickIndex] === 0) {
        return 'Cette case est vide : choisissez une case contenant des graines.';
    }

    const legal = getLegalMoves(state);
    if (legal.some((m) => m.index === pickIndex)) return null;

    const sim = simulateMove(state, player, pickIndex);
    if (!sim) return 'Ce coup n\'est pas autorisé.';

    const sown = seedsSownToOpponent(state, player, sim);
    const oppEmpty = opponentSeeds(state, player) === 0;

    if (!oppEmpty && violatesCase7Rule(state, player, sim)) {
        return 'Interdit depuis la case 7 : vous ne pouvez semer que 3 graines ou plus chez l\'adversaire (1 ou 2 graines interdites).';
    }

    if (oppEmpty) {
        if (sown === 0) {
            return 'Solidarité : ce coup n\'atteint pas le camp adverse. Distribuez des graines chez l\'adversaire.';
        }

        const sideMoves = [];
        for (let i = 0; i < CASES; i++) {
            if (state[side][i] === 0) continue;
            const moveSim = simulateMove(state, player, i);
            if (!moveSim) continue;
            sideMoves.push({ index: i, sim: moveSim });
        }

        const reaching = sideMoves.filter((m) => seedsSownToOpponent(state, player, m.sim) > 0);
        const solidarityMoves = reaching.filter((m) => seedsSownToOpponent(state, player, m.sim) >= 7);

        if (solidarityMoves.length > 0 && sown < 7) {
            return 'Solidarité : vous devez distribuer au moins 7 graines à l\'adversaire.';
        }

        if (reaching.length > 0) {
            const maxSown = Math.max(...reaching.map((m) => seedsSownToOpponent(state, player, m.sim)));
            if (sown < maxSown) {
                return `Solidarité : choisissez le coup qui transmet le plus de graines à l'adversaire (${maxSown} graines).`;
            }
        }
    }

    return 'Ce coup n\'est pas autorisé selon les règles du Songo.';
}

function isSolidarityImpossible(state, player) {
    if (opponentSeeds(state, player) !== 0) return false;
    const side = playerSide(player);
    if (state[side].every((v) => v === 0)) return false;
    return getLegalMoves(state).length === 0;
}

function resolveWinner(state) {
    if (state.scores[0] >= WIN_SCORE) return 'Joueur 1 gagne !';
    if (state.scores[1] >= WIN_SCORE) return 'Joueur 2 gagne !';
    return 'Match nul — aucun joueur n\'a atteint 40 graines.';
}

function getMatchWinner(state) {
    if (state.scores[0] >= WIN_SCORE) return 1;
    if (state.scores[1] >= WIN_SCORE) return 2;
    return 0;
}

function markGameOver(state, message) {
    if (state.gameOver) return;
    state.gameOver = true;
    state.message = message;
}

function checkEndConditions(state) {
    if (state.scores[0] >= WIN_SCORE) {
        markGameOver(state, 'Joueur 1 gagne avec 40 graines ou plus !');
        return;
    }
    if (state.scores[1] >= WIN_SCORE) {
        markGameOver(state, 'Joueur 2 gagne avec 40 graines ou plus !');
        return;
    }
    if (boardTotal(state) < MIN_BOARD_SEEDS) {
        state.scores[0] += state.sud.reduce((a, b) => a + b, 0);
        state.scores[1] += state.nord.reduce((a, b) => a + b, 0);
        state.nord = Array(CASES).fill(0);
        state.sud = Array(CASES).fill(0);
        markGameOver(state, resolveWinner(state));
    }
}

function endGameBySolidarity(state) {
    state.scores[0] += state.sud.reduce((a, b) => a + b, 0);
    state.scores[1] += state.nord.reduce((a, b) => a + b, 0);
    state.nord = Array(CASES).fill(0);
    state.sud = Array(CASES).fill(0);
    markGameOver(state, `Solidarité impossible. ${resolveWinner(state)}`);
}

/**
 * Joue un coup pour le joueur actuel.
 * @returns {{ ok: boolean, error?: string }}
 */
function playMove(state, pickIndex) {
    const player = state.currentPlayer;
    const refusal = explainRefusedMove(state, player, pickIndex);
    if (refusal) return { ok: false, error: refusal };

    const legal = getLegalMoves(state);
    const move = legal.find((m) => m.index === pickIndex);
    if (!move) return { ok: false, error: 'Ce coup n\'est pas autorisé.' };

    const sim = move.sim;

    if (move.case7Violation) {
        applyCase7SolidarityReturn(state, player, sim);
    }

    const { harvested, board, harvestedPits } = calculateHarvest(player, sim);

    state.nord = board.nord;
    state.sud = board.sud;
    state.scores[player - 1] += harvested;

    checkEndConditions(state);

    if (!state.gameOver) {
        state.currentPlayer = player === 1 ? 2 : 1;
        state.message = `Tour de Joueur ${state.currentPlayer}`;
        if (isSolidarityImpossible(state, state.currentPlayer)) {
            endGameBySolidarity(state);
        }
    }

    const pickSide = playerSide(player);
    const caseNum = pickSide === 'nord' ? pickIndex + 1 : CASES - pickIndex;

    return {
        ok: true,
        lastMove: {
            player,
            pickIndex,
            pickSide,
            caseNumber: caseNum,
            seedsPicked: sim.seedsPicked,
            sowSteps: sim.sowSteps,
            harvested,
            harvestedPits,
            lastSown: sim.sowSteps.length > 0
                ? sim.sowSteps[sim.sowSteps.length - 1]
                : null,
        },
    };
}

module.exports = {
    CASES,
    WIN_SCORE,
    createInitialState,
    getLegalMoves,
    getLegalMoveIndices,
    explainRefusedMove,
    playMove,
    getMatchWinner,
    resolveWinner,
};
