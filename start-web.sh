#!/bin/bash

echo "🌐 Starting Crypto Rebalance Bot Web Interface..."
echo "📍 Web interface will be available at: http://localhost:3000"
echo "⚙️ Make sure your .env file is configured before starting the bot"
echo ""

# Check if .env exists
if [ ! -f .env ]; then
    echo "⚠️  Warning: .env file not found. Copy .env.example to .env and configure it."
    echo ""
fi

# Start the web server
node web-server.js