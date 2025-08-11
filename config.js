// config.js - COMPLETE VERSION with validateConfig
import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  // Wallet & Network
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  BASE_RPC_URL: process.env.BASE_RPC_URL,
  
  // CoW Protocol API
  COW_API_BASE: "https://api.cow.fi/base/api/v1",
  
  // Token Addresses on Base
  TOKENS: {
    WETH: "0x4200000000000000000000000000000000000006",
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  },
  
  // BALANCED Trading Parameters
  ORDER_AMOUNT_USD: 300, // Fixed USD amount per order
  
  // Tighter Grid Settings for Better Balance
  PRICE_STEP: parseFloat(process.env.PRICE_STEP) || 25, // Smaller steps = more fills
  GRID_SPREAD: parseFloat(process.env.GRID_SPREAD) || 75, // Tighter spread
  
  // Grid Management
  MAX_ORDERS_PER_SIDE: 2, // Reduced to maintain balance
  REBALANCE_THRESHOLD: 100, // More frequent rebalancing
  MAX_GRID_AGE: 2 * 60 * 60 * 1000, // 2 hours max
  
  // More Frequent Checks
  CHECK_INTERVAL: 3 * 60 * 1000, // 3 minutes
  ORDER_VALIDITY: 24 * 60 * 60, // 24 hours validity
  
  // Balance Management
  TARGET_BALANCE_RATIO: 0.5, // 50/50 WETH/USDC target
  REBALANCE_THRESHOLD_PERCENT: 0.7, // Rebalance if >70% in one asset
  
  // Safety
  MIN_BALANCE_ETH: 0.01,
  MIN_BALANCE_USDC: 100,
  MIN_ORDER_USD: 100, // Minimum order size
  
  // Telegram (optional)
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID
};

 export function validateConfig() {
  const required = ['PRIVATE_KEY', 'BASE_RPC_URL'];
  
  for (const key of required) {
    if (!CONFIG[key]) {
      throw new Error(`Missing required config: ${key}`);
    }
  }
  
  console.log('✅ Configuration validated');
}