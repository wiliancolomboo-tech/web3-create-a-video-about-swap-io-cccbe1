# 1. Clone repository & install dependencies
git clone https://github.com/swap-io/solana-core.git
cd solana-core
yarn install

# 2. Synchronize Program ID
anchor keys sync

# 3. Build the Anchor program binary
anchor build