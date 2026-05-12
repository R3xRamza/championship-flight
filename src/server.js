const express = require('express');
const cors = require('cors');
const path = require('path');
const apiRoutes = require('./api');

const app = express();
const START_PORT = Number(process.env.PORT) || 3001;

app.use(cors());
app.use(express.json());

// API routes
app.use('/api', apiRoutes);

// Serve frontend
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`\n  Championship Flight running on http://localhost:${port}\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = port + 1;
      console.warn(`Port ${port} is in use, trying ${nextPort}...`);
      startServer(nextPort);
      return;
    }
    throw err;
  });
}

startServer(START_PORT);
