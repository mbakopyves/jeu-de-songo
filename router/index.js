/**
 * Routes API REST du serveur Songo remote.
 */

'use strict';

const express = require('express');
const { getHealth } = require('../controllers/healthController');
const gameController = require('../controllers/gameController');

const router = express.Router();

router.get('/health', getHealth);

/* --- CRUD parties --- */
router.post('/games', gameController.create);
router.get('/games', gameController.listWaiting);
router.get('/games/:id', gameController.getOne);
router.post('/games/:id/join', gameController.join);
router.post('/games/:id/moves', gameController.playMove);
router.delete('/games/:id', gameController.remove);

module.exports = router;
