'use strict';

const express = require('express');
const system = require('../system');
const mcserver = require('../mcserver');
const config = require('../config');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const cfg = config.get();
  const [disk, java] = await Promise.all([
    system.diskUsage(cfg.server.directory),
    system.javaVersion(),
  ]);
  res.json({
    system: system.systemInfo(),
    process: system.processStats(mcserver.pid),
    disk,
    java,
    panelVersion: require('../../package.json').version,
    server: mcserver.status(),
  });
});

module.exports = router;
