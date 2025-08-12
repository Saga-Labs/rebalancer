import express from 'express';
import { RebalanceBot } from './rebalance-bot.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.WEB_PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Initialize bot instance
let bot = null;
let botRunning = false;

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', async (req, res) => {
  try {
    if (!bot) {
      return res.json({ 
        status: 'stopped',
        message: 'Bot not initialized',
        totalValue: '0.00',
        hodlValue: '0.00',
        performance: '0.00',
        performancePercent: '0.00',
        portfolio: [],
        config: {
          deviationThreshold: '5.0',
          minTradeUSD: 5.0,
          checkInterval: 240
        }
      });
    }

    const balances = await bot.getBalances();
    const prices = await bot.getPrices();
    
    if (!prices) {
      return res.json({
        status: 'error',
        message: 'Unable to fetch prices'
      });
    }

    const weights = await bot.calculateWeights(balances, prices);
    const comparison = bot.calculateHodlComparison(balances, prices);
    
    const totalValue = Object.keys(balances).reduce((sum, token) => {
      return sum + (balances[token] * prices[token]);
    }, 0);

    const portfolio = Object.keys(bot.tokens).map(token => ({
      token,
      balance: balances[token] || 0,
      price: prices[token] || 0,
      value: (balances[token] || 0) * (prices[token] || 0),
      currentWeight: (weights[token] || 0) * 100,
      targetWeight: (bot.weights[token] || 0) * 100,
      deviation: ((weights[token] || 0) - (bot.weights[token] || 0)) * 100
    }));

    res.json({
      status: botRunning ? 'running' : 'stopped',
      totalValue: totalValue.toFixed(2),
      hodlValue: comparison.hodlValue.toFixed(2),
      performance: comparison.rebalanceVsHodl.toFixed(2),
      performancePercent: comparison.rebalanceVsHodlPercent.toFixed(2),
      portfolio,
      config: {
        deviationThreshold: (bot.deviationThreshold * 100).toFixed(1),
        minTradeUSD: bot.minTradeUSD,
        checkInterval: bot.checkInterval / (60 * 1000) // minutes
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error.message
    });
  }
});

app.post('/api/start', async (req, res) => {
  try {
    if (botRunning) {
      return res.json({ message: 'Bot is already running' });
    }

    bot = new RebalanceBot();
    botRunning = true;
    
    // Start the bot's main loop
    bot.start();
    
    res.json({ message: 'Bot started successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stop', (req, res) => {
  try {
    if (!botRunning) {
      return res.json({ message: 'Bot is not running' });
    }

    if (bot && bot.stop) {
      bot.stop();
    }
    
    botRunning = false;
    bot = null;
    
    res.json({ message: 'Bot stopped successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/rebalance', async (req, res) => {
  try {
    if (!bot) {
      return res.status(400).json({ error: 'Bot not initialized' });
    }

    const balances = await bot.getBalances();
    const prices = await bot.getPrices();
    
    if (!prices) {
      return res.status(500).json({ error: 'Unable to fetch prices' });
    }

    const weights = await bot.calculateWeights(balances, prices);
    await bot.rebalance(weights, balances, prices);
    
    res.json({ message: 'Manual rebalance triggered' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/config', async (req, res) => {
  try {
    const { deviationThreshold, minTradeUSD, customWeights } = req.body;
    
    if (!bot) {
      return res.status(400).json({ error: 'Bot not initialized' });
    }

    if (deviationThreshold !== undefined) {
      bot.deviationThreshold = parseFloat(deviationThreshold) / 100;
    }
    
    if (minTradeUSD !== undefined) {
      bot.minTradeUSD = parseFloat(minTradeUSD);
    }
    
    if (customWeights) {
      // Validate weights sum to 1
      const totalWeight = Object.values(customWeights).reduce((sum, w) => sum + parseFloat(w), 0);
      if (Math.abs(totalWeight - 1) > 0.01) {
        return res.status(400).json({ error: 'Weights must sum to 100%' });
      }
      bot.weights = customWeights;
    }
    
    res.json({ message: 'Configuration updated successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Web interface running at http://localhost:${PORT}`);
});