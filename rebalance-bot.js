import { ethers } from 'ethers';
import { CONFIG } from './config.js';
import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';

global.fetch = fetch;

class RebalanceBot {
  constructor() {
    this.provider = new ethers.JsonRpcProvider(CONFIG.BASE_RPC_URL);
    this.wallet = new ethers.Wallet(process.env.REBALANCE_PRIVATE_KEY || CONFIG.PRIVATE_KEY, this.provider);
    this.address = process.env.REBALANCE_WALLET_ADDRESS || this.wallet.address;
    this.tokens = {
      cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
      WETH: '0x4200000000000000000000000000000000000006',
      cbXRP: '0xcb585250f852C6c6bf90434AB21A00f02833a4af',
      cbADA: '0xcbADA732173e39521CDBE8bf59a6Dc85A9fc7b8c',
      cbDOGE: '0xcbD06E5A2B0C65597161de254AA074E489dEb510',
      AAVE: '0x63706e401c06ac8513145b7687A14804d17f814b'
    };
    // Set weights - use custom weights from env if provided, otherwise equal allocation
    if (process.env.CUSTOM_WEIGHTS) {
      try {
        this.weights = JSON.parse(process.env.CUSTOM_WEIGHTS);
        this.log(`📊 Using custom weights: ${JSON.stringify(this.weights)}`);
      } catch (error) {
        this.log(`⚠️ Invalid CUSTOM_WEIGHTS format, using equal allocation: ${error.message}`);
        this.weights = Object.fromEntries(Object.keys(this.tokens).map(token => [token, 1 / Object.keys(this.tokens).length]));
      }
    } else {
      this.weights = Object.fromEntries(Object.keys(this.tokens).map(token => [token, 1 / Object.keys(this.tokens).length]));
    }
    this.deviationThreshold = parseFloat(process.env.DEVIATION_THRESHOLD) || 0.05; // Use env var or default to 5%
    this.minTradeUSD = parseFloat(process.env.MIN_TRADE_USD) || 5.0; // Use env var or default
    this.slippagePercent = 0.005; // 0.5%
    this.checkInterval = 4 * 60 * 60 * 1000; // 4 hours - less frequent rebalancing
    this.baseToken = 'WETH';
    this.logFile = process.env.LOG_FILE || 'rebalance.log';

    // HODL comparison - initial balances
    this.initialBalances = {
      cbBTC: 0.00039425,
      WETH: 0.011770838913082286,
      cbXRP: 14.372532,
      cbADA: 57.198991,
      cbDOGE: 193.63635038,
      AAVE: 0.14303047477213357
    };

    // Track start date for performance calculations
    this.startDate = new Date().toISOString();
    this.dataFile = 'rebalance-data.json';

    // Load existing data if available
    this.loadData();

    // Price caching for fallback
    this.lastKnownPrices = {};
    this.priceCache = {
      prices: {},
      timestamp: 0,
      maxAge: 5 * 60 * 1000 // 5 minutes
    };

    this.bot = process.env.REBALANCE_BOT_TOKEN ? new TelegramBot(process.env.REBALANCE_BOT_TOKEN, {
      polling: {
        interval: 5000, // Slower polling to avoid rate limits
        autoStart: true,
        params: {
          timeout: 10
        }
      }
    }) : null;

    // Add error handling for Telegram bot
    if (this.bot) {
      this.bot.on('polling_error', (error) => {
        console.log(`📱 Telegram polling error (will retry): ${error.message}`);
        // Don't crash the bot, just log and continue
      });
    }

    // Support multiple chat IDs
    this.chatIds = [];
    if (process.env.REBALANCE_CHAT_ID) {
      this.chatIds = process.env.REBALANCE_CHAT_ID.split(',').map(id => id.trim().replace(/^=/, ''));
    }

    if (this.bot) {
      this.bot.onText('/status', async (msg) => {
        if (!this.chatIds.includes(msg.chat.id.toString())) return;
        await this.sendDetailedStatus();
      });

      this.bot.onText('/hodl', async (msg) => {
        if (!this.chatIds.includes(msg.chat.id.toString())) return;
        await this.sendHodlComparison();
      });

      this.bot.onText('/portfolio', async (msg) => {
        if (!this.chatIds.includes(msg.chat.id.toString())) return;
        await this.sendPortfolioWithHodl();
      });

      this.bot.onText('/debug', async (msg) => {
        if (!this.chatIds.includes(msg.chat.id.toString())) return;
        const debugInfo = `🔧 *Debug Info*\n` +
          `Bot Token: ${this.bot ? '✅ Set' : '❌ Missing'}\n` +
          `Chat IDs: ${this.chatIds.join(', ')}\n` +
          `Your Chat ID: ${msg.chat.id}\n` +
          `Authorized: ${this.chatIds.includes(msg.chat.id.toString()) ? '✅' : '❌'}`;
        await this.bot.sendMessage(msg.chat.id, debugInfo, { parse_mode: 'Markdown' });
      });

      this.bot.onText('/reset_hodl', async (msg) => {
        if (!this.chatIds.includes(msg.chat.id.toString())) return;

        try {
          const currentBalances = await this.getBalances();
          this.initialBalances = { ...currentBalances };
          this.startDate = new Date().toISOString();
          this.saveData();

          await this.bot.sendMessage(msg.chat.id,
            `✅ *HODL Baseline Reset*\nNew baseline set to current balances\nStart Date: ${new Date(this.startDate).toLocaleDateString()}`,
            { parse_mode: 'Markdown' }
          );
        } catch (error) {
          await this.bot.sendMessage(msg.chat.id, '❌ Failed to reset HODL baseline');
        }
      });
    }

    console.log(`📱 Telegram Bot: ${this.bot ? 'Enabled' : 'Disabled'}`);
    console.log(`📱 Chat IDs: ${this.chatIds.length > 0 ? this.chatIds.join(', ') : 'None configured'}`);

    this.log('🚀 Rebalance Bot initialized with HODL tracking');
    this.wethContract = new ethers.Contract(this.tokens.WETH, ['function deposit() payable'], this.wallet);
  }

  // Data persistence methods
  saveData() {
    const data = {
      initialBalances: this.initialBalances,
      startDate: this.startDate,
      lastKnownPrices: this.lastKnownPrices,
      lastUpdated: new Date().toISOString()
    };

    try {
      fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2));
    } catch (error) {
      this.log(`❌ Failed to save data: ${error.message}`);
    }
  }

  loadData() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const data = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));

        if (data.initialBalances) {
          this.initialBalances = data.initialBalances;
        }
        if (data.startDate) {
          this.startDate = data.startDate;
        }
        if (data.lastKnownPrices) {
          this.lastKnownPrices = data.lastKnownPrices;
        }

        this.log(`📂 Loaded saved data from ${data.lastUpdated}`);
      }
    } catch (error) {
      this.log(`❌ Failed to load data: ${error.message}`);
    }
  }

  // Calculate HODL comparison
  calculateHodlComparison(currentBalances, currentPrices) {
    const currentValue = Object.keys(currentBalances).reduce((sum, token) => {
      return sum + (currentBalances[token] * currentPrices[token]);
    }, 0);

    const hodlValue = Object.keys(this.initialBalances).reduce((sum, token) => {
      return sum + (this.initialBalances[token] * currentPrices[token]);
    }, 0);

    let initialValue = 0;
    if (this.lastKnownPrices && Object.keys(this.lastKnownPrices).length > 0) {
      initialValue = Object.keys(this.initialBalances).reduce((sum, token) => {
        return sum + (this.initialBalances[token] * (this.lastKnownPrices[token] || currentPrices[token]));
      }, 0);
    } else {
      initialValue = hodlValue;
    }

    const rebalanceGainLoss = currentValue - initialValue;
    const hodlGainLoss = hodlValue - initialValue;
    const rebalanceVsHodl = currentValue - hodlValue;

    const rebalanceGainLossPercent = initialValue > 0 ? (rebalanceGainLoss / initialValue) * 100 : 0;
    const hodlGainLossPercent = initialValue > 0 ? (hodlGainLoss / initialValue) * 100 : 0;
    const rebalanceVsHodlPercent = hodlValue > 0 ? (rebalanceVsHodl / hodlValue) * 100 : 0;

    const daysSinceStart = Math.max(1, Math.floor((Date.now() - new Date(this.startDate).getTime()) / (1000 * 60 * 60 * 24)));

    return {
      currentValue,
      hodlValue,
      initialValue,
      rebalanceGainLoss,
      hodlGainLoss,
      rebalanceVsHodl,
      rebalanceGainLossPercent,
      hodlGainLossPercent,
      rebalanceVsHodlPercent,
      daysSinceStart,
      startDate: this.startDate
    };
  }

  async sendHodlComparison() {
    if (!this.bot || this.chatIds.length === 0) return;

    try {
      const balances = await this.getBalances();
      const prices = await this.getPrices();

      if (!prices) {
        this.sendToAllChats('❌ Unable to fetch current prices for HODL comparison');
        return;
      }

      const comparison = this.calculateHodlComparison(balances, prices);

      let message = `🏆 *HODL vs Rebalance Comparison*\n`;
      message += `📅 Since: ${new Date(comparison.startDate).toLocaleDateString()} (${comparison.daysSinceStart} days)\n\n`;

      message += `💰 *Current Values:*\n`;
      message += `Rebalanced: $${comparison.currentValue.toFixed(2)}\n`;
      message += `HODL: $${comparison.hodlValue.toFixed(2)}\n`;
      message += `Initial: $${comparison.initialValue.toFixed(2)}\n\n`;

      message += `📊 *Performance vs Initial:*\n`;
      message += `Rebalanced: ${comparison.rebalanceGainLoss > 0 ? '+' : ''}$${comparison.rebalanceGainLoss.toFixed(2)} (${comparison.rebalanceGainLossPercent > 0 ? '+' : ''}${comparison.rebalanceGainLossPercent.toFixed(2)}%)\n`;
      message += `HODL: ${comparison.hodlGainLoss > 0 ? '+' : ''}$${comparison.hodlGainLoss.toFixed(2)} (${comparison.hodlGainLossPercent > 0 ? '+' : ''}${comparison.hodlGainLossPercent.toFixed(2)}%)\n\n`;

      message += `⚖️ *Rebalance vs HODL:*\n`;
      message += `Difference: ${comparison.rebalanceVsHodl > 0 ? '+' : ''}$${comparison.rebalanceVsHodl.toFixed(2)}\n`;
      message += `Performance: ${comparison.rebalanceVsHodlPercent > 0 ? '+' : ''}${comparison.rebalanceVsHodlPercent.toFixed(2)}%\n`;
      message += `${comparison.rebalanceVsHodl > 0 ? '🎉 Rebalancing is winning!' : '📉 HODL would be better'}\n\n`;

      message += `📋 *Initial HODL Balances:*\n`;
      Object.keys(this.initialBalances).forEach(token => {
        const initialAmount = this.initialBalances[token];
        const currentValue = initialAmount * prices[token];
        message += `${token}: ${initialAmount.toFixed(6)} ($${currentValue.toFixed(2)})\n`;
      });

      this.sendToAllChats(message);

    } catch (error) {
      this.log(`❌ Failed to send HODL comparison: ${error.message}`);
      this.sendToAllChats('❌ Error calculating HODL comparison');
    }
  }

  async sendPortfolioWithHodl() {
    try {
      const balances = await this.getBalances();
      const prices = await this.getPrices();
      if (!prices) return this.sendToAllChats('❌ Unable to fetch prices');

      const weights = await this.calculateWeights(balances, prices);
      const comparison = this.calculateHodlComparison(balances, prices);

      let msg = `💰 *Portfolio Status*\n`;
      msg += `Current: $${comparison.currentValue.toFixed(2)}\n`;
      msg += `HODL: $${comparison.hodlValue.toFixed(2)} (${comparison.rebalanceVsHodl > 0 ? '+' : ''}$${comparison.rebalanceVsHodl.toFixed(2)})\n\n`;

      Object.keys(this.tokens).forEach(token => {
        const balance = balances[token] || 0;
        const value = balance * prices[token];
        const percent = weights[token] * 100;
        const target = this.weights[token] * 100;
        const deviation = percent - target;

        msg += `${token}: $${value.toFixed(2)} (${percent.toFixed(1)}%)\n`;
        msg += `Target: ${target.toFixed(1)}% | Dev: ${deviation > 0 ? '+' : ''}${deviation.toFixed(1)}%\n\n`;
      });

      msg += `🏆 *Performance Summary:*\n`;
      msg += `Rebalancing: ${comparison.rebalanceVsHodl > 0 ? '🎉 Winning' : '📉 Behind'} by ${Math.abs(comparison.rebalanceVsHodlPercent).toFixed(2)}%`;

      this.sendToAllChats(msg);
    } catch (error) {
      this.sendToAllChats('❌ Portfolio status failed');
    }
  }

  log(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    console.log(message);
    try {
      if (this.logFile) {
        fs.appendFileSync(this.logFile, logMessage);
      }
    } catch (error) {
      console.log(`⚠️ Failed to write to log file: ${error.message}`);
    }

    if (this.bot && this.chatIds.length > 0) {
      const shouldNotify = message.includes('Rebalanced') ||
        message.includes('🔄 Swapped') ||
        message.includes('❌') ||
        message.includes('⚖️');

      if (shouldNotify) {
        console.log(`📱 Sending Telegram notification: ${message.substring(0, 50)}...`);
        this.sendToAllChats(message).catch(error => {
          console.log(`📱 Telegram send failed: ${error.message}`);
        });
      }
    }
  }

  async sendDetailedStatus() {
    if (!this.bot || this.chatIds.length === 0) return;

    try {
      const balances = await this.getBalances();
      const prices = await this.getPrices();

      if (!prices) {
        this.sendToAllChats('❌ Unable to fetch current prices');
        return;
      }

      const weights = await this.calculateWeights(balances, prices);
      const comparison = this.calculateHodlComparison(balances, prices);

      let statusMsg = `💰 *Portfolio Status*\n`;
      statusMsg += `Total Value: ${comparison.currentValue.toFixed(2)}\n`;
      statusMsg += `HODL Value: ${comparison.hodlValue.toFixed(2)}\n`;
      statusMsg += `Difference: ${comparison.rebalanceVsHodl > 0 ? '+' : ''}$${comparison.rebalanceVsHodl.toFixed(2)} (${comparison.rebalanceVsHodlPercent > 0 ? '+' : ''}${comparison.rebalanceVsHodlPercent.toFixed(2)}%)\n\n`;

      const sortedTokens = Object.keys(this.tokens).sort((a, b) => weights[b] - weights[a]);

      for (const token of sortedTokens) {
        const balance = balances[token] || 0;
        const price = prices[token] || 0;
        const value = balance * price;
        const currentPercent = weights[token] * 100;
        const targetPercent = this.weights[token] * 100;
        const deviation = currentPercent - targetPercent;

        let emoji = '🔵';
        if (Math.abs(deviation) > 2) {
          emoji = deviation > 0 ? '🔴' : '🟢';
        }

        statusMsg += `${emoji} *${token}*\n`;
        statusMsg += `   Balance: ${balance.toFixed(6)}\n`;
        statusMsg += `   Value: ${value.toFixed(2)}\n`;
        statusMsg += `   Current: ${currentPercent.toFixed(1)}% | Target: ${targetPercent.toFixed(1)}%\n`;
        statusMsg += `   Deviation: ${deviation > 0 ? '+' : ''}${deviation.toFixed(1)}%\n\n`;
      }

      const needsRebalance = Object.keys(weights).some(token =>
        Math.abs(weights[token] - this.weights[token]) > this.deviationThreshold
      );

      statusMsg += needsRebalance ? '⚖️ *Rebalancing needed*' : '✅ *Portfolio balanced*';
      statusMsg += `\n\n🏆 Rebalancing ${comparison.rebalanceVsHodl > 0 ? 'outperforming' : 'underperforming'} HODL by ${Math.abs(comparison.rebalanceVsHodlPercent).toFixed(2)}%`;

      this.sendToAllChats(statusMsg);

    } catch (error) {
      this.log(`❌ Failed to send detailed status: ${error.message}`);
      this.sendToAllChats('❌ Error fetching portfolio status');
    }
  }

  async sendRebalanceNotification(trades, balances, prices) {
    if (!this.bot || this.chatIds.length === 0) return;

    try {
      const comparison = this.calculateHodlComparison(balances, prices);

      let message = `⚖️ *Rebalancing Portfolio*\n`;
      message += `Total Value: ${comparison.currentValue.toFixed(2)}\n`;
      message += `vs HODL: ${comparison.rebalanceVsHodl > 0 ? '+' : ''}$${comparison.rebalanceVsHodl.toFixed(2)}\n\n`;

      for (const trade of trades) {
        const balance = balances[trade.token] || 0;
        const price = prices[trade.token] || 0;
        const value = balance * price;
        const deviation = trade.diff * 100;

        message += `${trade.diff > 0 ? '🔴 SELL' : '🟢 BUY'} ${trade.token}\n`;
        message += `   Balance: ${balance.toFixed(6)}\n`;
        message += `   Value: ${value.toFixed(2)}\n`;
        message += `   Deviation: ${deviation > 0 ? '+' : ''}${deviation.toFixed(1)}%\n\n`;
      }

      this.sendToAllChats(message);

    } catch (error) {
      this.log(`❌ Failed to send rebalance notification: ${error.message}`);
    }
  }

  async sendToAllChats(message) {
    if (!this.bot || this.chatIds.length === 0) return;

    for (const chatId of this.chatIds) {
      try {
        const escapedMessage = message.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        await this.bot.sendMessage(chatId, escapedMessage, { parse_mode: 'MarkdownV2' });
      } catch (error) {
        try {
          await this.bot.sendMessage(chatId, message);
        } catch (fallbackError) {
          this.log(`📱 Failed to send to chat ${chatId}: ${fallbackError.message}`);
        }
      }
    }
  }

  async getPrices() {
    const now = Date.now();
    if (this.priceCache.timestamp && (now - this.priceCache.timestamp) < this.priceCache.maxAge) {
      this.log('📦 Using cached prices');
      return this.priceCache.prices;
    }

    let prices = await this.getPricesFromBinance();
    if (prices) {
      this.lastKnownPrices = { ...this.lastKnownPrices, ...prices };
      this.saveData();
      return prices;
    }

    if (Object.keys(this.lastKnownPrices).length > 0) {
      this.log(`📦 Using last known prices as fallback`);
      return this.lastKnownPrices;
    }

    this.log(`❌ No price sources available, skipping this cycle`);
    return null;
  }

  async getPricesFromBinance() {
    try {
      this.log(`🟡 Binance: Fetching prices`);

      const symbolMap = {
        'cbBTC': 'BTCUSDT',
        'WETH': 'ETHUSDT',
        'cbXRP': 'XRPUSDT',
        'cbADA': 'ADAUSDT',
        'cbDOGE': 'DOGEUSDT',
        'AAVE': 'AAVEUSDT'
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`https://api.binance.com/api/v3/ticker/price`, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      const prices = {};
      const reverseMap = Object.fromEntries(
        Object.entries(symbolMap).map(([k, v]) => [v, k])
      );

      for (const ticker of data) {
        const token = reverseMap[ticker.symbol];
        if (token) {
          prices[token] = parseFloat(ticker.price);
        }
      }

      if (Object.keys(prices).length >= 6) {
        this.log(`✅ Binance: Got ${Object.keys(prices).length}/6 prices`);

        this.priceCache = {
          prices,
          timestamp: Date.now()
        };
        this.lastKnownPrices = { ...this.lastKnownPrices, ...prices };

        return prices;
      } else {
        throw new Error(`Only got ${Object.keys(prices).length}/6 prices from Binance`);
      }

    } catch (error) {
      this.log(`⚠️ Binance fetch failed: ${error.message}`);
      return null;
    }
  }

  async getBalances() {
    this.log(`Checking balances for address: ${this.address}`);
    const balances = {};

    for (const [name, address] of Object.entries(this.tokens)) {
      try {
        const contract = new ethers.Contract(address, [
          'function balanceOf(address) view returns (uint256)',
          'function decimals() view returns (uint8)'
        ], this.provider);

        const [balance, decimals] = await Promise.all([
          contract.balanceOf(this.address),
          contract.decimals()
        ]);

        balances[name] = parseFloat(ethers.formatUnits(balance, decimals));
        this.log(`${name}: ${balances[name]}`);

      } catch (error) {
        this.log(`⚠️ Failed to get balance for ${name}: ${error.message}`);
        balances[name] = 0;
      }
    }

    return balances;
  }

  async getQuote(sellToken, buyToken, sellAmount) {
    const maxRetries = 2;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(`${CONFIG.COW_API_BASE}/quote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            sellToken,
            buyToken,
            kind: 'sell',
            sellAmountBeforeFee: sellAmount,
            from: this.address,
            receiver: this.address,
            appData: '0x' + '0'.repeat(64),
            validTo: Math.floor(Date.now() / 1000) + 3600
          })
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Quote failed: ${response.status} - ${error}`);
        }

        const quote = await response.json();
        this.log(`🔍 Quote response: ${JSON.stringify(quote)}`);

        // Handle different response structures
        if (quote.quote && quote.quote.buyAmount) {
          return quote.quote.buyAmount;
        } else if (quote.buyAmount) {
          return quote.buyAmount;
        } else {
          throw new Error(`Unexpected quote response structure: ${JSON.stringify(quote)}`);
        }

      } catch (error) {
        this.log(`⚠️ Quote attempt ${attempt} failed: ${error.message}`);
        if (attempt === maxRetries) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  async calculateWeights(balances, prices) {
    const totalValue = Object.keys(balances).reduce((sum, token) => {
      const value = balances[token] * prices[token];
      return sum + (isNaN(value) ? 0 : value);
    }, 0);

    if (totalValue === 0) {
      this.log('⚠️ Total portfolio value is 0');
      return Object.fromEntries(Object.keys(balances).map(token => [token, 0]));
    }

    return Object.fromEntries(Object.keys(balances).map(token => {
      const weight = (balances[token] * prices[token] / totalValue) || 0;
      return [token, weight];
    }));
  }

  async rebalance(currentWeights, balances, prices) {
    const trades = [];
    const totalValue = Object.keys(balances).reduce((sum, t) => sum + balances[t] * prices[t], 0);

    for (const token in currentWeights) {
      const diff = currentWeights[token] - this.weights[token];
      const valueDiff = diff * totalValue;
      this.log(`${token}: diff=${(diff * 100).toFixed(2)}%, valueDiff=$${valueDiff.toFixed(2)}`);
      if (Math.abs(diff) > this.deviationThreshold) {
        if (Math.abs(valueDiff) > this.minTradeUSD) {
          trades.push({ token, diff });
        }
      }
    }

    if (trades.length > 0) {
      this.log(`🔄 Rebalancing needed: ${trades.length} trades`);

      await this.sendRebalanceNotification(trades, balances, prices);

      // Process sells first to generate WETH, then buys
      const sellTrades = trades.filter(t => t.diff > 0).sort((a, b) => b.diff - a.diff);
      const buyTrades = trades.filter(t => t.diff < 0).sort((a, b) => a.diff - b.diff);

      // Process all sells first
      for (const trade of sellTrades) {
        try {
          this.log(`🔄 Processing SELL trade: ${trade.token} (${(trade.diff * 100).toFixed(1)}% overweight)`);

          const currentValue = balances[trade.token] * prices[trade.token];
          const targetValue = totalValue * this.weights[trade.token];
          const excessValue = currentValue - targetValue;
          const sellAmount = excessValue / prices[trade.token];

          if (sellAmount >= 0.00001) {
            this.log(`🔴 SELLING ${sellAmount.toFixed(6)} ${trade.token} → WETH (excess: $${excessValue.toFixed(2)})`);

            const swapSuccess = await this.swap(trade.token, this.baseToken, sellAmount);

            if (swapSuccess) {
              // Update balances after successful sell
              balances[trade.token] -= sellAmount;
              const wethReceived = excessValue / prices[this.baseToken] * 0.98; // Account for slippage
              balances[this.baseToken] += wethReceived;
              this.log(`✅ Updated balances: ${trade.token} -${sellAmount.toFixed(6)}, WETH +${wethReceived.toFixed(6)}`);
            } else {
              this.log(`❌ Sell failed, skipping balance update for ${trade.token}`);
            }
          } else {
            this.log(`⚠️ Skipping tiny sell: ${sellAmount.toFixed(8)} ${trade.token}`);
          }

          // Small delay between trades to avoid overwhelming the system
          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
          this.log(`❌ Trade failed for ${trade.token}: ${error.message}`);
        }
      }

      // Handle WETH underweight by selling overweight tokens first
      const wethTrade = buyTrades.find(t => t.token === this.baseToken);
      if (wethTrade) {
        this.log(`🔄 Processing WETH underweight: ${(Math.abs(wethTrade.diff) * 100).toFixed(1)}% underweight`);
        
        // Calculate how much WETH we need
        const currentWethValue = balances[this.baseToken] * prices[this.baseToken];
        const targetWethValue = totalValue * this.weights[this.baseToken];
        const neededWethValue = targetWethValue - currentWethValue;
        
        this.log(`💡 Need ${neededWethValue.toFixed(2)} more WETH value. Selling overweight tokens...`);
        
        // Sell overweight tokens to generate the needed WETH
        let remainingNeeded = neededWethValue;
        
        // Find all overweight tokens (not just those flagged for trading)
        const overweightTokens = [];
        for (const token in currentWeights) {
          if (token === this.baseToken) continue; // Skip WETH itself
          
          const diff = currentWeights[token] - this.weights[token];
          if (diff > 0) { // Token is overweight
            const currentValue = balances[token] * prices[token];
            const targetValue = totalValue * this.weights[token];
            const excessValue = currentValue - targetValue;
            
            overweightTokens.push({
              token,
              diff,
              excessValue,
              currentValue,
              targetValue
            });
          }
        }
        
        // Sort by excess value (largest first)
        overweightTokens.sort((a, b) => b.excessValue - a.excessValue);
        
        for (const overweight of overweightTokens) {
          if (remainingNeeded <= 1) break; // Stop when we have enough (within $1)
          
          const sellValue = Math.min(overweight.excessValue, remainingNeeded);
          
          if (sellValue > this.minTradeUSD) {
            const sellAmount = sellValue / prices[overweight.token];
            
            this.log(`🔴 SELLING ${sellAmount.toFixed(6)} ${overweight.token} → WETH for rebalancing ($${sellValue.toFixed(2)})`);
            
            const swapSuccess = await this.swap(overweight.token, this.baseToken, sellAmount);
            
            if (swapSuccess) {
              balances[overweight.token] -= sellAmount;
              const wethReceived = sellValue / prices[this.baseToken] * 0.98; // Account for slippage
              balances[this.baseToken] += wethReceived;
              remainingNeeded -= sellValue;
              this.log(`✅ Generated ${wethReceived.toFixed(6)} WETH, remaining needed: $${remainingNeeded.toFixed(2)}`);
            } else {
              this.log(`❌ Failed to sell ${overweight.token} for WETH`);
            }
            
            await new Promise(resolve => setTimeout(resolve, 2000));
          } else {
            this.log(`⚠️ Skipping small excess in ${overweight.token}: $${sellValue.toFixed(2)}`);
          }
        }
      }

      // Now process buy trades with the WETH we have
      for (const trade of buyTrades) {
        try {
          this.log(`🔄 Processing BUY trade: ${trade.token} (${(Math.abs(trade.diff) * 100).toFixed(1)}% underweight)`);

          // Skip WETH buy trades as they're handled above
          if (trade.token === this.baseToken) {
            this.log(`✅ WETH rebalancing handled by selling overweight tokens`);
            continue;
          }

          const currentValue = balances[trade.token] * prices[trade.token];
          const targetValue = totalValue * this.weights[trade.token];
          const neededValue = targetValue - currentValue;
          const wethAmount = neededValue / prices[this.baseToken];

          if (wethAmount >= 0.0001) {
            if (balances[this.baseToken] >= wethAmount) {
              this.log(`🟢 BUYING ${trade.token} with ${wethAmount.toFixed(6)} WETH (needed: $${neededValue.toFixed(2)})`);

              const swapSuccess = await this.swap(this.baseToken, trade.token, wethAmount);

              if (swapSuccess) {
                // Update WETH balance for next iteration
                balances[this.baseToken] -= wethAmount;
                this.log(`✅ Updated WETH balance: -${wethAmount.toFixed(6)} (remaining: ${balances[this.baseToken].toFixed(6)})`);
              } else {
                this.log(`❌ Buy failed, skipping balance update for ${trade.token}`);
              }
            } else {
              this.log(`⚠️ Insufficient WETH: need ${wethAmount.toFixed(6)}, have ${balances[this.baseToken].toFixed(6)}`);
            }
          } else {
            this.log(`⚠️ Skipping tiny buy: ${wethAmount.toFixed(6)} WETH → ${trade.token}`);
          }

          // Small delay between trades
          await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
          this.log(`❌ Trade failed for ${trade.token}: ${error.message}`);
        }
      }

      this.log(`⚖️ Rebalanced portfolio`);
      await this.sendDetailedStatus();
    } else {
      this.log('✅ Check complete - no rebalance needed');
    }
  }

  async checkAndSetAllowance(tokenAddress, tokenSymbol) {
    try {
      const vaultRelayer = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';
      const tokenContract = new ethers.Contract(tokenAddress, [
        'function allowance(address owner, address spender) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function balanceOf(address) view returns (uint256)',
        'function decimals() view returns (uint8)'
      ], this.wallet);

      const [currentAllowance, balance, decimals] = await Promise.all([
        tokenContract.allowance(this.address, vaultRelayer),
        tokenContract.balanceOf(this.address),
        tokenContract.decimals()
      ]);

      const balanceFormatted = parseFloat(ethers.formatUnits(balance, decimals));
      const allowanceFormatted = parseFloat(ethers.formatUnits(currentAllowance, decimals));

      this.log(`🔍 ${tokenSymbol} allowance check: ${allowanceFormatted.toFixed(8)} / ${balanceFormatted.toFixed(8)}`);

      if (currentAllowance < balance) {
        this.log(`🔓 Setting max allowance for ${tokenSymbol}...`);
        const maxUint256 = ethers.MaxUint256;

        const gasEstimate = await tokenContract.approve.estimateGas(vaultRelayer, maxUint256);
        const approveTx = await tokenContract.approve(vaultRelayer, maxUint256, {
          gasLimit: gasEstimate * 120n / 100n
        });

        this.log(`⏳ Waiting for approval transaction: ${approveTx.hash}`);
        const receipt = await approveTx.wait();
        this.log(`✅ Allowance set for ${tokenSymbol} (block: ${receipt.blockNumber})`);

        await new Promise(resolve => setTimeout(resolve, 5000));

        const newAllowance = await tokenContract.allowance(this.address, vaultRelayer);
        const newAllowanceFormatted = parseFloat(ethers.formatUnits(newAllowance, decimals));
        this.log(`✅ Verified ${tokenSymbol} allowance: ${newAllowanceFormatted.toFixed(8)}`);
      } else {
        this.log(`✅ ${tokenSymbol} allowance already sufficient`);
      }

      return true;
    } catch (error) {
      this.log(`❌ Allowance error for ${tokenSymbol}: ${error.message}`);
      return false;
    }
  }

  async swap(fromToken, toToken, amount) {
    if (fromToken === toToken) {
      this.log(`⚠️ Skipping swap: same token (${fromToken})`);
      return false;
    }

    const fromAddress = this.tokens[fromToken];
    const toAddress = this.tokens[toToken];

    const allowanceOk = await this.checkAndSetAllowance(fromAddress, fromToken);
    if (!allowanceOk) {
      this.log(`❌ Failed to set allowance for ${fromToken}`);
      return false;
    }

    try {
      const fromContract = new ethers.Contract(fromAddress, ['function decimals() view returns (uint8)'], this.provider);
      const toContract = new ethers.Contract(toAddress, ['function decimals() view returns (uint8)'], this.provider);
      const [fromDecimals, toDecimals] = await Promise.all([
        fromContract.decimals(),
        toContract.decimals()
      ]);

      // Ensure we don't exceed token decimals - convert BigInt to number
      const fromDecimalsNum = Number(fromDecimals);
      const toDecimalsNum = Number(toDecimals);
      const maxDecimals = Math.min(8, fromDecimalsNum);

      this.log(`🔍 Token decimals: ${fromToken}=${fromDecimalsNum}, ${toToken}=${toDecimalsNum}, maxDecimals=${maxDecimals}`);
      this.log(`🔍 Amount to convert: ${amount.toFixed(maxDecimals)}`);

      const sellAmount = ethers.parseUnits(amount.toFixed(maxDecimals), fromDecimalsNum).toString();

      // FAST MARKET EXECUTION: Accept worse than quote for immediate fills
      this.log(`🔍 Getting quote for ${sellAmount} ${fromToken} → ${toToken}`);

      let quotedBuyAmount;
      try {
        quotedBuyAmount = await this.getQuote(fromAddress, toAddress, sellAmount);
        this.log(`🔍 Quote debug: type=${typeof quotedBuyAmount}, value=${quotedBuyAmount}`);
      } catch (quoteError) {
        this.log(`❌ Quote failed: ${quoteError.message}`);
        throw quoteError;
      }

      // Accept 2% worse than quote for very fast execution
      let minBuyAmount;
      try {
        // Ensure we have a clean string representation
        let cleanQuote;
        if (typeof quotedBuyAmount === 'number') {
          // If it's a number, convert to integer string (no decimals for BigInt)
          cleanQuote = Math.floor(quotedBuyAmount).toString();
        } else if (typeof quotedBuyAmount === 'string') {
          // If it's a string, remove any decimal points
          cleanQuote = quotedBuyAmount.split('.')[0];
        } else {
          // Convert to string and remove decimals
          cleanQuote = quotedBuyAmount.toString().split('.')[0];
        }

        this.log(`🔍 Clean quote for BigInt: ${cleanQuote}`);
        const quotedBigInt = BigInt(cleanQuote);
        minBuyAmount = (quotedBigInt * 98n / 100n).toString();
        this.log(`🔍 Calculated minBuyAmount: ${minBuyAmount}`);
      } catch (bigintError) {
        this.log(`❌ BigInt conversion failed: ${bigintError.message}, quotedBuyAmount=${quotedBuyAmount}, type=${typeof quotedBuyAmount}`);
        throw bigintError;
      }

      this.log(`💹 Fast market: ${amount.toFixed(6)} ${fromToken} → ${ethers.formatUnits(minBuyAmount, toDecimalsNum)} ${toToken} (2% below quote for speed)`);

      const order = {
        sellToken: fromAddress,
        buyToken: toAddress,
        sellAmount,
        buyAmount: minBuyAmount, // 2% worse than quote for fast fills
        validTo: Math.floor(Date.now() / 1000) + 300, // 5 minutes only for immediate execution
        appData: ethers.ZeroHash,
        feeAmount: '0',
        kind: 'sell',
        partiallyFillable: false,
        sellTokenBalance: 'erc20',
        buyTokenBalance: 'erc20',
        receiver: this.address
      };

      const domain = {
        name: 'Gnosis Protocol',
        version: 'v2',
        chainId: 8453,
        verifyingContract: '0x9008D19f58AAbD9eD0D60971565AA8510560ab41'
      };

      const types = {
        Order: [
          { name: 'sellToken', type: 'address' },
          { name: 'buyToken', type: 'address' },
          { name: 'receiver', type: 'address' },
          { name: 'sellAmount', type: 'uint256' },
          { name: 'buyAmount', type: 'uint256' },
          { name: 'validTo', type: 'uint32' },
          { name: 'appData', type: 'bytes32' },
          { name: 'feeAmount', type: 'uint256' },
          { name: 'kind', type: 'string' },
          { name: 'partiallyFillable', type: 'bool' },
          { name: 'sellTokenBalance', type: 'string' },
          { name: 'buyTokenBalance', type: 'string' }
        ]
      };

      const signature = await this.wallet.signTypedData(domain, types, order);

      const response = await fetch(`${CONFIG.COW_API_BASE}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...order, signature, signingScheme: 'eip712' })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Order failed: ${response.status} - ${errorText}`);
      }

      const orderId = await response.text();
      this.log(`🔄 FAST swap: ${amount.toFixed(6)} ${fromToken} → ${toToken} [${orderId.slice(0, 8)}]`);
      return true;

    } catch (error) {
      this.log(`❌ Swap error: ${error.message}`);
      return false;
    }
  }

  async start() {
    this.isRunning = true;
    this.log('🚀 Rebalance Bot started with HODL tracking');

    this.log('🔓 Setting up token allowances...');
    for (const [symbol, address] of Object.entries(this.tokens)) {
      await this.checkAndSetAllowance(address, symbol);
    }
    this.log('✅ Token allowances setup complete');

    if (this.bot && this.chatIds.length > 0) {
      this.sendToAllChats(`🚀 * Rebalance Bot Started *\n\n🏆 HODL Tracking Enabled\nBaseline: ${new Date(this.startDate).toLocaleDateString()} \n\nCommands: \n / status - Portfolio status\n / hodl - HODL comparison\n / portfolio - Portfolio with HODL\n / reset_hodl - Reset HODL baseline`);
    }

    try {
      const nativeBalance = await this.provider.getBalance(this.address);
      const minWrap = ethers.parseEther('0.1');
      if (nativeBalance > minWrap) {
        const wrapAmount = (nativeBalance * 9n / 10n);
        const tx = await this.wethContract.deposit({ value: wrapAmount, gasLimit: 100000 });
        await tx.wait();
        this.log(`🔄 Wrapped ${ethers.formatEther(wrapAmount)} ETH to WETH`);
      }
    } catch (error) {
      this.log(`⚠️ ETH wrap failed: ${error.message} `);
    }

    while (this.isRunning) {
      try {
        this.log('🔄 Starting portfolio check');
        const balances = await this.getBalances();
        const prices = await this.getPrices();

        if (prices) {
          const currentWeights = await this.calculateWeights(balances, prices);
          this.log(`Current weights: ${JSON.stringify(currentWeights)} `);

          const comparison = this.calculateHodlComparison(balances, prices);
          this.log(`📊 HODL Status: Rebalanced: ${comparison.currentValue.toFixed(2)}, HODL: ${comparison.hodlValue.toFixed(2)}, Diff: ${comparison.rebalanceVsHodl > 0 ? '+' : ''}${comparison.rebalanceVsHodl.toFixed(2)} (${comparison.rebalanceVsHodlPercent > 0 ? '+' : ''}${comparison.rebalanceVsHodlPercent.toFixed(2)}%)`);

          await this.rebalance(currentWeights, balances, prices);
        } else {
          this.log('⏸️ Skipping rebalance due to price fetch failure');
        }

      } catch (e) {
        this.log(`❌ Loop error: ${e.message} `);
      }

      this.log(`⏳ Waiting ${this.checkInterval / 1000}s for next check...`);
      await new Promise(resolve => setTimeout(resolve, this.checkInterval));
    }
  }

  stop() {
    this.isRunning = false;
    this.saveData();
    this.log('⏹️ Rebalance Bot stopped');
  }
}

async function main() {
  const bot = new RebalanceBot();

  process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    bot.stop();
    process.exit(0);
  });

  await bot.start();
}

main().catch(error => {
  console.error('💥 Fatal error:', error);
  process.exit(1);
});