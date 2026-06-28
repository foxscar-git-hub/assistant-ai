const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/status', (req, res) => {
  res.json({ ok: true, project: 'ассистент-new', port: PORT });
});

app.listen(PORT, () => {
  console.log(`Новый ассистент запущен: http://localhost:${PORT}`);
});
