# Crypto Portfolio Rebalance Bot

An automated cryptocurrency portfolio rebalancing bot that maintains target allocations across multiple tokens using CoW Protocol on Base network.

## Features

- **Automated Rebalancing**: Maintains target allocation across 6 crypto assets
- **Custom Portfolio Weights**: Configure your own allocation percentages (not just equal weights)
- **HODL Performance Tracking**: Compares rebalancing strategy vs buy-and-hold
- **Telegram Integration**: Real-time notifications and portfolio status with commands
- **CoW Protocol**: Uses CoW Protocol for MEV-protected, gas-efficient trades
- **Smart Trading Logic**: Intelligently handles WETH underweight by selling overweight assets
- **Configurable Parameters**: Customizable deviation thresholds, trade minimums, and check intervals
- **Persistent Data**: Saves performance data and continues tracking across restarts

## Supported Tokens (Base Network)

- cbBTC (Coinbase Wrapped Bitcoin)
- WETH (Wrapped Ethereum)
- cbXRP (Coinbase Wrapped XRP)
- cbADA (Coinbase Wrapped Cardano)
- cbDOGE (Coinbase Wrapped Dogecoin)
- AAVE (Aave Token)

## Installation

### Quick Start

1. Clone the repository:
```bash
git clone https://github.com/Saga-Labs/rebalancer.git
cd crypto-rebalance-bot
```

2. Install dependencies:
```bash
npm install
```

3. Copy and configure environment:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Start the bot:
```bash
npm start
```



## Configuration

The bot uses these configurable settings (set in your `.env` file):

- **Deviation Threshold**: 3% (triggers rebalancing, was 5% by default)
- **Minimum Trade**: $3 USD (lowered from $5 for better rebalancing)
- **Check Interval**: 4 hours (14,400,000 milliseconds)
- **Target Weights**: Equal allocation (16.67% each) or custom weights
- **Slippage Tolerance**: 2% below quote for fast execution

### Custom Portfolio Weights

You can set custom allocation percentages in your `.env` file:

```env
# Example: 25% BTC/ETH, 20% XRP, 15% others
CUSTOM_WEIGHTS={"cbBTC": 0.25, "WETH": 0.25, "cbXRP": 0.20, "cbADA": 0.15, "cbDOGE": 0.10, "AAVE": 0.05}

# Example: Conservative allocation
CUSTOM_WEIGHTS={"cbBTC": 0.40, "WETH": 0.30, "cbXRP": 0.10, "cbADA": 0.10, "cbDOGE": 0.05, "AAVE": 0.05}
```

**Note**: Weights must add up to 1.0 (100%)

## Usage

Run the bot:
```bash
node rebalance-bot.js
```

The bot will:
1. Check current portfolio allocation
2. Compare against target weights (default: equal 16.67% each, or custom weights)
3. Execute trades if any token deviates >3% from target (configurable)
4. Send Telegram notifications (if configured)
5. Wait 4 hours and repeat (configurable)

## Telegram Commands

If Telegram is configured, use these commands:

- `/status` - Current portfolio status and allocations
- `/hodl` - Detailed HODL vs rebalancing comparison
- `/portfolio` - Portfolio overview with HODL performance
- `/reset_hodl` - Reset HODL baseline to current balances
- `/debug` - Bot configuration and authorization info

## How It Works

### Rebalancing Strategy
1. **Monitor**: Checks portfolio every 4 hours
2. **Analyze**: Calculates current vs target allocations
3. **Trade**: If deviation >5%, executes rebalancing trades
4. **Track**: Compares performance vs HODL strategy

### Trading Logic
1. **Sell Phase**: Sells overweight tokens → WETH
2. **Buy Phase**: Uses WETH to buy underweight tokens
3. **Base Token**: WETH serves as the trading pair for all swaps

### Example Rebalancing
```
Target: 20% BTC, 20% ETH, 15% others (custom weights)

Before:
- WETH: 13.8% (underweight by 6.2% - exceeds 3% threshold)
- cbDOGE: 16.7% (overweight by 1.7%)
- cbADA: 16.5% (overweight by 1.5%)
- cbXRP: 16.4% (overweight by 1.4%)
- AAVE: 16.6% (overweight by 1.6%)

Action:
- Sell 19.95 cbDOGE → 0.001048 WETH ($4.60)
- Sell 5.31 cbADA → 0.000958 WETH ($4.21)
- Sell 1.24 cbXRP → 0.000900 WETH ($3.95)
- Sell 0.014 AAVE → 0.000978 WETH ($4.29)

After:
- WETH: ~20% (rebalanced to target)
- All others: closer to 15% targets
```

## Performance Tracking

The bot tracks:
- **Current Portfolio Value**: Real-time portfolio worth
- **HODL Comparison**: What the portfolio would be worth if never rebalanced
- **Rebalancing Performance**: Gain/loss from rebalancing strategy
- **Trade History**: All executed rebalancing trades

## Risk Management

- **Deviation Threshold**: Only trades when significantly out of balance
- **Minimum Trade Size**: Avoids tiny, inefficient trades
- **Slippage Protection**: Accepts 2% slippage for fast execution
- **Error Handling**: Continues operation even if individual trades fail

## Files Structure

- `rebalance-bot.js` - Main bot logic
- `config.js` - Network and token configurations
- `rebalance-data.json` - Persistent data storage
- `rebalance.log` - Trading and error logs

## Security Notes

- Store private keys securely (use environment variables)
- Test with small amounts first
- Monitor bot performance regularly
- Keep sufficient ETH for gas fees

## Contributors

### Lead Developer
**[@martagonz](https://github.com/martagonz)** - Original creator and lead developer

- 🏗️ **Architecture & Design**: Built the entire rebalancing system from scratch
- 🤖 **Smart Logic**: Implemented custom weight allocation and intelligent WETH handling
- 📊 **Performance Tracking**: Created HODL comparison and analytics system
- 🔗 **Integrations**: CoW Protocol, Telegram Bot, and Binance API implementations
- 🛡️ **Security**: MEV protection and comprehensive error handling
- 📱 **User Experience**: Real-time notifications and status commands

*Built with expertise in DeFi protocols, automated trading systems, and blockchain development.*

---

## Disclaimer

This bot is for educational purposes. Cryptocurrency trading involves risk. Always:
- Test thoroughly before using real funds
- Understand the code before running
- Monitor bot performance
- Be prepared for potential losses

## License

MIT License - see LICENSE file for details
